import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { AihubError } from "./errors.js";

// ---- item definitions -------------------------------------------------------

export interface DefPart {
  path: string;
  payload: string;
  payloadType: "InlineBase64";
}

/** Every file under `dir` as a Fabric definition part (posix path relative to dir, base64 payload). */
export function readDefinitionDir(dir: string): DefPart[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new AihubError(`--definition-dir '${dir}' is not a folder`);
  const parts: DefPart[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else parts.push({ path: relative(dir, full).split(sep).join("/"), payload: readFileSync(full).toString("base64"), payloadType: "InlineBase64" });
    }
  };
  walk(dir);
  if (!parts.length) throw new AihubError(`--definition-dir '${dir}' has no files`);
  return parts;
}

/** Decode definition parts into files under `out`; a path that would leave `out` is refused. */
export function writeDefinitionParts(parts: { path: string; payload: string; payloadType?: string }[], out: string): string[] {
  const root = resolve(out);
  const written: string[] = [];
  for (const p of parts) {
    const target = resolve(root, p.path);
    if (target !== root && !target.startsWith(root + sep)) throw new AihubError(`definition part '${p.path}' points outside the output folder; refusing`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(p.payload ?? "", "base64"));
    written.push(p.path);
  }
  return written;
}

// ---- time and text helpers ----------------------------------------------------

/** `24h`, `7d`, `30m`, or an ISO timestamp, as a Date. */
export function parseSince(s: string, now = Date.now()): Date {
  const m = /^(\d+)\s*([mhdw])$/i.exec(s.trim());
  if (m) return new Date(now - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2].toLowerCase() as "m"]);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new AihubError(`--since '${s}' is not 24h, 7d, 30m or a timestamp like 2026-01-31T08:00:00Z`);
  return new Date(t);
}

/** Fabric job timestamps (startTimeUtc, endTimeUtc, start/end of activity runs) are UTC but come without a zone suffix: `Date.parse` would read them as local time (an hour off in CET). */
export function parseUtc(s: string | undefined): number {
  const v = String(s ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(v)) return Date.parse(v + "Z");
  return Date.parse(v.replace(/GMT$/, "Z"));
}

export function durationText(start?: string, end?: string): string {
  if (!start || !end) return "-";
  const s = Math.round((parseUtc(end) - parseUtc(start)) / 1000);
  if (!Number.isFinite(s) || s < 0) return "-";
  return s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

export const oneLine = (s: string | undefined, max = 140) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** First line that names an error, with the stack lines that follow it. */
export function extractStack(lines: string[], max = 15): string[] {
  const i = lines.findIndex((l) => /Traceback|Exception|Error\b|FAILED/i.test(l));
  return i < 0 ? [] : lines.slice(i, i + max);
}

export const toTable = (rows: string[][]): string => rows.map((r) => r.join(" | ")).join("\n");

// ---- logs -----------------------------------------------------------------------

export interface LogSection {
  /** Which Fabric endpoint the lines came from. */
  source: string;
  title: string;
  available: boolean;
  lines: string[];
  note?: string;
  /** A raw text log (Livy, driver stderr/stdout): digested by default, whole only with --out. */
  raw?: boolean;
}

/** Keep only the lines that contain `search` (case-insensitive) and then only the last `tail` lines. */
export function filterLines(lines: string[], o: { search?: string; tail?: number }): string[] {
  let out = lines;
  if (o.search) {
    const q = o.search.toLowerCase();
    out = out.filter((l) => l.toLowerCase().includes(q));
  }
  if (o.tail && o.tail > 0) out = out.slice(-o.tail);
  return out;
}

export function formatSections(sections: LogSection[], o: { search?: string; tail?: number }): string {
  const out: string[] = [];
  for (const s of sections) {
    const lines = filterLines(s.lines, o);
    out.push(`== ${s.title} [source: ${s.source}]${s.available ? "" : " (not available)"}`);
    if (!s.available) out.push(`   ${s.note ?? "endpoint not available"}`);
    else if (!lines.length) out.push(o.search ? `   no line matches '${o.search}'` : "   (empty)");
    else out.push(...lines.map((l) => `   ${l}`));
    if (s.available && s.note) out.push(`   note: ${s.note}`);
  }
  return out.join("\n");
}

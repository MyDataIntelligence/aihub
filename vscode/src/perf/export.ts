import { promises as fs } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { logFiles } from "./log";
import { Scrubber } from "./scrub";

/**
 * "Export…" of the performance report: one zip with the report as shown, the extension's and the CLI's day files of the
 * chosen period (only the events in it), and system.txt. Every line is scrubbed again and every absolute path outside
 * the workspace becomes <path>, so the zip can be shared as it is.
 */

export type Period = "hour" | "today" | "24h" | "7d";

export const PERIODS: { id: Period; label: string }[] = [
  { id: "hour", label: "Last hour" },
  { id: "today", label: "Today" },
  { id: "24h", label: "Last 24 hours" },
  { id: "7d", label: "Last 7 days" },
];

export function periodStart(p: Period, now: number): number {
  if (p === "hour") return now - 3_600_000;
  if (p === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return now - (p === "7d" ? 7 : 1) * 86_400_000;
}

/** Absolute Windows, UNC and POSIX-home paths that survived the scrubber (outside the workspace) become <path>. */
export function maskOutsidePaths(text: string): string {
  return text
    .replace(/(?<![A-Za-z])[A-Za-z]:(?:\\\\|\\|\/)[^\s"'|<>]*/g, "<path>")
    .replace(/\\\\\\\\[^\s"'|<>]+|\\\\[A-Za-z0-9._-]+\\[^\s"'|<>]*/g, "<path>")
    .replace(/(?<![\w.~])\/(?:Users|home|root|mnt|tmp|var)\/[^\s"'|<>]*/g, "<path>");
}

export interface SystemInfo {
  vscode: string;
  extension: string;
  cli?: string;
  node: string;
  os: string;
  vm?: string;
}

export const systemText = (s: SystemInfo) =>
  [`VS Code: ${s.vscode}`, `AI Context Hub extension: ${s.extension}`, `aihub CLI: ${s.cli ?? "unknown"}`, `Node (extension host): ${s.node}`, `OS: ${s.os}`, `Virtual machine: ${s.vm ?? "unknown"}`].join("\n") + "\n";

/** The lines of the day files that fall in [from, to], scrubbed and path-masked; per file name. */
export async function periodLogs(dir: string, from: number, to: number, scrubber: Scrubber): Promise<{ name: string; text: string }[]> {
  const days = Math.max(1, Math.ceil((to - from) / 86_400_000) + 1);
  const out: { name: string; text: string }[] = [];
  for (const f of await logFiles(dir, to, Math.min(days, 7))) {
    const lines: string[] = [];
    for (const line of (await fs.readFile(f, "utf8").catch(() => "")).split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as { t: number };
        if (e.t < from || e.t > to) continue;
        lines.push(maskOutsidePaths(JSON.stringify(scrubber.value(e))));
      } catch {
        /* a cut-off line */
      }
    }
    if (lines.length) out.push({ name: f.split(/[\\/]/).pop()!, text: lines.join("\n") + "\n" });
  }
  return out;
}

// ---- a minimal zip writer (deflate, no dependencies) ----------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(entries: { name: string; data: Buffer }[], date = new Date()): Buffer {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const comp = deflateRawSync(e.data);
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Builds the export zip. */
export async function exportZip(o: { dir: string; from: number; to: number; reportMd: string; system: SystemInfo; scrubber: Scrubber }): Promise<{ zip: Buffer; files: string[] }> {
  const logs = await periodLogs(o.dir, o.from, o.to, o.scrubber);
  const entries = [
    { name: "report.md", data: Buffer.from(maskOutsidePaths(scrubLines(o.reportMd, o.scrubber)), "utf8") },
    ...logs.map((l) => ({ name: `logs/${l.name}`, data: Buffer.from(l.text, "utf8") })),
    { name: "system.txt", data: Buffer.from(maskOutsidePaths(scrubLines(systemText(o.system), o.scrubber)), "utf8") },
  ];
  return { zip: zip(entries), files: entries.map((e) => e.name) };
}

/** The scrubber per line (it cuts a single text at 300 characters). */
const scrubLines = (text: string, s: Scrubber) => text.split("\n").map((l) => (l.length > 280 ? l.split(" | ").map((c) => s.text(c)).join(" | ") : s.text(l))).join("\n");

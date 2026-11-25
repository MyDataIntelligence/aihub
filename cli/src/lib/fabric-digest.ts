import { writeFileSync } from "node:fs";
import { classifyError, failedCell, type Cause } from "./fabric-diag.js";
import type { JobInstance } from "./fabric.js";
import { durationText, formatSections, oneLine, type LogSection } from "./fabric-ops.js";

/**
 * A job's logs as an agent needs them: the failure, the failed cell, the likely cause and a short excerpt, in a few
 * hundred bytes. A driver log is often close to a megabyte (Spark profiling, token-cache INFO lines); it never goes to
 * stdout whole: `--out <file>` writes it, `--search`/`--tail` window it.
 */

/** Default budget of a digest on stdout; the benchmark target is "well under 4 KB". */
export const DIGEST_BYTES = 3_500;
/** Budget of a `--search`/`--tail` window on stdout. */
export const WINDOW_BYTES = 16_000;
const LINE_CHARS = 300;

const FRAMING = /^(?:\*{5,}|={5,}|-{5,}|End of LogType:|LogType:|LogLastModifiedTime:|LogLength:|Log Contents:|Container: |LogAggregationType:|profiling:)/;
const QUIET_RECORD = /^(?:\[?\d{2,4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\S*\]?\s+)(?:\[[^\]]*\]\s+)?(?:TRACE|DEBUG|INFO)\b/;
const EXCEPTION_LINE = /^[A-Za-z_][\w.$]*(?:Error|Exception|Exit|Interrupt)(?::.*)?$/;

/** A line worth reading: not empty, not YARN framing, not an INFO/DEBUG record. */
export const meaningful = (l: string) => !!l.trim() && !FRAMING.test(l.trim()) && !QUIET_RECORD.test(l.trim());

/**
 * The real error of a log: the last Python traceback (up to its exception line), else the first ERROR/FATAL record or
 * bare exception line with the stack lines under it. INFO lines that merely mention "Exception" (token caches) are skipped.
 */
export function errorExcerpt(lines: string[], max = 15): string[] {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/Traceback \(most recent call last\)/.test(lines[i])) continue;
    const out: string[] = [];
    for (let k = i; k < lines.length && out.length < 60; k++) {
      if (lines[k].trim()) out.push(lines[k]);
      if (k > i && EXCEPTION_LINE.test(lines[k].trim())) break;
    }
    // keep the head (where it started) and the tail (the exception) when it is long
    return out.length > max ? [...out.slice(0, 3), "  ...", ...out.slice(-(max - 4))] : out;
  }
  const at = lines.findIndex((l) => /^(?:\S+\s+){0,3}(?:ERROR|FATAL|CRITICAL)\b/.test(l.trim()) || EXCEPTION_LINE.test(l.trim()));
  if (at < 0) return [];
  const out = [lines[at]];
  for (let k = at + 1; k < lines.length && out.length < max; k++) {
    if (/^\s+(?:at |\.\.\.|File )|^Caused by:|^\s+\^/.test(lines[k])) out.push(lines[k]);
    else break;
  }
  return out;
}

export interface Digest {
  status: string;
  failure?: string;
  cell?: { cell: number; line: number; code?: string; exception?: string };
  cause?: Cause;
  excerpt: string[];
  /** Raw log sections with their size: where the full text is. */
  logs: { title: string; lines: number }[];
  /** A failed run without a cell, exception or excerpt: why not, and what to do. */
  missing?: string;
}

const cut = (l: string) => (l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS - 1)}…` : l);

/** Keep whole lines until `bytes` is used; then one line that says what was cut and how to get it. */
export function clampLines(lines: string[], bytes: number, more: string): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const n = Buffer.byteLength(lines[i]) + 1;
    if (used + n > bytes) {
      out.push(`... ${lines.length - i} more line(s) cut; ${more}`);
      return out;
    }
    out.push(lines[i]);
    used += n;
  }
  return out;
}

/** The digest of one job run: failure, failed cell, likely cause, the error excerpt (or the last lines of the notebook output). */
export function digestJob(job: JobInstance, sections: LogSection[]): Digest {
  const logs = sections.filter((s) => s.raw && s.available);
  const all = logs.flatMap((s) => s.lines);
  const text = all.join("\n");
  const cell = failedCell(text);
  const stdout = logs.filter((s) => /stdout/.test(s.title)).flatMap((s) => s.lines);
  const stderr = logs.filter((s) => /stderr/.test(s.title)).flatMap((s) => s.lines);
  const livy = logs.filter((s) => /Livy/.test(s.title)).flatMap((s) => s.lines);
  let excerpt = errorExcerpt(stdout);
  if (!excerpt.length) excerpt = errorExcerpt(stderr);
  // the Livy log only counts when it holds a real error (its tail is YARN client chatter: "client token", "queue: root.default")
  if (!excerpt.length) excerpt = errorExcerpt(livy);
  const failure = job.failureReason ? `${job.failureReason.errorCode ?? "unknown"}: ${(job.failureReason.message ?? "no details").replace(/\s+/g, " ").trim()}` : undefined;
  const basis = `${cell?.exception ?? ""} ${excerpt.join(" ")} ${failure ?? ""}`;
  const cause = job.status === "Failed" ? classifyError(basis) : undefined;
  return {
    status: job.status,
    failure,
    cell: cell ? { cell: cell.cell, line: cell.line, code: cell.code, exception: cell.exception } : undefined,
    cause: cause && cause.kind !== "unknown" ? cause : undefined,
    excerpt: excerpt.map(cut),
    logs: logs.map((s) => ({ title: s.title, lines: s.lines.length })),
    missing: job.status === "Failed" && !cell && !excerpt.length ? noCause(sections) : undefined,
  };
}

/** One line for a failed run whose exception is nowhere in what Fabric returned. */
export function noCause(sections: LogSection[]): string {
  const driver = sections.filter((s) => s.raw && /driver/.test(s.title));
  const gone = driver.length > 0 && driver.every((s) => !s.available);
  const why = gone ? `Fabric did not return the driver log (${/HTTP \d+/.exec(driver[0].note ?? "")?.[0] ?? "not available"})` : driver.length ? "the driver log holds no exception" : "Fabric returned no Spark driver log for this run";
  return `no exception found: ${why}. Open the run in the Fabric Monitoring hub, or run it again with --wait (the log is read right after the run)`;
}

/** Text of the default `fabric logs --job` view; the non-log sections (job instance, sessions, activity runs) stay as they are, capped. */
export function formatDigest(job: JobInstance, itemLabel: string, sections: LogSection[], d: Digest, more: string): string {
  const head = [`${itemLabel}, job ${job.id}: ${job.status}${job.startTimeUtc ? ` (started ${job.startTimeUtc}${job.endTimeUtc ? `, ${durationText(job.startTimeUtc, job.endTimeUtc)}` : ""})` : ""}`];
  if (d.failure) head.push(`failure: ${d.failure}`);
  if (d.cell) head.push(`failed cell ${d.cell.cell}, line ${d.cell.line}${d.cell.code ? `: ${oneLine(d.cell.code, 200)}` : ""}${d.cell.exception ? `\n  -> ${oneLine(d.cell.exception, 400)}` : ""}`);
  if (d.cause) head.push(`likely cause: ${d.cause.kind}: ${d.cause.hint}`);
  if (d.missing) head.push(d.missing);
  if (d.excerpt.length) head.push(d.cell || /Traceback|Error|Exception/.test(d.excerpt[0]) ? "error excerpt:" : "last lines of the run:", ...d.excerpt.map((l) => `  ${l}`));
  const other = sections.filter((s) => !s.raw && s.title !== "job instance");
  const body = other.length ? formatSections(other.map((s) => ({ ...s, lines: s.lines.slice(0, 30).map(cut) })), {}).split("\n") : [];
  const logs = sections.filter((s) => s.raw);
  // the session id is in the Spark session section above already
  const tail = logs.length ? [`logs: ${logs.map((s) => `${s.title.replace(/ \(session [^)]*\)$/, "")} ${s.available ? `${s.lines.length} lines` : "not available"}`).join("; ")}`] : [];
  return clampLines([...head, ...body, ...tail, more], DIGEST_BYTES, more).join("\n");
}

/** Write every section, every line, to a file (the full log the digest leaves out). */
export function writeFullLog(file: string, header: string, sections: LogSection[]): number {
  const text = `${header}\n${formatSections(sections, {})}\n`;
  writeFileSync(file, text, "utf8");
  return Buffer.byteLength(text);
}

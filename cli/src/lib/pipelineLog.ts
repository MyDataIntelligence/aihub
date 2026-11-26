import { GENERIC_ERROR } from "./pipeline.js";

/**
 * A pipeline step log made readable for the bar: numbered lines with their time and level, the first real error,
 * foldable sections (groups and quiet stretches with a label) and links to file:line relative to the repository.
 * Pure functions: the caller downloads the log text.
 */

export type LogLevel = "error" | "warning" | "info";

export interface LogLink {
  /** Path relative to the repository root, forward slashes. */
  file: string;
  line: number;
  /** Character positions of the link in `text` (end exclusive). */
  start: number;
  end: number;
}

export interface LogLine {
  n: number;
  time: string | null;
  level: LogLevel;
  text: string;
  links: LogLink[];
}

export interface LogSection {
  kind: "group" | "noise";
  label: string;
  start: number;
  end: number;
  problems: boolean;
}

export interface FirstError {
  n: number;
  time: string | null;
  text: string;
  file?: string;
  line?: number;
}

export interface ReadableLog {
  totalLines: number;
  lines: LogLine[];
  firstError: FirstError | null;
  counts: { errors: number; warnings: number };
  sections: LogSection[];
  truncated: boolean;
}

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s?/;

/** Where an agent checks out the repository: everything up to and including this is cut from a path. */
const SOURCE_ROOTS = [
  /^.*?\/(?:_?work|__w)\/\d+\/s\//, // Linux/macOS hosted and self-hosted agents (/home/vsts/work/1/s/, /__w/1/s/)
  /^[A-Za-z]:[\\/](?:.*?[\\/])?(?:a|_work|work)[\\/]\d+[\\/]s[\\/]/, // Windows agents (D:\a\1\s\, C:\agent\_work\3\s\)
  /^\$\(Build\.SourcesDirectory\)[\\/]/,
];

/** A path:line pair that points into the repository; undefined for system or package files. */
export function repoRelative(path: string): string | undefined {
  let p = path.trim();
  for (const re of SOURCE_ROOTS) {
    if (re.test(p)) {
      p = p.replace(re, "");
      break;
    }
  }
  p = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || /^\/|^[A-Za-z]:\//.test(p)) return undefined; // still absolute: outside the checkout
  if (/(^|\/)(site-packages|dist-packages|node_modules|\.venv|venv|lib\/python\d)/.test(p)) return undefined;
  if (p.includes("..")) return undefined;
  return p;
}

const PY_FILE = /File "([^"]+)", line (\d+)/g;
// a path with a folder or an extension, then :line (and optional :column); not part of a URL
const PATH_LINE = /(?<![\w/\\.:-])((?:[A-Za-z]:[\\/]|\/|\$\(Build\.SourcesDirectory\)[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z][\w]{0,9}):(\d+)(?::\d+)?(?![\w])/g;

export function findLinks(text: string): LogLink[] {
  const out: LogLink[] = [];
  const taken = (s: number, e: number) => out.some((l) => s < l.end && e > l.start);
  for (const m of text.matchAll(PY_FILE)) {
    const file = repoRelative(m[1]);
    if (!file) continue;
    const start = m.index! + m[0].indexOf(m[1]);
    out.push({ file, line: Number(m[2]), start, end: start + m[1].length });
  }
  for (const m of text.matchAll(PATH_LINE)) {
    const start = m.index!;
    const end = start + m[1].length + 1 + m[2].length;
    if (taken(start, end)) continue;
    const before = text.slice(Math.max(0, start - 3), start);
    if (before.endsWith("://") || /https?:\/\/\S*$/.test(text.slice(0, start))) continue; // part of a URL
    const file = repoRelative(m[1]);
    if (!file || /^\d+(\.\d+)+$/.test(m[1])) continue; // a version number like 3.11.4:1
    out.push({ file, line: Number(m[2]), start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

const ERROR_LINE = [/^##\[error\]/, /^FAILED\s/, /^ERROR\s/, /^E\s+\S/, /^Error:\s/, /^fatal:\s/i];
const PATH_ERROR = /^\S+\.\w+:\d+:\s*(?:\w+\.)*\w*(?:Error|Exception)\b/; // notebooks/test_orders.py:41: AssertionError
const EXC_END = /^(?:[\w.]+\.)?\w*(?:Error|Exception|Exit|Interrupt|Failure)\b(?::|$)/; // last line of a traceback
const WARNING_LINE = [/^##\[warning\]/, /(?:^|[\s:])\w*Warning:/, /^WARNING\b/, /^warning:\s/i];

function levelOf(text: string, inTraceback: boolean): LogLevel {
  if (inTraceback || ERROR_LINE.some((re) => re.test(text)) || PATH_ERROR.test(text)) return "error";
  if (WARNING_LINE.some((re) => re.test(text))) return "warning";
  return "info";
}

/** Splits a raw log into numbered lines with time, level and links. `firstLine` numbers a log read from a later line on. */
export function parseLines(raw: string, firstLine = 1): LogLine[] {
  const rows = raw.replace(/\r\n/g, "\n").split("\n");
  if (rows.length && rows[rows.length - 1] === "") rows.pop();
  let tb = false;
  return rows.map((row, i) => {
    const m = STAMP.exec(row);
    const text = m ? row.slice(m[0].length) : row;
    if (/^Traceback \(most recent call last\):/.test(text)) tb = true;
    const level = levelOf(text, tb);
    if (tb && EXC_END.test(text)) tb = false;
    return { n: firstLine + i, time: m ? m[1] : null, level, text, links: findLinks(text) };
  });
}

const errorText = (t: string) => {
  const s = t.replace(/^##\[error\]\s*/, "");
  const failed = /^FAILED\s+\S+\s+-\s+(.*)$/.exec(s); // pytest summary: FAILED path::test - Message
  return (failed ? failed[1] : s).trim();
};

/** The first error that names a cause (not the generic "exited with code 1"), with the file:line that belongs to it. */
export function firstErrorOf(lines: LogLine[]): FirstError | null {
  const errs = lines.filter((l) => l.level === "error");
  const hit = errs.find((l) => !GENERIC_ERROR.test(l.text) && !/^Traceback \(most recent/.test(l.text) && errorText(l.text) !== "") ?? errs[0];
  if (!hit) return null;
  const out: FirstError = { n: hit.n, time: hit.time, text: errorText(hit.text) };
  // pytest names the test file in its summary line (path::test): prefer the link into that file
  const testFile = /(?:^|\s)([\w./\\-]+\.\w+)::/.exec(hit.text)?.[1]?.replace(/\\/g, "/");
  const after = errs.filter((l) => l.n >= hit.n).flatMap((l) => l.links);
  const before = errs.filter((l) => l.n < hit.n).flatMap((l) => l.links);
  const link = hit.links[0] ?? (testFile ? [...after, ...before].find((k) => k.file === testFile || k.file.endsWith(`/${testFile}`)) : undefined) ?? after[0];
  if (link) {
    out.file = link.file;
    out.line = link.line;
  }
  return out;
}

const SECTION_LABELS: [RegExp, string | ((m: RegExpExecArray) => string)][] = [
  [/^##\[section\]Starting: (.+)$/, (m) => m[1].toLowerCase()],
  [/^collected (\d+) items?/, (m) => `running ${m[1]} tests`],
  [/^=+ short test summary info =+$/, "short test summary"],
  [/\[\s*\d+%\]\s*$/, "test progress"],
  [/^(Collecting|Downloading|Installing collected|Requirement already|Successfully installed)\b/, "install requirements"],
  [/^=+ (FAILURES|ERRORS) =+$/, "failures"],
];

function labelOf(lines: LogLine[]): string {
  const out: string[] = [];
  for (const l of lines) {
    for (const [re, lab] of SECTION_LABELS) {
      const m = re.exec(l.text);
      if (!m) continue;
      const s = typeof lab === "string" ? lab : lab(m);
      if (!out.includes(s)) out.push(s);
      break;
    }
    if (out.length >= 3) break;
  }
  return out.join(", ");
}

/** Groups (##[group] .. ##[endgroup]) and quiet stretches (two or more info lines in a row), each with a label. */
export function sectionsOf(lines: LogLine[]): LogSection[] {
  const out: LogSection[] = [];
  const open: { label: string; start: number; idx: number }[] = [];
  lines.forEach((l, i) => {
    const g = /^##\[group\](.*)$/.exec(l.text);
    if (g) open.push({ label: g[1].trim(), start: l.n, idx: i });
    else if (/^##\[endgroup\]/.test(l.text) && open.length) {
      const o = open.pop()!;
      const body = lines.slice(o.idx, i + 1);
      out.push({ kind: "group", label: o.label, start: o.start, end: l.n, problems: body.some((x) => x.level !== "info") });
    }
  });
  let run: LogLine[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ kind: "noise", label: labelOf(run), start: run[0].n, end: run[run.length - 1].n, problems: false });
    run = [];
  };
  for (const l of lines) {
    if (l.level === "info") run.push(l);
    else flush();
  }
  flush();
  return out.sort((a, b) => a.start - b.start || (a.kind === "group" ? -1 : 1));
}

/** The readable log: all facts over the whole text, lines and sections cut to the last `tail` lines. */
export function readableLog(raw: string, o: { tail?: number; firstLine?: number } = {}): ReadableLog {
  const all = parseLines(raw, o.firstLine ?? 1);
  const tail = o.tail ?? 2000;
  const lines = all.length > tail ? all.slice(-tail) : all;
  const from = lines.length ? lines[0].n : 0;
  return {
    totalLines: all.length ? all[all.length - 1].n : 0,
    lines,
    firstError: firstErrorOf(all),
    counts: { errors: all.filter((l) => l.level === "error").length, warnings: all.filter((l) => l.level === "warning").length },
    sections: sectionsOf(all).filter((s) => s.end >= from).map((s) => (s.start < from ? { ...s, start: from } : s)),
    truncated: lines.length < all.length,
  };
}

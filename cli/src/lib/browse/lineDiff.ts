/**
 * Line diffs for the browser: hunks of one file between two versions (history, Diff before saving, a conflict), and the
 * three-way check of "Rebase my change": my change re-applied on the newest version when the lines do not overlap.
 * Pure functions, no git.
 */

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
  old: number | null;
  new: number | null;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** One change: base lines [start, end) are replaced by `lines` (0-based; start == end is an insert). */
export interface Edit {
  start: number;
  end: number;
  lines: string[];
}

export const splitLines = (s: string): string[] => {
  if (s === "") return [];
  const parts = s.replace(/\r\n/g, "\n").split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
};

/** The edits that turn `a` into `b` (Myers, O((N+M)D); falls back to one big edit past a size cap). */
export function edits(a: string[], b: string[]): Edit[] {
  // trim the common head and tail: most file changes are small
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  if (!A.length && !B.length) return [];
  if (!A.length || !B.length || A.length * B.length > 25_000_000) return [{ start: pre, end: pre + A.length, lines: B }];
  const ops = myers(A, B); // "=" | "-" | "+"
  const out: Edit[] = [];
  let i = 0;
  let j = 0;
  let cur: Edit | undefined;
  for (const op of ops) {
    if (op === "=") {
      if (cur) out.push(cur), (cur = undefined);
      i++, j++;
    } else if (op === "-") {
      cur ??= { start: pre + i, end: pre + i, lines: [] };
      cur.end = pre + i + 1;
      i++;
    } else {
      cur ??= { start: pre + i, end: pre + i, lines: [] };
      cur.lines.push(B[j]);
      j++;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function myers(a: string[], b: string[]): ("=" | "-" | "+")[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) x++, y++;
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, off);
    }
  }
  return [];
}

function backtrack(trace: Int32Array[], a: string[], b: string[], dEnd: number, off: number): ("=" | "-" | "+")[] {
  const ops: ("=" | "-" | "+")[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const px = v[off + prevK];
    const py = px - prevK;
    while (x > px && y > py) ops.push("="), x--, y--;
    if (x === px) ops.push("+"), y--;
    else ops.push("-"), x--;
  }
  while (x > 0 && y > 0) ops.push("="), x--, y--;
  return ops.reverse();
}

/** Unified hunks with `context` lines around each change; line numbers are 1-based. */
export function hunks(before: string, after: string, context = 3): Hunk[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const es = edits(a, b);
  if (!es.length) return [];
  // group edits whose context touches
  const groups: Edit[][] = [];
  for (const e of es) {
    const g = groups[groups.length - 1];
    if (g && e.start - g[g.length - 1].end <= 2 * context) g.push(e);
    else groups.push([e]);
  }
  const out: Hunk[] = [];
  let delta = 0; // new index - old index before the current group
  for (const g of groups) {
    const from = Math.max(0, g[0].start - context);
    const to = Math.min(a.length, g[g.length - 1].end + context);
    const lines: DiffLine[] = [];
    let i = from;
    let nNew = from + delta;
    for (const e of g) {
      for (; i < e.start; i++) lines.push({ kind: "ctx", text: a[i], old: i + 1, new: ++nNew });
      for (let k = e.start; k < e.end; k++) lines.push({ kind: "del", text: a[k], old: k + 1, new: null });
      for (const t of e.lines) lines.push({ kind: "add", text: t, old: null, new: ++nNew });
      i = e.end;
    }
    for (; i < to; i++) lines.push({ kind: "ctx", text: a[i], old: i + 1, new: ++nNew });
    const oldLines = lines.filter((l) => l.kind !== "add").length;
    const newLines = lines.filter((l) => l.kind !== "del").length;
    out.push({ oldStart: oldLines ? from + 1 : from, oldLines, newStart: newLines ? from + delta + 1 : from + delta, newLines, lines });
    for (const e of g) delta += e.lines.length - (e.end - e.start);
  }
  return out;
}

/** True when two edits of the same base touch the same or adjacent lines (git's rule: neighbouring changes conflict too). */
const overlaps = (x: Edit, y: Edit) => x.start <= y.end && y.start <= x.end;

export interface Merge3 {
  overlap: boolean;
  /** theirs with my edits applied (when no overlap) */
  merged?: string;
}

/**
 * Re-apply my change (base -> mine) on the newest version (base -> theirs). No overlap: the merged text. Overlap: the caller
 * shows both changes and pushes nothing.
 */
export function merge3(base: string, mine: string, theirs: string): Merge3 {
  const b = splitLines(base);
  const mE = edits(b, splitLines(mine));
  const tE = edits(b, splitLines(theirs));
  if (mE.some((m) => tE.some((t) => overlaps(m, t)))) return { overlap: true };
  const all = [...mE, ...tE].sort((x, y) => x.start - y.start || x.end - y.end);
  const out: string[] = [];
  let i = 0;
  for (const e of all) {
    for (; i < e.start; i++) out.push(b[i]);
    out.push(...e.lines);
    i = Math.max(i, e.end);
  }
  for (; i < b.length; i++) out.push(b[i]);
  const eol = /\r\n/.test(theirs) ? "\r\n" : "\n";
  const endsWithEol = theirs === "" ? mine.endsWith("\n") : /\n$/.test(theirs);
  return { overlap: false, merged: out.join(eol) + (out.length && endsWithEol ? eol : "") };
}

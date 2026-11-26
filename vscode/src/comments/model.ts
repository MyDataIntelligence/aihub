/**
 * Pull request review comments in the editor: what `aihub comments threads --json` says, where each thread goes in the
 * file as it is now (in memory, no git), what is new since the user last looked, and what the title bar is told. No vscode here.
 */

export interface PrComment {
  id: number;
  parentId?: number;
  author: string;
  authorId?: string;
  when?: string;
  text: string;
}

export interface PrSuggestion {
  commentId: number;
  old: string[];
  new: string[];
}

export interface PrThread {
  threadId: number;
  status: string;
  open: boolean;
  file?: string;
  renamedFrom?: string;
  side?: "right" | "left";
  line?: number;
  endLine?: number;
  outdated: boolean;
  fileDeleted?: boolean;
  original?: string[];
  anchor?: { start: number; lines: string[] };
  comments: PrComment[];
  suggestions: PrSuggestion[];
}

export interface PrThreads {
  repo: string;
  pr: number;
  threads: PrThread[];
}

export interface ThreadsRead {
  me?: { id: string; name: string };
  prs: PrThreads[];
  failed: { repo: string; pr: number; error: string }[];
}

/** The pull request of one repository whose threads are read: its name in Azure DevOps and its worktree. */
export interface Target {
  /** empty: the repository of the worktree (filled in from the first read) */
  repo: string;
  path: string;
  pr: number;
  url?: string;
}

export function parseThreadsRead(text: string): ThreadsRead {
  const j = JSON.parse(text.slice(text.indexOf("{"))) as Partial<ThreadsRead>;
  return { me: j.me, prs: Array.isArray(j.prs) ? j.prs : [], failed: Array.isArray(j.failed) ? j.failed : [] };
}

/** The `--pr` arguments of one read for all targets. */
export const threadsArgs = (targets: Target[]): string[] => ["comments", "threads", ...targets.flatMap((t) => ["--pr", t.repo ? `${t.repo}:${t.pr}` : String(t.pr)]), "--json"];

/** "/notebooks/orders.py" -> "notebooks/orders.py" */
export const repoRel = (file: string): string => file.replace(/^[\\/]+/, "").replace(/\\/g, "/");

// ---- where a thread goes in the file as it is now -------------------------------------------------------------

export interface Placement {
  /** 0-based line of the thread */
  line: number;
  /** the commented lines are not in the file as they were: show "Outdated" with the original lines */
  outdated: boolean;
  /** no place found: at the top of the file */
  top: boolean;
}

const norm = (s: string) => s.replace(/\s+$/, "");
const matchAt = (doc: string[], at: number, lines: string[]) => at >= 0 && at + lines.length <= doc.length && lines.every((l, i) => norm(doc[at + i]) === norm(l));
function nearest(doc: string[], lines: string[], want: number): number | undefined {
  if (!lines.length) return undefined;
  let best: number | undefined;
  for (let i = 0; i + lines.length <= doc.length; i++) if (matchAt(doc, i, lines) && (best === undefined || Math.abs(i - want) < Math.abs(best - want))) best = i;
  return best;
}

/**
 * Places a thread against the lines of the open document. The anchor holds the commented lines of the latest iteration
 * with up to two lines around them: found as they were (nearest to the old line) means the thread follows local edits
 * above or below it; only the lines around found means the commented lines were changed here (outdated, at that place);
 * nothing found means the top of the file. A comment on a removed line or a deleted file always goes to the top.
 */
export function placeThread(t: PrThread, doc: string[]): Placement | undefined {
  if (!t.file) return undefined;
  if (t.side === "left" || t.fileDeleted || !t.line || !t.anchor) return { line: 0, outdated: true, top: true };
  const want = t.line - 1;
  const from = t.line - t.anchor.start;
  const to = (t.endLine ?? t.line) - t.anchor.start + 1;
  const commented = t.anchor.lines.slice(from, to);
  const before = t.anchor.lines.slice(0, from);
  const after = t.anchor.lines.slice(to);
  // the commented lines with what is around them first (two equal lines in one file), then the lines alone
  const full = nearest(doc, t.anchor.lines, want - from);
  if (full !== undefined) return { line: full + from, outdated: t.outdated, top: false };
  const alone = nearest(doc, commented, want);
  if (alone !== undefined && commented.some((l) => l.trim())) return { line: alone, outdated: t.outdated, top: false };
  const b = before.some((l) => l.trim()) ? nearest(doc, before, want - before.length) : undefined;
  if (b !== undefined) return { line: Math.min(doc.length - 1, b + before.length), outdated: true, top: false };
  const a = after.some((l) => l.trim()) ? nearest(doc, after, want + commented.length) : undefined;
  if (a !== undefined) return { line: Math.max(0, a - 1), outdated: true, top: false };
  return { line: 0, outdated: true, top: true };
}

/** The range a suggestion replaces (0-based, end exclusive), or why it cannot be applied. */
export function suggestionRange(doc: string[], at: number, s: PrSuggestion): { start: number; end: number } | { error: string } {
  if (!s.old.length) return { start: at, end: at };
  if (matchAt(doc, at, s.old)) return { start: at, end: at + s.old.length };
  const near = nearest(doc, s.old, at);
  if (near !== undefined && Math.abs(near - at) <= 3) return { start: near, end: near + s.old.length };
  return { error: "The code changed since this suggestion; apply it by hand." };
}

// ---- what is new -----------------------------------------------------------------------------------------------

/** The last comment id the user has seen per thread ("repo#pr#thread"), and the pull requests that were read before. */
export interface Seen {
  threads: Record<string, number>;
  prs: Record<string, true>;
  /** the last comment id that was told in a notification per thread: a reload or a second window does not tell it again */
  told?: Record<string, number>;
}

export const threadKey = (repo: string, pr: number, threadId: number) => `${repo.toLowerCase()}#${pr}#${threadId}`;
const prKey = (repo: string, pr: number) => `${repo.toLowerCase()}#${pr}`;

const lastOther = (t: PrThread, me?: string): number => t.comments.reduce((m, c) => (c.authorId && c.authorId === me ? m : Math.max(m, c.id)), 0);

/** A thread is unread when someone else wrote a comment after the last one the user saw. Own comments never count. */
export function isUnread(seen: Seen, repo: string, pr: number, t: PrThread, me?: string): boolean {
  const last = lastOther(t, me);
  return last > 0 && last > (seen.threads[threadKey(repo, pr, t.threadId)] ?? 0);
}

export interface NewComment {
  repo: string;
  pr: number;
  threadId: number;
  file?: string;
  line?: number;
  author: string;
  firstLine: string;
}

/**
 * After a read: the comments that are new since the last read (to tell once), and the seen-store as it is now. A pull
 * request read for the first time is taken as seen: opening a set never floods the user with old comments.
 */
export function newSince(seen: Seen, read: ThreadsRead): { fresh: NewComment[]; seen: Seen } {
  const next: Seen = { threads: { ...seen.threads }, prs: { ...seen.prs }, told: { ...seen.told } };
  const told = next.told!;
  const fresh: NewComment[] = [];
  const me = read.me?.id;
  for (const p of read.prs) {
    const first = !seen.prs[prKey(p.repo, p.pr)];
    next.prs[prKey(p.repo, p.pr)] = true;
    for (const t of p.threads) {
      const key = threadKey(p.repo, p.pr, t.threadId);
      if (first) {
        next.threads[key] = Math.max(next.threads[key] ?? 0, lastOther(t, me));
        continue;
      }
      const last = lastOther(t, me);
      if (!t.open || !isUnread(next, p.repo, p.pr, t, me) || (told[key] ?? 0) >= last) continue;
      told[key] = last;
      const c = [...t.comments].reverse().find((x) => !(x.authorId && x.authorId === me))!;
      fresh.push({ repo: p.repo, pr: p.pr, threadId: t.threadId, file: t.file && repoRel(t.file), line: t.line, author: c.author, firstLine: firstSentence(c.text) });
    }
  }
  return { fresh, seen: next };
}

export function markSeen(seen: Seen, repo: string, pr: number, t: PrThread): Seen {
  const last = t.comments.reduce((m, c) => Math.max(m, c.id), 0);
  return { ...seen, threads: { ...seen.threads, [threadKey(repo, pr, t.threadId)]: last } };
}

/** The first sentence of a comment, without code blocks or markdown marks, at most 120 characters. */
export function firstSentence(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_>#]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const m = /^(.+?[.?!])(\s|$)/.exec(plain);
  const s = m ? m[1] : plain;
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

/** One notification for all new comments: its message and its second line. */
export function notice(fresh: NewComment[]): { message: string; detail?: string } | undefined {
  if (!fresh.length) return undefined;
  if (fresh.length === 1) {
    const f = fresh[0];
    const where = f.file ? ` · ${f.file}${f.line ? `:${f.line}` : ""}` : "";
    return { message: `New comment on pull request ${f.pr}${where}`, detail: `${f.author}: “${f.firstLine}”` };
  }
  const prs = [...new Set(fresh.map((f) => f.pr))];
  return { message: `${fresh.length} new comments on pull request${prs.length > 1 ? "s" : ""} ${prs.join(", ")}` };
}

// ---- what the Explorer and the title bar are told --------------------------------------------------------------

/**
 * Open threads per file and folder of each worktree, up to the worktree folder itself (absolute paths with "/", lower
 * case on Windows so a lookup by a VS Code URI matches). Resolved threads and general comments count for no file.
 */
export function fileCounts(targets: Target[], read: ThreadsRead, seen: Seen, key: (p: string) => string): Map<string, { open: number; unread: number; pr: number }> {
  const out = new Map<string, { open: number; unread: number; pr: number }>();
  for (const p of read.prs) {
    const tg = targets.find((t) => t.repo.toLowerCase() === p.repo.toLowerCase() && t.pr === p.pr);
    if (!tg) continue;
    const root = tg.path.replace(/\\/g, "/").replace(/\/+$/, "");
    for (const t of p.threads) {
      if (!t.open || !t.file) continue;
      const unread = isUnread(seen, p.repo, p.pr, t, read.me?.id) ? 1 : 0;
      const parts = repoRel(t.file).split("/");
      for (let i = parts.length; i >= 0; i--) {
        const k = key(i ? `${root}/${parts.slice(0, i).join("/")}` : root);
        const c = out.get(k) ?? { open: 0, unread: 0, pr: p.pr };
        out.set(k, { open: c.open + 1, unread: c.unread + unread, pr: p.pr });
      }
    }
  }
  return out;
}

/** A badge is at most two characters. */
export const badgeOf = (n: number): string => (n > 99 ? "99" : String(n));

export interface OpenComment {
  repo: string;
  pr: number;
  file?: string;
  line?: number;
  author: string;
  firstLine: string;
  /** ISO time of the newest comment */
  when?: string;
  unread: boolean;
  threadId: number;
}

export const OPEN_COMMENTS_MAX = 50;

/** The open threads of all pull requests for the overview, newest first, at most OPEN_COMMENTS_MAX. */
export function openComments(read: ThreadsRead, seen: Seen): OpenComment[] {
  const out: OpenComment[] = [];
  for (const p of read.prs)
    for (const t of p.threads) {
      if (!t.open || !t.comments.length) continue;
      const when = t.comments.reduce<string | undefined>((m, c) => (c.when && (!m || c.when > m) ? c.when : m), undefined);
      out.push({ repo: p.repo, pr: p.pr, ...(t.file ? { file: repoRel(t.file) } : {}), ...(t.line ? { line: t.line } : {}), author: t.comments[0].author, firstLine: firstSentence(t.comments[0].text), when, unread: isUnread(seen, p.repo, p.pr, t, read.me?.id), threadId: t.threadId });
    }
  return out.sort((a, b) => (b.when ?? "").localeCompare(a.when ?? "")).slice(0, OPEN_COMMENTS_MAX);
}

/** Per pull request: open threads and unread ones (for repos[].pr.comments). */
export function prCounts(read: ThreadsRead, seen: Seen, repo: string, pr: number): { open: number; unread: number } | undefined {
  const p = read.prs.find((x) => x.repo.toLowerCase() === repo.toLowerCase() && x.pr === pr);
  if (!p) return undefined;
  const open = p.threads.filter((t) => t.open);
  return { open: open.length, unread: open.filter((t) => isUnread(seen, p.repo, p.pr, t, read.me?.id)).length };
}

// ---- how a thread reads in the editor ---------------------------------------------------------------------------

const fence = (lines: string[], sign: string) => lines.map((l) => `${sign} ${l}`).join("\n");

/** The markdown of one comment: a suggestion block becomes a diff of the commented lines and the suggested ones. */
export function commentMarkdown(text: string, old: string[]): string {
  return text.replace(/```suggestion[^\n]*\n([\s\S]*?)```/g, (_m, body: string) => {
    const lines = body.replace(/\r\n/g, "\n").replace(/\n$/, "");
    const neu = lines === "" ? [] : lines.split("\n");
    // a blank line first: the heading is a paragraph of its own, not the end of the sentence before it
    return `\n\n**Suggested change**\n\`\`\`diff\n${[fence(old, "-"), fence(neu, "+")].filter(Boolean).join("\n")}\n\`\`\``;
  });
}

/** The lines above the first comment of an outdated thread: what was commented, and what is there now. */
export function outdatedMarkdown(original: string[] | undefined, now: string[] | undefined, side?: "left" | "right"): string {
  const head = side === "left" ? "On a line this pull request removes." : "Outdated · the code changed since this comment.";
  if (!original?.length) return `_${head}_`;
  const diff = [fence(original, "-"), now?.length ? fence(now, "+") : ""].filter(Boolean).join("\n");
  return `_${head}_ Original code when commented${now?.length ? ", now replaced" : ""}:\n\`\`\`diff\n${diff}\n\`\`\``;
}

export function statusLabel(t: PrThread, outdated: boolean): string {
  if (!t.open) return t.status === "wontFix" ? "Won't fix" : t.status === "closed" ? "Closed" : "Resolved";
  return outdated ? "Outdated" : "Active";
}

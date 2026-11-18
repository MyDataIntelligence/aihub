/** Review threads of a pull request (aihub comments get --json) and what the extension says back (aihub comments reply --reply). No vscode here. */

export interface ThreadComment {
  id: number;
  author: string;
  text: string;
}

export interface Thread {
  threadId: number;
  status: string;
  file?: string;
  line?: number;
  comments: ThreadComment[];
}

export type ReplyStatus = "fixed" | "wontFix" | "closed" | "active";

const OPEN = new Set(["active", "pending", ""]);
export const isOpen = (t: Thread) => OPEN.has(t.status);

export function parseThreads(json: unknown): { pr: number; threads: Thread[] } {
  const j = (json ?? {}) as { pr?: number; threads?: unknown };
  const list = Array.isArray(j.threads) ? j.threads : [];
  const threads: Thread[] = [];
  for (const t of list as Partial<Thread>[]) {
    if (!t || typeof t.threadId !== "number") continue;
    threads.push({
      threadId: t.threadId,
      status: String(t.status ?? ""),
      file: typeof t.file === "string" ? t.file : undefined,
      line: typeof t.line === "number" ? t.line : undefined,
      comments: (Array.isArray(t.comments) ? t.comments : []).map((c) => ({ id: Number(c.id), author: String(c.author ?? ""), text: String(c.text ?? "") })),
    });
  }
  return { pr: Number(j.pr ?? 0), threads };
}

/** The argument of `aihub comments reply --reply`: "<threadId>:<status>:<text>"; the status or the text may be empty, not both. */
export function replyArg(threadId: number, status: ReplyStatus | "", text: string): string {
  const t = text.replace(/\r?\n/g, " ").trim();
  if (!status && !t) throw new Error("A reply needs text or a status.");
  return `${threadId}:${status}:${t}`;
}

/** The command line (after `aihub`) that posts one reply. */
export function replyArgs(pr: number, threadId: number, status: ReplyStatus | "", text: string): string[] {
  return ["comments", "reply", "--pr", String(pr), "--reply", replyArg(threadId, status, text)];
}

/** Repo-relative path of a file in a thread ("/orders/a.py" -> "orders/a.py"). */
export const repoPath = (file: string) => file.replace(/^[\\/]+/, "").replace(/\\/g, "/");

/** The chat prompt for "fix in chat": the thread with its comments, naming the skill and the one reply command. */
export function fixPrompt(pr: number, t: Thread): string {
  const where = t.file ? `${repoPath(t.file)}${t.line ? `:${t.line}` : ""}` : "the pull request";
  const said = t.comments.map((c) => `${c.author}: ${c.text.replace(/\s+/g, " ").trim()}`).join(" | ");
  return `Use the review-process skill for review thread ${t.threadId} of PR !${pr} on ${where}. The reviewer wrote: ${said}. Fix it, then reply with aihub comments reply --pr ${pr} --reply "${t.threadId}:fixed:<what you changed>".`;
}

export function threadLabel(t: Thread): string {
  const first = t.comments[0];
  return first ? `${first.author}` : `Thread ${t.threadId}`;
}

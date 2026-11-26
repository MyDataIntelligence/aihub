import { parse } from "yaml";
import { type AdoClient } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { resolvePr } from "./pr.js";
import { editorThreads } from "./prThreads.js";
import { readUtf8 } from "./team.js";

interface RawComment {
  id: number;
  content?: string;
  commentType?: string;
  isDeleted?: boolean;
  author?: { displayName?: string };
}
interface RawThread {
  id: number;
  status?: string;
  isDeleted?: boolean;
  comments?: RawComment[];
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line: number };
    rightFileEnd?: { line: number };
    leftFileStart?: { line: number };
  };
}

export interface ThreadView {
  threadId: number;
  status: string;
  file?: string;
  line?: number;
  code?: { n: number; text: string }[];
  comments: { id: number; author: string; text: string }[];
}

const OPEN = new Set(["active", "pending", ""]);
export const REPLY_STATUSES = ["fixed", "wontFix", "closed", "active"] as const;
const CONTEXT = 2;

export async function getThreads(
  client: AdoClient,
  prId: number,
  sourceCommit: string | undefined,
  includeResolved: boolean,
): Promise<ThreadView[]> {
  const threads = await client.list<RawThread>(`${client.repoPath()}/pullrequests/${prId}/threads`);
  const files = new Map<string, string[] | undefined>();
  const out: ThreadView[] = [];
  for (const t of threads) {
    if (t.isDeleted) continue;
    const comments = (t.comments ?? []).filter((c) => !c.isDeleted && (c.commentType ?? "text") !== "system");
    if (!comments.length) continue;
    const status = t.status ?? "active";
    if (!includeResolved && !OPEN.has(status)) continue;
    const file = t.threadContext?.filePath;
    const line = t.threadContext?.rightFileStart?.line;
    let code: ThreadView["code"];
    if (file && line && sourceCommit) {
      if (!files.has(file)) files.set(file, await fetchLines(client, file, sourceCommit));
      const lines = files.get(file);
      if (lines) {
        const end = t.threadContext?.rightFileEnd?.line ?? line;
        code = [];
        for (let n = Math.max(1, line - CONTEXT); n <= Math.min(lines.length, end + CONTEXT); n++) code.push({ n, text: lines[n - 1] });
      }
    }
    out.push({
      threadId: t.id,
      status,
      file,
      line,
      code,
      comments: comments.map((c) => ({ id: c.id, author: c.author?.displayName ?? "?", text: (c.content ?? "").trim() })),
    });
  }
  return out;
}

async function fetchLines(client: AdoClient, path: string, commit: string): Promise<string[] | undefined> {
  try {
    const text = await client.getText(`${client.repoPath()}/items`, {
      path,
      "versionDescriptor.version": commit,
      "versionDescriptor.versionType": "commit",
      $format: "text",
    });
    return text.replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
  } catch {
    return undefined;
  }
}

export function formatThreads(prId: number, threads: ThreadView[]): string {
  if (!threads.length) return `!${prId}: no open comment threads`;
  const lines = [`!${prId}: ${threads.length} thread${threads.length === 1 ? "" : "s"}`];
  for (const t of threads) {
    const where = t.file ? `${t.file}${t.line ? `:${t.line}` : ""}` : "(general)";
    const [first, ...rest] = t.comments;
    lines.push(`[${t.threadId}] ${where} (${t.status}) ${first.author}: ${oneLine(first.text)}`);
    if (t.code) for (const c of t.code) lines.push(`  ${c.n === t.line ? ">" : " "} ${String(c.n).padStart(4)} ${c.text}`);
    for (const r of rest) lines.push(`    - ${r.author}: ${oneLine(r.text)}`);
  }
  return lines.join("\n");
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " / ");

export async function commentsGet(ctx: Ctx, o: { pr?: string; includeResolved?: boolean; json?: boolean }): Promise<string> {
  const { root, client } = repoClient(ctx);
  const pr = await resolvePr(ctx, client, root, o.pr);
  const threads = await getThreads(client, pr.pullRequestId, pr.lastMergeSourceCommit?.commitId, !!o.includeResolved);
  return o.json ? JSON.stringify({ pr: pr.pullRequestId, threads }) : formatThreads(pr.pullRequestId, threads);
}

export interface Reply {
  threadId: number;
  text?: string;
  status?: (typeof REPLY_STATUSES)[number];
}

export function parseReplies(yamlText: string): Reply[] {
  const doc = parse(yamlText) as unknown;
  const list = Array.isArray(doc) ? doc : (doc as { replies?: unknown })?.replies;
  if (!Array.isArray(list)) throw new AihubError("replies file must be a yaml list of {threadId, text, status}");
  return list.map((r0: Record<string, unknown>, i) => {
    let r = r0;
    // an agent often writes {thread, resolve: true}: take that as {threadId, status: fixed}; anything else unknown is an error
    const known = new Set(["threadId", "thread", "text", "status", "resolve"]);
    const stray = Object.keys(r ?? {}).filter((k) => !known.has(k));
    if (stray.length) throw new AihubError(`replies[${i}]: unknown key '${stray[0]}'; use threadId, text and status (fixed|wontFix|closed|active)`);
    if (r.status === undefined && (r.resolve === true || r.resolve === "true")) r = { ...r, status: "fixed" };
    if (r.threadId === undefined && r.thread !== undefined) r = { ...r, threadId: r.thread };
    const threadId = Number(r.threadId);
    if (!Number.isInteger(threadId) || threadId <= 0) throw new AihubError(`replies[${i}]: threadId is missing or not a number`);
    const status = r.status === undefined || r.status === null ? undefined : String(r.status);
    if (status && !(REPLY_STATUSES as readonly string[]).includes(status)) {
      throw new AihubError(`replies[${i}]: status '${status}' must be one of ${REPLY_STATUSES.join("|")}`);
    }
    const text = r.text === undefined || r.text === null ? undefined : String(r.text).trim();
    if (!text && !status) throw new AihubError(`replies[${i}]: needs text and/or status`);
    return { threadId, text: text || undefined, status: status as Reply["status"] };
  });
}

/** Inline replies: "<threadId>:<status>:<text>" (text may contain colons; status is fixed|wontFix|closed|active, or empty to only reply). */
export function parseInlineReply(s: string, i = 0): Reply {
  const m = /^(\d+):([A-Za-z]*):([\s\S]*)$/.exec(s.trim());
  if (!m) throw new AihubError(`--reply ${i + 1}: use "<threadId>:<status>:<text>", for example --reply "7:fixed:Aangepast: null-check toegevoegd."`);
  const status = m[2] || undefined;
  if (status && !(REPLY_STATUSES as readonly string[]).includes(status)) throw new AihubError(`--reply ${i + 1}: status '${status}' must be one of ${REPLY_STATUSES.join("|")}`);
  const text = m[3].trim();
  if (!text && !status) throw new AihubError(`--reply ${i + 1}: needs text and/or status`);
  return { threadId: Number(m[1]), text: text || undefined, status: status as Reply["status"] };
}

export async function commentsReply(ctx: Ctx, o: { pr?: string; repliesFile?: string; replies?: string[]; json?: boolean; returnThreads?: boolean }): Promise<string> {
  const replies = [...(o.repliesFile ? parseReplies(readUtf8(o.repliesFile)) : []), ...(o.replies ?? []).map(parseInlineReply)];
  if (!replies.length) throw new AihubError("aihub comments reply needs --replies-file <file.yaml> or one or more --reply \"<threadId>:<status>:<text>\"");
  const { root, client } = repoClient(ctx);
  const pr = await resolvePr(ctx, client, root, o.pr);
  const base = `${client.repoPath()}/pullrequests/${pr.pullRequestId}/threads`;
  const done: string[] = [];
  for (const r of replies) {
    if (r.text) await client.post(`${base}/${r.threadId}/comments`, { content: r.text, parentCommentId: 1, commentType: "text" });
    if (r.status) await client.patch(`${base}/${r.threadId}`, { status: r.status });
    done.push(`${r.threadId}${r.status ? `=${r.status}` : ""}`);
  }
  // the editor shows the threads it changed as they are now: read back in the same process (no second aihub start)
  const ids = new Set(replies.map((r) => r.threadId));
  const repo = decodeURIComponent(client.repoPath().split("/").pop() ?? "");
  const threads = o.returnThreads ? (await editorThreads(client, repo, pr.pullRequestId)).threads.filter((t) => ids.has(t.threadId)) : undefined;
  return o.json
    ? JSON.stringify({ pr: pr.pullRequestId, replied: replies.map((r) => r.threadId), ...(threads ? { threads } : {}) })
    : `!${pr.pullRequestId}: ${replies.length} repl${replies.length === 1 ? "y" : "ies"} posted (${done.join(", ")})`;
}

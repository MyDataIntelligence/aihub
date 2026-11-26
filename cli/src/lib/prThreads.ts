import { type AdoClient } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { parsePrRef, resolvePr } from "./pr.js";
import { whoAmI, type Me } from "./watchMine.js";

/**
 * The review threads of one or more pull requests in the shape an editor needs: every thread (open and resolved), its
 * position tracked to the latest iteration, whether that position is outdated, the comments with their time and author,
 * and the suggestions as old and new lines. One process for all pull requests of a set: `--pr repo-a:812 --pr repo-c:813`.
 */

interface RawPos {
  line: number;
  offset?: number;
}
interface RawComment {
  id: number;
  parentCommentId?: number;
  content?: string;
  commentType?: string;
  isDeleted?: boolean;
  publishedDate?: string;
  lastUpdatedDate?: string;
  author?: { displayName?: string; id?: string };
}
interface RawThread {
  id: number;
  status?: string;
  isDeleted?: boolean;
  publishedDate?: string;
  lastUpdatedDate?: string;
  comments?: RawComment[];
  properties?: Record<string, unknown>;
  threadContext?: { filePath?: string; rightFileStart?: RawPos; rightFileEnd?: RawPos; leftFileStart?: RawPos; leftFileEnd?: RawPos } | null;
  pullRequestThreadContext?: {
    iterationContext?: { firstComparingIteration?: number; secondComparingIteration?: number };
    trackingCriteria?: { origFilePath?: string; origRightFileStart?: RawPos; origRightFileEnd?: RawPos; secondComparingIteration?: number };
  } | null;
}
interface RawIteration {
  id: number;
  sourceRefCommit?: { commitId: string };
  commonRefCommit?: { commitId: string };
  targetRefCommit?: { commitId: string };
}

export interface EditorComment {
  id: number;
  parentId?: number;
  author: string;
  authorId?: string;
  /** ISO time the comment was last changed (published when never edited) */
  when?: string;
  /** markdown */
  text: string;
}

export interface Suggestion {
  commentId: number;
  /** the lines the reviewer saw (the right side of the diff at the commented iteration) */
  old: string[];
  new: string[];
}

export interface EditorThread {
  threadId: number;
  status: string;
  open: boolean;
  /** repository path ("/notebooks/orders.py"); absent: a general comment on the pull request */
  file?: string;
  /** the file had another path when the comment was made */
  renamedFrom?: string;
  /** right: on the new code (the usual case); left: on a line the pull request removes */
  side?: "right" | "left";
  /** first and last line (1-based) on that side, tracked to the latest iteration when Azure DevOps could */
  line?: number;
  endLine?: number;
  /** the iteration the comment was made on, and the latest one */
  iteration?: number;
  /** the commented lines changed after the comment (a later iteration replaced them) */
  outdated: boolean;
  /** the file is not in the latest iteration any more */
  fileDeleted?: boolean;
  /** the commented lines as the reviewer saw them */
  original?: string[];
  /** the lines at the tracked position in the latest iteration, with up to 2 lines around them (anchor for the editor) */
  anchor?: { start: number; lines: string[] };
  published?: string;
  updated?: string;
  comments: EditorComment[];
  suggestions: Suggestion[];
}

export interface PrThreads {
  repo: string;
  pr: number;
  latestIteration?: number;
  sourceCommit?: string;
  threads: EditorThread[];
}

const OPEN = new Set(["active", "pending", ""]);
const AROUND = 2;

/** "```suggestion\n...\n```" blocks of a comment, in order. */
export function suggestionBlocks(text: string): string[][] {
  const out: string[][] = [];
  const re = /```suggestion[^\n]*\n([\s\S]*?)```/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const body = m[1].replace(/\r\n/g, "\n").replace(/\n$/, "");
    out.push(body === "" ? [] : body.split("\n"));
  }
  return out;
}

const slice = (lines: string[] | undefined, from: number, to: number): string[] | undefined => {
  if (!lines || from < 1 || from > lines.length) return undefined;
  return lines.slice(from - 1, Math.min(lines.length, to));
};
const same = (a?: string[], b?: string[]) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/** Reads the threads of one pull request; `files` is shared so one file at one commit is fetched once per run. */
export async function editorThreads(client: AdoClient, repo: string, prId: number, files = new Map<string, Promise<string[] | undefined>>()): Promise<PrThreads> {
  const base = `${client.repoPath()}/pullrequests/${prId}`;
  const iterations = await client.list<RawIteration>(`${base}/iterations`);
  const latest = iterations.reduce((m, i) => Math.max(m, i.id), 0) || undefined;
  const iter = (n: number | undefined) => iterations.find((i) => i.id === n);
  // with $iteration Azure DevOps tracks every position to that iteration (moved lines, renamed files)
  const raw = await client.list<RawThread>(`${base}/threads`, latest ? { $iteration: latest, $baseIteration: 0 } : {});
  const fileAt = (path: string, commit: string | undefined): Promise<string[] | undefined> => {
    if (!commit) return Promise.resolve(undefined);
    const key = `${commit}|${path}`;
    if (!files.has(key)) files.set(key, fetchLines(client, path, commit));
    return files.get(key)!;
  };
  const latestCommit = iter(latest)?.sourceRefCommit?.commitId;
  const threads: EditorThread[] = [];
  for (const t of raw) {
    if (t.isDeleted) continue;
    const comments = (t.comments ?? []).filter((c) => !c.isDeleted && (c.commentType ?? "text") !== "system");
    // a thread of only system comments (votes, pushes, policy) is no review comment
    if (!comments.length) continue;
    const status = t.status ?? "active";
    const ctx = t.threadContext ?? undefined;
    const prc = t.pullRequestThreadContext ?? undefined;
    const view: EditorThread = {
      threadId: t.id,
      status,
      open: OPEN.has(status),
      outdated: false,
      published: t.publishedDate,
      updated: t.lastUpdatedDate,
      comments: comments.map((c) => ({
        id: c.id,
        ...(c.parentCommentId ? { parentId: c.parentCommentId } : {}),
        author: c.author?.displayName ?? "?",
        ...(c.author?.id ? { authorId: c.author.id } : {}),
        when: c.lastUpdatedDate ?? c.publishedDate,
        text: (c.content ?? "").trim(),
      })),
      suggestions: [],
    };
    if (ctx?.filePath) {
      view.file = ctx.filePath;
      const orig = prc?.trackingCriteria;
      if (orig?.origFilePath && orig.origFilePath !== ctx.filePath) view.renamedFrom = orig.origFilePath;
      const commented = prc?.iterationContext?.secondComparingIteration ?? orig?.secondComparingIteration ?? latest;
      view.iteration = commented;
      if (ctx.rightFileStart) {
        view.side = "right";
        view.line = ctx.rightFileStart.line;
        view.endLine = Math.max(view.line, ctx.rightFileEnd?.line ?? view.line);
        const now = await fileAt(ctx.filePath, latestCommit);
        if (latestCommit && !now) view.fileDeleted = true;
        const current = slice(now, view.line, view.endLine);
        if (now) view.anchor = { start: Math.max(1, view.line - AROUND), lines: now.slice(Math.max(0, view.line - 1 - AROUND), Math.min(now.length, view.endLine + AROUND)) };
        // what the reviewer saw: the original position in the commented iteration (the same file before a rename)
        const oStart = orig?.origRightFileStart?.line ?? view.line;
        const oEnd = Math.max(oStart, orig?.origRightFileEnd?.line ?? (orig?.origRightFileStart ? oStart : view.endLine));
        const seen = commented !== undefined && commented !== latest ? slice(await fileAt(view.renamedFrom ?? ctx.filePath, iter(commented)?.sourceRefCommit?.commitId), oStart, oEnd) : current;
        view.original = seen ?? current;
        view.outdated = commented !== undefined && latest !== undefined && commented < latest && !!seen && !same(seen, current);
      } else if (ctx.leftFileStart) {
        // on a line the pull request removes: it is not in the new file; the old text comes from the base
        view.side = "left";
        view.line = ctx.leftFileStart.line;
        view.endLine = Math.max(view.line, ctx.leftFileEnd?.line ?? view.line);
        view.original = slice(await fileAt(ctx.filePath, iter(latest)?.commonRefCommit?.commitId ?? iter(latest)?.targetRefCommit?.commitId), view.line, view.endLine);
      }
      if (view.side === "right") {
        for (const c of view.comments) for (const block of suggestionBlocks(c.text)) view.suggestions.push({ commentId: c.id, old: view.original ?? [], new: block });
      }
    }
    threads.push(view);
  }
  return { repo, pr: prId, latestIteration: latest, sourceCommit: latestCommit, threads };
}

async function fetchLines(client: AdoClient, path: string, commit: string): Promise<string[] | undefined> {
  try {
    const text = await client.getText(`${client.repoPath()}/items`, { path, "versionDescriptor.version": commit, "versionDescriptor.versionType": "commit", $format: "text" });
    return text.replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
  } catch {
    return undefined;
  }
}

/** "repo-a:812" -> { repo, pr }; "812" or a pull request URL -> the current repository. */
export function parseRepoPr(s: string): { repo?: string; pr: number } {
  const m = /^([^:/\\]+):(\d+)$/.exec(s.trim());
  if (m) return { repo: m[1], pr: Number(m[2]) };
  return { pr: parsePrRef(s) };
}

export async function commentsThreads(ctx: Ctx, o: { prs?: string[] }): Promise<string> {
  const { root, client } = repoClient(ctx);
  const here = client.repoPath().split("/").pop() ?? "";
  const wanted = o.prs?.length ? o.prs.map(parseRepoPr) : [{ repo: undefined, pr: (await resolvePr(ctx, client, root)).pullRequestId }];
  const files = new Map<string, Promise<string[] | undefined>>();
  const meP: Promise<Me | undefined> = whoAmI(client).catch(() => undefined);
  // the pull requests are read side by side: one process, one sign-in, many requests
  const results = await Promise.all(
    wanted.map(async (w) => {
      const repo = w.repo ?? decodeURIComponent(here);
      try {
        return { ok: await editorThreads(w.repo ? client.forRepo(w.repo) : client, repo, w.pr, files) };
      } catch (e) {
        if (e instanceof AihubError && /not signed in/.test(e.message)) throw e;
        return { failed: { repo, pr: w.pr, error: (e as Error).message } };
      }
    }),
  );
  const me = await meP;
  return JSON.stringify({
    ...(me ? { me } : {}),
    prs: results.flatMap((r) => (r.ok ? [r.ok] : [])),
    failed: results.flatMap((r) => (r.failed ? [r.failed] : [])),
  });
}

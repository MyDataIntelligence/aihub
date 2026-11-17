import { parse } from "yaml";
import { getPr, type AdoClient, type PullRequest, shortBranch } from "./ado.js";
import { getThreads, type ThreadView } from "./comments.js";
import { repoClient, type Ctx } from "./context.js";
import { diffLines } from "./diff.js";
import { AihubError } from "./errors.js";
import { workItemFromBranch } from "./git.js";
import { parsePrRef } from "./pr.js";
import { readUtf8 } from "./team.js";

interface PrFull extends PullRequest {
  createdBy?: { displayName?: string; id?: string };
  creationDate?: string;
  mergeStatus?: string;
  reviewers?: { displayName?: string; vote?: number }[];
  autoCompleteSetBy?: { displayName?: string };
  workItemRefs?: { id: string }[];
}

interface Iteration {
  id: number;
  sourceRefCommit?: { commitId: string };
  commonRefCommit?: { commitId: string };
}

export interface FileChange {
  path: string;
  type: string;
  added?: number;
  removed?: number;
  diff?: string;
}

const getFull = (c: AdoClient, id: number) => getPr(c, id) as Promise<PrFull>;

async function latestIteration(c: AdoClient, id: number): Promise<Iteration | undefined> {
  const its = await c.list<Iteration>(`${c.repoPath()}/pullrequests/${id}/iterations`);
  return its.sort((a, b) => b.id - a.id)[0];
}

async function changesOf(c: AdoClient, id: number, it: Iteration | undefined): Promise<FileChange[]> {
  if (!it) return [];
  const r = await c.get<{ changeEntries?: { changeType?: string; item?: { path?: string; isFolder?: boolean } }[] }>(
    `${c.repoPath()}/pullrequests/${id}/iterations/${it.id}/changes`,
  );
  return (r.changeEntries ?? [])
    .filter((e) => e.item?.path && !e.item.isFolder)
    .map((e) => ({ path: e.item!.path!, type: String(e.changeType ?? "edit").split(",")[0].trim() }));
}

async function fileAt(c: AdoClient, path: string, commit: string): Promise<string | undefined> {
  try {
    return (await c.getText(`${c.repoPath()}/items`, { path, "versionDescriptor.version": commit, "versionDescriptor.versionType": "commit", $format: "text" })).replace(/^﻿/, "");
  } catch {
    return undefined;
  }
}

export interface ShowOpts {
  pr: string;
  maxFiles?: number;
  maxDiffLines?: number;
  noDiff?: boolean;
  json?: boolean;
}

export async function reviewShow(ctx: Ctx, o: ShowOpts): Promise<string> {
  const { client } = repoClient(ctx);
  const id = parsePrRef(o.pr);
  const pr = await getFull(client, id);
  const it = await latestIteration(client, id);
  const changes = await changesOf(client, id, it);
  const maxFiles = o.maxFiles ?? 25;
  if (!o.noDiff && it?.sourceRefCommit && it.commonRefCommit) {
    for (const ch of changes.slice(0, maxFiles)) {
      const before = ch.type === "add" ? "" : await fileAt(client, ch.path, it.commonRefCommit.commitId);
      const after = ch.type === "delete" ? "" : await fileAt(client, ch.path, it.sourceRefCommit.commitId);
      if (before === undefined || after === undefined) continue;
      const d = diffLines(before, after, o.maxDiffLines ?? 120);
      ch.added = d.added;
      ch.removed = d.removed;
      ch.diff = d.text;
    }
  }
  const threads = await getThreads(client, id, it?.sourceRefCommit?.commitId ?? pr.lastMergeSourceCommit?.commitId, true);
  const wi = pr.workItemRefs?.[0]?.id ?? workItemFromBranch(shortBranch(pr.sourceRefName));
  if (o.json) return JSON.stringify({ pr: id, title: pr.title, status: pr.status, author: pr.createdBy?.displayName, source: shortBranch(pr.sourceRefName), target: shortBranch(pr.targetRefName), story: wi, description: pr.description ?? "", changes, threads });
  return formatShow(id, pr, wi, changes, threads, maxFiles);
}

function formatShow(id: number, pr: PrFull, wi: string | number | undefined, changes: FileChange[], threads: ThreadView[], maxFiles: number): string {
  const l: string[] = [];
  l.push(`!${id} ${pr.title} (${pr.status}${pr.isDraft ? ", draft" : ""}) by ${pr.createdBy?.displayName ?? "?"}`);
  l.push(`${shortBranch(pr.sourceRefName)} -> ${shortBranch(pr.targetRefName)}${wi ? `, story AB#${wi}` : ""}`);
  if (pr.description?.trim()) l.push("", "Description:", pr.description.trim());
  l.push("", `Changes: ${changes.length} file(s)`);
  for (const c of changes.slice(0, maxFiles)) {
    l.push(`### ${c.type} ${c.path}${c.added !== undefined ? ` (+${c.added} -${c.removed})` : ""}`);
    if (c.diff) l.push(c.diff);
  }
  if (changes.length > maxFiles) l.push(`... ${changes.length - maxFiles} more file(s) not shown (raise --max-files)`);
  l.push("", `Threads: ${threads.length}`);
  for (const t of threads) {
    const where = t.file ? `${t.file}${t.line ? `:${t.line}` : ""}` : "(general)";
    l.push(`[${t.threadId}] ${where} (${t.status}) ${t.comments.map((c) => `${c.author}: ${c.text.replace(/\s*\n\s*/g, " / ")}`).join(" | ")}`);
  }
  return l.join("\n");
}

export interface ReviewComment {
  file?: string;
  line?: number;
  text: string;
}

export function parseReviewComments(yamlText: string): ReviewComment[] {
  const doc = parse(yamlText) as unknown;
  const list = Array.isArray(doc) ? doc : (doc as { comments?: unknown })?.comments;
  if (!Array.isArray(list) || !list.length) throw new AihubError("comments file must be a yaml list of {file, line, text}");
  return list.map((r: Record<string, unknown>, i) => {
    const text = r.text === undefined || r.text === null ? "" : String(r.text).trim();
    if (!text) throw new AihubError(`comments[${i}]: text is missing`);
    const file = r.file === undefined || r.file === null ? undefined : String(r.file).replace(/\\/g, "/");
    let line: number | undefined;
    if (r.line !== undefined && r.line !== null) {
      line = Number(r.line);
      if (!Number.isInteger(line) || line <= 0) throw new AihubError(`comments[${i}]: line must be a positive number`);
      if (!file) throw new AihubError(`comments[${i}]: a line needs a file`);
    }
    return { file: file ? (file.startsWith("/") ? file : `/${file}`) : undefined, line, text };
  });
}

export async function reviewPost(ctx: Ctx, o: { pr: string; commentsFile: string; json?: boolean }): Promise<string> {
  const comments = parseReviewComments(readUtf8(o.commentsFile));
  const { client } = repoClient(ctx);
  const id = parsePrRef(o.pr);
  await getFull(client, id);
  const created: { threadId: number; where: string }[] = [];
  for (const c of comments) {
    const body: Record<string, unknown> = { comments: [{ parentCommentId: 0, content: c.text, commentType: 1 }], status: 1 };
    if (c.file) {
      const pos = { line: c.line ?? 1, offset: 1 };
      body.threadContext = { filePath: c.file, rightFileStart: pos, rightFileEnd: c.line ? { line: c.line, offset: 200 } : pos };
    }
    const r = await client.post<{ id?: number }>(`${client.repoPath()}/pullrequests/${id}/threads`, body);
    created.push({ threadId: r.id ?? 0, where: c.file ? `${c.file}${c.line ? `:${c.line}` : ""}` : "(general)" });
  }
  return o.json ? JSON.stringify({ pr: id, created }) : `!${id}: ${created.length} thread(s) created (${created.map((c) => `${c.threadId} ${c.where}`).join(", ")})`;
}

// ---- pr explain ------------------------------------------------------------

export async function prExplain(ctx: Ctx, o: { pr: string; json?: boolean }): Promise<string> {
  const { client } = repoClient(ctx);
  const id = parsePrRef(o.pr);
  const pr = await getFull(client, id);
  const it = await latestIteration(client, id);
  const changes = await changesOf(client, id, it);
  const wiId = pr.workItemRefs?.[0]?.id ?? workItemFromBranch(shortBranch(pr.sourceRefName));
  let story: string | undefined;
  if (wiId) {
    try {
      const w = await client.get<{ fields?: Record<string, string> }>(`wit/workitems/${wiId}`, { fields: "System.Title,System.State" });
      story = `AB#${wiId} ${w.fields?.["System.Title"] ?? ""} (${w.fields?.["System.State"] ?? "?"})`;
    } catch {
      story = `AB#${wiId}`;
    }
  }
  const byType: Record<string, number> = {};
  for (const c of changes) byType[c.type] = (byType[c.type] ?? 0) + 1;
  let builds: { name: string; state: string }[] = [];
  try {
    const b = await client.get<{ value?: { definition?: { name?: string }; status?: string; result?: string }[] }>("build/builds", {
      branchName: `refs/pull/${id}/merge`,
      queryOrder: "queueTimeDescending",
      $top: 5,
    });
    const seen = new Set<string>();
    for (const x of b.value ?? []) {
      const name = x.definition?.name ?? "?";
      if (seen.has(name)) continue;
      seen.add(name);
      builds.push({ name, state: x.status === "completed" ? (x.result ?? "completed") : (x.status ?? "?") });
    }
  } catch {
    builds = [];
  }
  const threads = await getThreads(client, id, undefined, true);
  const open = threads.filter((t) => ["active", "pending"].includes(t.status)).length;
  const facts = {
    pr: id,
    title: pr.title,
    status: pr.status,
    draft: !!pr.isDraft,
    author: pr.createdBy?.displayName,
    source: shortBranch(pr.sourceRefName),
    target: shortBranch(pr.targetRefName),
    story,
    description: (pr.description ?? "").trim(),
    files: changes.length,
    changeTypes: byType,
    changedFiles: changes.slice(0, 40).map((c) => `${c.type} ${c.path}`),
    pipelines: builds,
    threads: { total: threads.length, open },
    reviewers: (pr.reviewers ?? []).map((r) => `${r.displayName}: ${voteName(r.vote)}`),
    mergeStatus: pr.mergeStatus,
    autoComplete: pr.autoCompleteSetBy?.displayName,
  };
  if (o.json) return JSON.stringify(facts);
  const l = [`!${id} ${facts.title} (${facts.status}${facts.draft ? ", draft" : ""}) by ${facts.author ?? "?"}`, `${facts.source} -> ${facts.target}`];
  if (story) l.push(`Story: ${story}`);
  if (facts.description) l.push("", "Description:", facts.description);
  l.push("", `Files: ${facts.files} (${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(", ") || "none"})`, ...facts.changedFiles.map((f) => `  ${f}`));
  l.push(`Pipelines: ${builds.length ? builds.map((b) => `${b.name} ${b.state}`).join(", ") : "none found"}`);
  l.push(`Threads: ${facts.threads.total} (${open} open)`);
  if (facts.reviewers.length) l.push(`Reviewers: ${facts.reviewers.join(", ")}`);
  return l.join("\n");
}

const voteName = (v?: number) => (v === 10 ? "approved" : v === 5 ? "approved with suggestions" : v === -5 ? "waiting" : v === -10 ? "rejected" : "no vote");

// ---- pr complete -----------------------------------------------------------

export interface CompleteOpts {
  pr: string;
  auto?: boolean;
  deleteSource?: boolean;
  squash?: boolean;
  json?: boolean;
}

export async function prComplete(ctx: Ctx, o: CompleteOpts): Promise<string> {
  const { client } = repoClient(ctx);
  const id = parsePrRef(o.pr);
  const pr = await getFull(client, id);
  if (pr.status !== "active") throw new AihubError(`PR !${id} is ${pr.status}, not active`);
  if (pr.isDraft) throw new AihubError(`PR !${id} is a draft; mark it ready first (aihub pr update --draft false)`);
  const completionOptions: Record<string, unknown> = { deleteSourceBranch: !!o.deleteSource, bypassPolicy: false };
  if (o.squash) completionOptions.mergeStrategy = "squash";
  const url = client.prUrl(id);
  const path = `${client.repoPath()}/pullrequests/${id}`;
  if (o.auto) {
    let userId: string | undefined;
    try {
      userId = (await client.get<{ authenticatedUser?: { id?: string } }>("connectionData")).authenticatedUser?.id;
    } catch {
      userId = undefined;
    }
    userId ??= pr.createdBy?.id;
    if (!userId) throw new AihubError("could not find your Azure DevOps user id for auto-complete");
    await client.patch(path, { autoCompleteSetBy: { id: userId }, completionOptions });
    return o.json ? JSON.stringify({ pr: id, autoComplete: true, url }) : `PR !${id}: auto-complete set, it merges when the policies pass (${url})`;
  }
  const commit = pr.lastMergeSourceCommit?.commitId;
  if (!commit) throw new AihubError(`PR !${id} has no source commit yet`);
  const done = await client.patch<PrFull>(path, { status: "completed", lastMergeSourceCommit: { commitId: commit }, completionOptions });
  return o.json ? JSON.stringify({ pr: id, status: done.status, url }) : `PR !${id}: completion requested, status ${done.status ?? "completed"} (${url})`;
}

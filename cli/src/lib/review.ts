import { existsSync } from "node:fs";
import { parse, stringify } from "yaml";
import { getPr, type AdoClient, type PullRequest, shortBranch } from "./ado.js";
import { aihubDir } from "./aihubDir.js";
import { getThreads, type ThreadView } from "./comments.js";
import { repoClient, type Ctx } from "./context.js";
import { diffLines } from "./diff.js";
import { AihubError } from "./errors.js";
import { workItemFromBranch } from "./git.js";
import { evaluations } from "./policy.js";
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

/** One thread per comment, on the right file and line when it has them. */
async function postThreads(client: AdoClient, id: number, comments: ReviewComment[]): Promise<{ threadId: number; where: string }[]> {
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
  return created;
}

export async function reviewPost(ctx: Ctx, o: { pr: string; commentsFile: string; json?: boolean }): Promise<string> {
  const comments = parseReviewComments(readUtf8(o.commentsFile));
  const { client } = repoClient(ctx);
  const id = parsePrRef(o.pr);
  await getFull(client, id);
  const created = await postThreads(client, id, comments);
  return o.json ? JSON.stringify({ pr: id, created }) : `!${id}: ${created.length} thread(s) created (${created.map((c) => `${c.threadId} ${c.where}`).join(", ")})`;
}

// ---- pre-review: prepare, numbered findings, post only the picked ones ---------------------------------

export const SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  n: number;
  severity: Severity;
  file?: string;
  line?: number;
  text: string;
  suggestion?: string;
}

/** Where the agent writes its numbered findings for a PR (local, never committed). */
export const findingsPath = (root: string, pr: number): string => aihubDir(root, "review", `pr-${pr}.yaml`);

/** `aihub review prepare --pr N`: the PR compactly (description, changed files with numbered diff lines, open threads) and where to write the findings. */
export async function reviewPrepare(ctx: Ctx, o: { pr: string; maxFiles?: number; maxDiffLines?: number; json?: boolean }): Promise<string> {
  const { root } = repoClient(ctx);
  const id = parsePrRef(o.pr);
  const path = findingsPath(root, id);
  const show = await reviewShow(ctx, { pr: o.pr, maxFiles: o.maxFiles ?? 15, maxDiffLines: o.maxDiffLines ?? 60, json: o.json });
  if (o.json) return JSON.stringify({ ...(JSON.parse(show) as object), findingsFile: path, format: "yaml list of {n, severity: blocker|major|minor|nit, file, line, text, suggestion}" });
  return [
    `PRE-REVIEW !${id}: nothing is posted until the developer picks findings.`,
    `Write your findings to ${path} as a YAML list, numbered from 1: {n, severity: blocker|major|minor|nit, file, line, text, suggestion}.`,
    "Use the new-file line numbers of the diff below. Then show the numbered list and ask which to post: aihub review post --pr " + id + " --pick 1,3",
    "",
    show,
  ].join("\n");
}

export function parseFindings(yamlText: string): Finding[] {
  const doc = parse(yamlText) as unknown;
  const list = Array.isArray(doc) ? doc : (doc as { findings?: unknown })?.findings;
  if (!Array.isArray(list) || !list.length) throw new AihubError("findings file must be a yaml list of {n, severity, file, line, text, suggestion}");
  const seen = new Set<number>();
  return list.map((r: Record<string, unknown>, i) => {
    const text = r.text === undefined || r.text === null ? "" : String(r.text).trim();
    if (!text) throw new AihubError(`findings[${i}]: text is missing`);
    const n = r.n === undefined || r.n === null ? i + 1 : Number(r.n);
    if (!Number.isInteger(n) || n <= 0) throw new AihubError(`findings[${i}]: n must be a positive number`);
    if (seen.has(n)) throw new AihubError(`findings[${i}]: number ${n} is used twice`);
    seen.add(n);
    const severity = String(r.severity ?? "minor").toLowerCase() as Severity;
    if (!SEVERITIES.includes(severity)) throw new AihubError(`findings[${i}]: severity must be ${SEVERITIES.join(", ")}`);
    const c = parseReviewComments(stringify([{ file: r.file, line: r.line, text }]))[0];
    const suggestion = r.suggestion === undefined || r.suggestion === null ? undefined : String(r.suggestion).trim() || undefined;
    return { n, severity, file: c.file, line: c.line, text, suggestion };
  });
}

/** "1,3,5", "2-4", "all" -> numbers; a number that is not a finding is an error (nothing is posted). */
export function parsePick(pick: string, findings: Finding[]): number[] {
  const have = new Set(findings.map((f) => f.n));
  if (pick.trim().toLowerCase() === "all") return [...have];
  const out: number[] = [];
  for (const part of pick.split(",").map((s) => s.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    const nums = range ? Array.from({ length: Math.max(0, Number(range[2]) - Number(range[1]) + 1) }, (_, k) => Number(range[1]) + k) : [Number(part)];
    for (const n of nums) {
      if (!Number.isInteger(n) || !have.has(n)) throw new AihubError(`--pick ${part}: there is no finding ${Number.isInteger(n) ? n : part} (have ${[...have].join(", ")}); nothing was posted`);
      if (!out.includes(n)) out.push(n);
    }
  }
  if (!out.length) throw new AihubError("--pick is empty; nothing was posted");
  return out;
}

const findingText = (f: Finding): string => `[${f.severity}] ${f.text}${f.suggestion ? `\n\nSuggestion: ${f.suggestion}` : ""}`;

/** `aihub review post --pr N [--findings-file f] [--pick 1,3,5]`: without --pick it lists the findings and posts nothing. */
export async function reviewPostPicked(ctx: Ctx, o: { pr: string; findingsFile?: string; pick?: string; json?: boolean }): Promise<string> {
  const { root, client } = repoClient(ctx);
  const id = parsePrRef(o.pr);
  const file = o.findingsFile ?? findingsPath(root, id);
  if (!existsSync(file)) throw new AihubError(`no findings file at ${file}; run 'aihub review prepare --pr ${id}' and write the findings there`);
  const findings = parseFindings(readUtf8(file));
  if (!o.pick) {
    const rows = findings.map((f) => `${f.n}. [${f.severity}] ${f.file ? `${f.file.replace(/^\//, "")}${f.line ? `:${f.line}` : ""}` : "(general)"} ${f.text}`);
    return o.json ? JSON.stringify({ pr: id, posted: false, findings }) : `!${id}: nothing posted (no --pick). Findings:\n${rows.join("\n")}\nPost with: aihub review post --pr ${id} --pick 1,3`;
  }
  const picked = parsePick(o.pick, findings);
  await getFull(client, id);
  const created = await postThreads(client, id, picked.map((n) => findings.find((f) => f.n === n)!).map((f) => ({ file: f.file, line: f.line, text: findingText(f) })));
  return o.json ? JSON.stringify({ pr: id, posted: true, picked, created }) : `!${id}: ${created.length} thread(s) created for finding(s) ${picked.join(", ")} (${created.map((c) => `${c.threadId} ${c.where}`).join(", ")}); the other findings were not posted`;
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
      userId = (await client.getOrg<{ authenticatedUser?: { id?: string } }>("connectionData")).authenticatedUser?.id;
    } catch {
      userId = undefined;
    }
    userId ??= pr.createdBy?.id;
    if (!userId) throw new AihubError("could not find your Azure DevOps user id for auto-complete");
    await client.patch(path, { autoCompleteSetBy: { id: userId }, completionOptions });
    const after = await settle(ctx, client, id);
    if (after.status === "completed") {
      return o.json ? JSON.stringify({ pr: id, autoComplete: false, status: "completed", url }) : `PR !${id}: completed immediately, nothing was waiting on it (no blocking policies) (${url})`;
    }
    const waits = await waitingFor(client, id, after);
    return o.json
      ? JSON.stringify({ pr: id, autoComplete: true, status: after.status, waitsFor: waits, url })
      : `PR !${id}: auto-complete set, it merges when: ${waits.length ? waits.join("; ") : "the policies pass"} (${url})`;
  }
  const commit = pr.lastMergeSourceCommit?.commitId;
  if (!commit) throw new AihubError(`PR !${id} has no source commit yet`);
  await client.patch<PrFull>(path, { status: "completed", lastMergeSourceCommit: { commitId: commit }, completionOptions });
  const done = await settle(ctx, client, id);
  if (done.status === "completed") return o.json ? JSON.stringify({ pr: id, status: "completed", url }) : `PR !${id}: completed (${url})`;
  const why = await waitingFor(client, id, done);
  return o.json
    ? JSON.stringify({ pr: id, status: done.status, waitsFor: why, url })
    : `PR !${id}: completion requested but the PR is still ${done.status}${why.length ? `, waiting for: ${why.join("; ")}` : ""} (${url})`;
}


/** Azure DevOps completes a PR asynchronously: look again for a few seconds before saying what happened. */
async function settle(ctx: Ctx, client: AdoClient, id: number): Promise<PrFull> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let pr = await getFull(client, id);
  for (let i = 0; i < 4 && pr.status === "active"; i++) {
    await sleep(1500);
    pr = await getFull(client, id);
  }
  return pr;
}

async function waitingFor(client: AdoClient, id: number, pr: PrFull & { mergeStatus?: string }): Promise<string[]> {
  const out: string[] = [];
  try {
    for (const p of await evaluations(client, id)) if (p.blocks) out.push(`${p.name} is ${p.status}`);
  } catch {
    /* policies are a hint only */
  }
  if (pr.mergeStatus === "conflicts") out.push("merge conflicts");
  return out;
}

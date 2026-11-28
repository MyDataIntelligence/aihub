import { basename } from "node:path";
import { getPr, getWorkItemTitle, type AdoClient, type PullRequest } from "./ado.js";
import { AihubError } from "./errors.js";
import { parseUtc } from "./fabric-ops.js";
import { buildTestPlan, itemFolder } from "./fabric-testplan.js";
import { environmentsOf, prsOf, storiesOf } from "./releaseEnv.js";
import type { TeamConfig } from "./team.js";

/**
 * "Which commit runs in this workspace?" and "what changed since the last green run?". A test, acceptance or production
 * workspace is filled by the team's CD pipeline and is not connected to git; Azure DevOps knows its commit: the newest run
 * of the CD pipeline on the environment's branch whose deploy stage succeeded. Read only.
 */

/** How many CD runs are looked at, newest first. */
export const MAX_RUNS = 30;
/** How many commits of the window are read. */
export const MAX_COMMITS = 50;

export interface DeployEnv {
  name: string;
  branch?: string;
  /** The workspace display name with `{repo}` expanded. */
  workspace?: string;
  pipeline?: string;
  stage?: string;
}

/** `fabric.environments.<ENV>` with `{repo}` in the workspace name replaced by the repository name. */
export function deployEnvs(team: TeamConfig, repo: string): DeployEnv[] {
  const raw = environmentsOf(team) as Record<string, { branch?: string; workspace?: string; deployedBy?: { pipeline?: string | number; stage?: string } }>;
  return Object.entries(raw).map(([name, e]) => ({
    name,
    branch: e.branch,
    workspace: e.workspace ? String(e.workspace).replace(/\{repo\}/g, repo) : undefined,
    pipeline: e.deployedBy?.pipeline !== undefined ? String(e.deployedBy.pipeline) : undefined,
    stage: e.deployedBy?.stage,
  }));
}

/** The environment of a workspace (exact, case-insensitive) or of an environment name. */
export function matchEnv(envs: DeployEnv[], o: { workspace?: string; env?: string }): DeployEnv | undefined {
  if (o.env) return envs.find((e) => e.name.toLowerCase() === o.env!.toLowerCase());
  const w = o.workspace?.trim().toLowerCase();
  return w ? envs.find((e) => e.workspace?.toLowerCase() === w) : undefined;
}

export const listEnvs = (envs: DeployEnv[]): string => (envs.length ? envs.map((e) => `${e.name}${e.workspace ? ` = "${e.workspace}"` : " (no workspace)"}`).join(", ") : "none");

/** The sentence for a workspace no environment describes. */
export function noEnvMessage(envs: DeployEnv[], workspace: string | undefined): string {
  return `no fabric.environments entry in team.yaml has workspace '${workspace ?? "?"}' (configured: ${listEnvs(envs)}). A feature workspace is connected to git: aihub fabric git status --workspace "${workspace ?? "W"}" shows its commit. For a CD-filled workspace add fabric.environments.<ENV>.workspace (and deployedBy) to team.yaml.`;
}

/** The team.yaml lines a missing `deployedBy` needs. */
export function missingDeployedBy(e: DeployEnv): string {
  const missing = [!e.branch ? "branch" : "", !e.pipeline ? "deployedBy.pipeline" : "", !e.stage ? "deployedBy.stage" : ""].filter(Boolean);
  return `fabric.environments.${e.name} in team.yaml has no ${missing.join(", ")}: add\n  fabric:\n    environments:\n      ${e.name}:\n        branch: ${e.branch ?? "<branch>"}\n        deployedBy:\n          pipeline: <CD pipeline name or id>\n          stage: <stage that deploys ${e.name}>`;
}

export const isConfigured = (e: DeployEnv): boolean => !!(e.branch && e.pipeline && e.stage);

// ---- Azure DevOps reads ------------------------------------------------------------------------------------------------

interface Build {
  id: number;
  buildNumber?: string;
  status?: string;
  result?: string;
  sourceBranch?: string;
  sourceVersion?: string;
  reason?: string;
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  requestedFor?: { displayName?: string };
  repository?: { id?: string; type?: string };
  triggerInfo?: Record<string, string>;
}

interface Rec {
  type: string;
  name: string;
  identifier?: string;
  result?: string | null;
  state?: string;
  finishTime?: string;
}

export interface Deployment {
  run: number;
  number?: string;
  /** When the deploy stage finished. */
  finished: string;
  commit: string;
  reason?: string;
  requestedFor?: string;
  repositoryId?: string;
  triggerMessage?: string;
}

export async function definitionOf(c: AdoClient, ref: string): Promise<{ id: number; name: string }> {
  if (/^\d+$/.test(ref)) {
    const d = await c.get<{ id: number; name: string }>(`build/definitions/${ref}`);
    return { id: d.id ?? Number(ref), name: d.name ?? ref };
  }
  const defs = await c.list<{ id: number; name: string }>("build/definitions", { name: ref });
  const hit = defs.filter((d) => d.name.toLowerCase() === ref.toLowerCase());
  if (hit.length !== 1) throw new AihubError(hit.length ? `CD pipeline name '${ref}' is not unique; put its id in deployedBy.pipeline` : `CD pipeline '${ref}' (fabric.environments deployedBy.pipeline) not found in Azure DevOps; see: aihub pipeline def list`);
  return hit[0];
}

const SUCCEEDED = /^succeeded(withissues)?$/i;

/** The deploy stage of a run when it succeeded, else undefined. */
async function deployStage(c: AdoClient, run: number, stage: string): Promise<Rec | undefined> {
  const t = await c.get<{ records?: Rec[] }>(`build/builds/${run}/timeline`);
  const s = stage.toLowerCase();
  const rec = (t.records ?? []).find((r) => r.type === "Stage" && (r.name?.toLowerCase() === s || r.identifier?.toLowerCase() === s));
  return rec && SUCCEEDED.test(String(rec.result ?? "")) && rec.finishTime ? rec : undefined;
}

export interface DeploySearch {
  definition: { id: number; name: string };
  /** Successful deployments found, newest stage finish first. */
  found: Deployment[];
  /** Runs listed (at most MAX_RUNS). */
  looked: number;
  /** Timelines read. */
  timelines: number;
  /** True when the search stopped on its condition, false when it ran out of runs. */
  reached: boolean;
}

/**
 * Runs of the CD pipeline on `refs/heads/<branch>`, newest first, whose `stage` succeeded. `stop` ends the search at the
 * first deployment that satisfies it; `skipQueuedAfter` skips runs queued after a moment (they cannot have deployed before it).
 */
export async function searchDeployments(c: AdoClient, env: DeployEnv, o: { stop?: (d: Deployment) => boolean; skipQueuedAfter?: number } = {}): Promise<DeploySearch> {
  const definition = await definitionOf(c, env.pipeline!);
  const r = await c.get<{ value?: Build[] }>("build/builds", { definitions: definition.id, branchName: `refs/heads/${env.branch}`, queryOrder: "queueTimeDescending", $top: MAX_RUNS });
  const builds = (r.value ?? []).slice(0, MAX_RUNS);
  const found: Deployment[] = [];
  let timelines = 0;
  let reached = false;
  for (const b of builds) {
    if (o.skipQueuedAfter !== undefined && parseUtc(b.queueTime ?? b.startTime) > o.skipQueuedAfter) continue;
    if (!b.sourceVersion) continue;
    timelines++;
    const rec = await deployStage(c, b.id, env.stage!).catch(() => undefined);
    if (!rec) continue;
    const d: Deployment = { run: b.id, number: b.buildNumber, finished: rec.finishTime!, commit: b.sourceVersion, reason: b.reason, requestedFor: b.requestedFor?.displayName, repositoryId: b.repository?.type === "TfsGit" ? b.repository.id : undefined, triggerMessage: b.triggerInfo?.["ci.message"] };
    found.push(d);
    if (!o.stop || o.stop(d)) {
      reached = true;
      break;
    }
  }
  found.sort((a, b) => parseUtc(b.finished) - parseUtc(a.finished));
  return { definition, found, looked: builds.length, timelines, reached };
}

/** Versions of the other repository resources of a run (`resources.repositories.<alias>.version`, `self` left out); undefined when the API does not say. */
export async function runRepositories(c: AdoClient, definitionId: number, run: number): Promise<Record<string, string> | undefined> {
  try {
    const r = await c.get<{ resources?: { repositories?: Record<string, { version?: string }> } }>(`pipelines/${definitionId}/runs/${run}`, { "api-version": "7.1" });
    const repos = r.resources?.repositories;
    if (!repos || typeof repos !== "object") return undefined;
    const out = Object.fromEntries(Object.entries(repos).filter(([alias, x]) => alias !== "self" && typeof x?.version === "string").map(([alias, x]) => [alias, x.version!]));
    return out;
  } catch {
    return undefined;
  }
}

export interface CommitInfo {
  commit: string;
  title: string;
  paths: string[];
  pr?: number;
}

const repoClientFor = (c: AdoClient, repositoryId?: string) => (repositoryId ? c.forRepo(repositoryId) : c);

export async function commitTitle(c: AdoClient, sha: string, repositoryId?: string): Promise<string | undefined> {
  try {
    const rc = repoClientFor(c, repositoryId);
    const r = await rc.get<{ comment?: string }>(`${rc.repoPath()}/commits/${sha}`);
    return r.comment?.split(/\r?\n/)[0];
  } catch {
    return undefined;
  }
}

/**
 * Commits in `after` and not in `before` (newest first, at most MAX_COMMITS), with the files each changed. Which of
 * itemVersion and compareVersion is the newer side is not relied on: a right answer holds `after` itself (it is the tip of
 * the range), so the first answer is checked against that and the two are swapped once when it does not. `confirmed` is
 * false when neither answer holds `after`.
 */
export async function commitsBetween(c: AdoClient, before: string, after: string, repositoryId?: string): Promise<{ commits: CommitInfo[]; capped: boolean; confirmed: boolean }> {
  const rc = repoClientFor(c, repositoryId);
  type Row = { commitId: string; comment?: string };
  const range = async (item: string, compare: string): Promise<Row[]> => {
    const r = await rc.get<{ value?: Row[] }>(`${rc.repoPath()}/commits`, {
      "searchCriteria.itemVersion.version": item,
      "searchCriteria.itemVersion.versionType": "commit",
      "searchCriteria.compareVersion.version": compare,
      "searchCriteria.compareVersion.versionType": "commit",
      "searchCriteria.$top": MAX_COMMITS + 1,
    });
    return r.value ?? [];
  };
  const holdsAfter = (rows: Row[]) => rows.some((x) => x.commitId === after);
  // measured in Azure DevOps (2026-11): itemVersion = the older commit, compareVersion = the newer one gives the range
  let rows = await range(before, after);
  let confirmed = holdsAfter(rows);
  if (!confirmed) {
    const swapped = await range(after, before).catch(() => [] as Row[]);
    if (holdsAfter(swapped)) {
      rows = swapped;
      confirmed = true;
    } else if (!rows.length) rows = swapped;
  }
  const list = rows.filter((x) => x.commitId !== before);
  const capped = list.length > MAX_COMMITS;
  const commits: CommitInfo[] = [];
  for (const x of list.slice(0, MAX_COMMITS)) {
    let paths: string[] = [];
    try {
      const ch = await rc.get<{ changes?: { item?: { path?: string; isFolder?: boolean } }[] }>(`${rc.repoPath()}/commits/${x.commitId}/changes`, { $top: 500 });
      paths = (ch.changes ?? []).filter((y) => y.item?.path && !y.item.isFolder).map((y) => y.item!.path!.replace(/^\/+/, ""));
    } catch {
      /* a commit without its file list is still listed */
    }
    commits.push({ commit: x.commitId, title: (x.comment ?? "").split(/\r?\n/)[0], paths });
  }
  return { commits, capped, confirmed };
}

export interface PrInfo {
  pr: number;
  title: string;
  stories: { id: number; title?: string }[];
}

/** Pull requests of commits (merge-commit query, "Merged PR n" fallback), each with its title and linked stories. */
export async function pullRequestsOf(c: AdoClient, commits: { commit: string; title: string }[], repositoryId?: string): Promise<{ byCommit: Map<string, number[]>; prs: Map<number, PrInfo> }> {
  const rc = repoClientFor(c, repositoryId);
  const byCommit = await prsOf(rc, commits.map((x) => ({ sha: x.commit, subject: x.title, files: [] })));
  const prs = new Map<number, PrInfo>();
  for (const ids of byCommit.values()) {
    for (const id of ids) {
      if (prs.has(id)) continue;
      try {
        const pr = (await getPr(rc, id)) as PullRequest & { workItemRefs?: { id: string }[] };
        const ids2 = await storiesOf(rc, id, pr.workItemRefs);
        prs.set(id, { pr: id, title: pr.title, stories: await Promise.all(ids2.map(async (s) => ({ id: s, title: await getWorkItemTitle(rc, s) }))) });
      } catch {
        prs.set(id, { pr: id, title: `PR ${id}`, stories: [] });
      }
    }
  }
  return { byCommit, prs };
}

// ---- ranking -------------------------------------------------------------------------------------------------------------

export interface Change {
  pr?: number;
  title: string;
  commits: string[];
  stories: { id: number; title?: string }[];
  paths: string[];
}

export interface Suspect extends Change {
  reason: string;
  /** The paths that made it a suspect. */
  touched: string[];
  rank: number;
}

export interface RankInput {
  /** The failed item. */
  failed: { name: string; type: string };
  /** Names of the items in the root-cause chain below the failed item (the failing leaf first). */
  chainNames: string[];
  /** The local clone and its files, for the caller knowledge of fabric-testplan. */
  clone?: { root: string; files: string[] };
}

/** Group commits by pull request (a commit without one stands alone), newest first. */
export function groupChanges(commits: CommitInfo[], prs: Map<number, PrInfo>, byCommit: Map<string, number[]>): Change[] {
  const out: Change[] = [];
  const byPr = new Map<number, Change>();
  for (const c of commits) {
    const id = byCommit.get(c.commit)?.[0];
    if (id === undefined) {
      out.push({ title: c.title, commits: [c.commit], stories: [], paths: [...c.paths] });
      continue;
    }
    let g = byPr.get(id);
    if (!g) {
      const info = prs.get(id);
      g = { pr: id, title: info?.title ?? c.title, commits: [], stories: info?.stories ?? [], paths: [] };
      byPr.set(id, g);
      out.push(g);
    }
    g.commits.push(c.commit);
    for (const p of c.paths) if (!g.paths.includes(p)) g.paths.push(p);
  }
  return out;
}

const stem = (p: string) => basename(p).replace(/\.[^.]+$/, "").toLowerCase();

/** Suspect when a change touches (a) the failed item or the failing leaf, (b) an item the failed item calls, (c) a config file named like it. */
export function rank(changes: Change[], o: RankInput): { suspects: Suspect[]; unrelated: Change[] } {
  const failed = o.failed.name.toLowerCase();
  const leaf = o.chainNames.map((n) => n.toLowerCase()).filter((n) => n && n !== failed);
  const suspects: Suspect[] = [];
  const unrelated: Change[] = [];
  for (const ch of changes) {
    let hit: { rank: number; reason: string; touched: string[] } | undefined;
    const inItem = (names: string[]) => ch.paths.filter((p) => names.includes(itemFolder(p)?.name.toLowerCase() ?? "\u0000"));
    const a = inItem([failed]);
    const aLeaf = inItem(leaf);
    if (a.length) hit = { rank: 1, reason: `touches ${o.failed.name} (the item that failed)`, touched: a };
    else if (aLeaf.length) hit = { rank: 1, reason: `touches ${itemFolder(aLeaf[0])!.name} (the failing item in the root-cause chain)`, touched: aLeaf };
    if (!hit && o.clone && ch.paths.length) {
      const plan = buildTestPlan(o.clone.root, o.clone.files, ch.paths);
      const step = plan.steps.find((s) => s.item.name.toLowerCase() === failed && s.via);
      if (step?.via) {
        const touched = ch.paths.filter((p) => p.startsWith(`${step.via!.folder}/`));
        hit = { rank: 2, reason: `touches ${step.via.name}, which ${o.failed.name} calls${step.activity ? ` (activity ${step.activity})` : ""}`, touched: touched.length ? touched : ch.paths.slice(0, 1) };
      }
    }
    if (!hit) {
      const names = [failed, ...leaf];
      const cfg = ch.paths.filter((p) => !itemFolder(p) && names.includes(stem(p)));
      if (cfg.length) hit = { rank: 3, reason: `touches a configuration file named like ${stem(cfg[0])}`, touched: cfg };
    }
    if (hit) suspects.push({ ...ch, ...hit });
    else unrelated.push(ch);
  }
  suspects.sort((x, y) => x.rank - y.rank);
  return { suspects, unrelated };
}

/** "governance/, jobs/" for a compact unrelated line. */
export function areas(paths: string[], max = 3): string {
  const tops = [...new Set(paths.map((p) => (itemFolder(p) ? itemFolder(p)!.folder : p.includes("/") ? `${p.split("/")[0]}/` : p)))];
  return tops.length ? `${tops.slice(0, max).join(", ")}${tops.length > max ? ` and ${tops.length - max} more` : ""}` : "no files read";
}

export const short = (sha?: string) => (sha ? sha.slice(0, 7) : "-");
export const label = (c: Change) => (c.pr !== undefined ? `PR ${c.pr}` : `commit ${short(c.commits[0])}`);
export const storyText = (s: { id: number; title?: string }[]) => s.map((x) => `story ${x.id}${x.title ? ` "${x.title}"` : ""}`).join(", ");

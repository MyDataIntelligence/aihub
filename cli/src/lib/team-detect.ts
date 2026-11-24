import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseRemote, type AdoRemote } from "./ado.js";
import { repoClientAt, type Ctx } from "./context.js";
import { git, originDefaultBranch, remoteUrl, showFile } from "./git.js";
import { resolveTemplate } from "./templates.js";

/**
 * What aihub can find out about a team without team.yaml: git (remote, default branch, branch names), Azure DevOps
 * (work item types and states, branch policies) and, only with a Fabric token already at hand, the workspaces.
 * Every finding is {key, value, confidence, source}; a "guess" is asked, a "sure" one is used silently.
 * Results are cached per repository in the aihub home, so a command that misses one key pays once per day, not per call.
 */
export type Confidence = "sure" | "guess";
export interface Detection {
  key: string;
  value: unknown;
  confidence: Confidence;
  source: string;
  /** the other values found, for a question */
  choices?: string[];
}

export type Group = "git" | "template" | "workItems" | "policies" | "fabric";
const TTL_MS = 24 * 60 * 60 * 1000;

/** The group that can answer a key (undefined: nothing detects it). */
export function groupOf(key: string): Group | undefined {
  if (/^(azureDevOps\.|repositories\[0\]\.(name|defaultTarget|releaseBranches)$|branches\.feature$)/.test(key)) return "git";
  if (key === "pullRequest.template" || key === "language") return "template";
  if (/^workItems\.(storyType|states\.(active|finished))$/.test(key)) return "workItems";
  if (key === "branches.protected" || key === "pipelines") return "policies";
  if (key === "fabric.workspaces") return "fabric";
  return undefined;
}

const homeOf = (env: NodeJS.ProcessEnv) => env.AIHUB_HOME || join(homedir(), ".aihub");
const cachePath = (env: NodeJS.ProcessEnv) => join(homeOf(env), "team-detect.json");
type CacheFile = Record<string, { at: number; found: Detection[] }>;

function readCache(env: NodeJS.ProcessEnv): CacheFile {
  try {
    return JSON.parse(readFileSync(cachePath(env), "utf8")) as CacheFile;
  } catch {
    return {};
  }
}

/** Reads the file again before writing: the groups of `detectAll` finish in parallel and must not drop each other. */
function writeCache(env: NodeJS.ProcessEnv, id: string, entry: CacheFile[string]): void {
  const c = { ...readCache(env), [id]: entry };
  try {
    mkdirSync(dirname(cachePath(env)), { recursive: true });
    writeFileSync(cachePath(env), JSON.stringify(c), "utf8");
  } catch {
    /* a cache that cannot be written only costs a later call */
  }
}

/** Branch names of origin, without the origin/ prefix and HEAD. One git call. */
function remoteBranches(root: string): string[] {
  return git(root, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], { allowFail: true })
    .split("\n")
    .map((l) => l.trim().replace(/^origin\//, ""))
    .filter((b) => b && b !== "HEAD" && b !== "origin");
}

const STORY_TYPES = ["User Story", "Product Backlog Item", "Requirement", "Issue"];
const MAIN_NAMES = ["main", "master", "develop", "staging", "dev"];

/** git: organization, project, repository, default branch, release branches and the feature branch pattern. */
export function detectGit(root: string, remote: AdoRemote): Detection[] {
  const out: Detection[] = [
    { key: "azureDevOps.organization", value: remote.org, confidence: "sure", source: "git remote" },
    { key: "azureDevOps.project", value: remote.project, confidence: "sure", source: "git remote" },
    { key: "repositories[0].name", value: remote.repo, confidence: "sure", source: "git remote" },
  ];
  const branches = remoteBranches(root);
  const head = originDefaultBranch(root);
  if (head) out.push({ key: "repositories[0].defaultTarget", value: head, confidence: "sure", source: "origin/HEAD" });
  else {
    const c = MAIN_NAMES.filter((b) => branches.includes(b));
    if (c.length) out.push({ key: "repositories[0].defaultTarget", value: c[0], confidence: c.length === 1 ? "sure" : "guess", source: "remote branches", choices: c });
  }
  const rel = new Map<string, number>();
  for (const b of branches) {
    const m = /^(release|releases|rel|hotfix)\/./i.exec(b);
    if (m && m[1].toLowerCase() !== "hotfix") rel.set(`${m[1]}/*`, (rel.get(`${m[1]}/*`) ?? 0) + 1);
  }
  if (rel.size) {
    const pats = [...rel.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    out.push({ key: "repositories[0].releaseBranches", value: [pats[0]], confidence: "guess", source: `${rel.get(pats[0])} remote branch(es)`, choices: pats });
  }
  const feature = featurePattern(branches.filter((b) => !MAIN_NAMES.includes(b) && !/^(release|releases|rel)\//i.test(b)));
  if (feature) out.push(feature);
  return out;
}

/** The feature branch pattern most branches with a work item id follow ("feature/123-add-export" -> feature/{storyId}-{slug}). */
export function featurePattern(branches: string[]): Detection | undefined {
  const count = new Map<string, number>();
  let withId = 0;
  for (const b of branches) {
    const m = /^((?:[^/]+\/)*)([A-Za-z]+[-_]?)?(\d{2,})([-_])[A-Za-z0-9]/.exec(b);
    if (!m) continue;
    withId++;
    const pat = `${m[1]}${m[2] ?? ""}{storyId}${m[4]}{slug}`;
    count.set(pat, (count.get(pat) ?? 0) + 1);
  }
  if (!withId) return undefined;
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [pat, n] = ranked[0];
  const sure = n >= 3 && n / withId >= 0.8;
  return { key: "branches.feature", value: pat, confidence: sure ? "sure" : "guess", source: `${n} of ${withId} story branches`, choices: ranked.slice(0, 3).map((x) => x[0]) };
}

/** The PR template Azure DevOps already uses, and a language guess from its headings. No network. */
export function detectTemplate(root: string, target: string): Detection[] {
  const tpl = resolveTemplate(target, { readRef: (b, p) => showFile(root, b, p), localRoot: root });
  if (!tpl) return [];
  const out: Detection[] = [{ key: "pullRequest.template", value: tpl.path, confidence: "sure", source: tpl.from === "ref" ? `origin/${target}` : "working tree" }];
  const nl = (tpl.content.match(/\b(samenvatting|wijzigingen|beschrijving|testen|niet van toepassing|gewijzigd|waarom)\b/gi) ?? []).length;
  const en = (tpl.content.match(/\b(summary|changes|description|testing|tests|why|checklist)\b/gi) ?? []).length;
  if (nl || en) out.push({ key: "language", value: nl > en ? "nl" : "en", confidence: "guess", source: "PR template headings", choices: nl > en ? ["nl", "en"] : ["en", "nl"] });
  return out;
}

/** Story type and its active/finished states from the process of the project (two REST calls). */
export async function detectWorkItems(ctx: Ctx, root: string, storyType?: string): Promise<Detection[]> {
  const client = repoClientAt(ctx, root).client;
  const out: Detection[] = [];
  let type = storyType;
  if (!type) {
    // the type list can be closed to a user who may still read the states: then the default type is tried
    const names = await client.get<{ value?: { name: string }[] }>("wit/workitemtypes").then((r) => (r.value ?? []).map((x) => x.name), () => undefined);
    const found = STORY_TYPES.filter((t) => names?.includes(t));
    type = found[0] ?? "User Story";
    if (found.length) out.push({ key: "workItems.storyType", value: type, confidence: found.length === 1 ? "sure" : "guess", source: "process work item types", choices: found });
    else if (names) return out;
  }
  const s = await client.get<{ value?: { name: string; category?: string }[] }>(`wit/workitemtypes/${encodeURIComponent(type)}/states`);
  const list = s.value ?? [];
  for (const [key, cat] of [
    ["workItems.states.active", "InProgress"],
    ["workItems.states.finished", "Completed"],
  ] as const) {
    const names = list.filter((x) => x.category === cat).map((x) => x.name);
    if (names.length) out.push({ key, value: names[0], confidence: names.length === 1 ? "sure" : "guess", source: `states of ${type}`, choices: names });
  }
  return out;
}

interface PolicyConfig {
  isEnabled?: boolean;
  isBlocking?: boolean;
  isDeleted?: boolean;
  type?: { id?: string; displayName?: string };
  settings?: { displayName?: string; buildDefinitionId?: number; scope?: { refName?: string; matchKind?: string; repositoryId?: string | null }[] };
}

/** Protected branches (blocking branch policies) and the pipelines that validate them as a build policy. */
export async function detectPolicies(ctx: Ctx, root: string): Promise<Detection[]> {
  const client = repoClientAt(ctx, root).client;
  const repo = await client.get<{ id: string }>(client.repoPath());
  const all = await client.get<{ value?: PolicyConfig[] }>("policy/configurations");
  const mine = (all.value ?? []).filter((p) => p.isEnabled !== false && !p.isDeleted);
  const protectedSet = new Set<string>();
  const pipelines = new Set<string>();
  for (const p of mine) {
    for (const s of p.settings?.scope ?? []) {
      if (s.repositoryId && s.repositoryId !== repo.id) continue;
      if (!s.refName?.startsWith("refs/heads/")) continue;
      const branch = s.refName.slice("refs/heads/".length) + (s.matchKind?.toLowerCase() === "prefix" ? "*" : "");
      if (p.isBlocking) protectedSet.add(branch);
      if (p.type?.displayName === "Build" && p.settings?.displayName) pipelines.add(p.settings.displayName);
    }
  }
  const out: Detection[] = [];
  if (protectedSet.size) out.push({ key: "branches.protected", value: [...protectedSet], confidence: "sure", source: "branch policies" });
  // where the team really merges: the most common target of the last completed pull requests
  const prs = await client
    .get<{ value?: { targetRefName?: string }[] }>(`${client.repoPath()}/pullrequests`, { "searchCriteria.status": "completed", $top: 50 })
    .then((r) => r.value ?? [], () => []);
  const targets = new Map<string, number>();
  for (const pr of prs) if (pr.targetRefName?.startsWith("refs/heads/")) targets.set(pr.targetRefName.slice(11), (targets.get(pr.targetRefName.slice(11)) ?? 0) + 1);
  const ranked = [...targets.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length && ranked[0][1] >= 3) out.push({ key: "pullRequests.target", value: ranked[0][0], confidence: "guess", source: `${ranked[0][1]} of the last ${prs.length} completed PRs`, choices: ranked.slice(0, 3).map((x) => x[0]) });
  if (pipelines.size) out.push({ key: "pipelines", value: [...pipelines].map((name) => ({ repository: client.remote.repo, name, required: true })), confidence: "guess", source: "build validation policies" });
  return out;
}

/** A Fabric token that is already at hand (environment or the aihub token cache): never starts az or a sign-in. */
export function fabricTokenAtHand(env: NodeJS.ProcessEnv, now = Date.now(), cacheFile = join(tmpdir(), "aihub-fabric-token.json")): string | undefined {
  if (env.AIHUB_FABRIC_TOKEN) return env.AIHUB_FABRIC_TOKEN;
  try {
    const c = JSON.parse(readFileSync(cacheFile, "utf8")) as { token?: string; expiresAt?: number };
    return c.token && (c.expiresAt ?? 0) > now ? c.token : undefined;
  } catch {
    return undefined;
  }
}

/** Fabric workspaces whose name contains the repository name (one call, only with a token at hand). */
export async function detectFabric(ctx: Ctx, repo: string): Promise<Detection[]> {
  const token = fabricTokenAtHand(ctx.env, (ctx.now ?? Date.now)(), ctx.tokenCache && `${ctx.tokenCache}.fabric`);
  if (!token) return [];
  const res = await ctx.fetch("https://api.fabric.microsoft.com/v1/workspaces", { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!res.ok) return [];
  const j = (await res.json()) as { value?: { displayName: string }[] };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const names = (j.value ?? []).map((w) => w.displayName).filter((n) => norm(n).includes(norm(repo)));
  if (!names.length) return [];
  const env = (n: string) => (/(^|[^a-z])(prd|prod|production)([^a-z]|$)/i.test(n) ? "prd" : /(^|[^a-z])(acc|acceptance|uat)([^a-z]|$)/i.test(n) ? "acc" : /(^|[^a-z])(tst|test)([^a-z]|$)/i.test(n) ? "test" : "dev");
  return [{ key: "fabric.workspaces", value: names.map((name) => ({ name, environment: env(name) })), confidence: "guess", source: "Fabric workspaces named after the repository", choices: names }];
}

/** What earlier calls detected for this repository, from the cache only: no git, no network (aihub doctor). */
export function cachedDetections(env: NodeJS.ProcessEnv, remote: AdoRemote, now = Date.now()): Detection[] {
  const prefix = `${remote.org}/${remote.project}/${remote.repo}#`;
  return Object.entries(readCache(env))
    .filter(([id, e]) => id.startsWith(prefix) && now - e.at < TTL_MS)
    .flatMap(([, e]) => e.found);
}

/** Runs one group, through the cache. A group that fails (no sign-in, no network) detects nothing. */
export async function detectGroup(ctx: Ctx, root: string, group: Group, opts: { storyType?: string; target?: string; refresh?: boolean } = {}): Promise<Detection[]> {
  let remote: AdoRemote;
  try {
    remote = parseRemote(remoteUrl(root));
  } catch {
    return [];
  }
  const now = (ctx.now ?? Date.now)();
  if (group === "fabric" && !fabricTokenAtHand(ctx.env, now, ctx.tokenCache && `${ctx.tokenCache}.fabric`)) return []; // not cached: a later sign-in counts at once
  const base = `${remote.org}/${remote.project}/${remote.repo}#${group}`;
  const storyType = group === "workItems" ? opts.storyType : undefined;
  const id = `${base}${storyType ? `:${storyType}` : ""}`;
  const cache = readCache(ctx.env);
  const fresh = (k: string) => !opts.refresh && cache[k] && now - cache[k].at < TTL_MS;
  if (fresh(id)) return cache[id].found;
  // the states of the story type this repository detected before are the same answer
  if (storyType && fresh(base) && cache[base].found.some((d) => d.key === "workItems.storyType" && d.value === storyType)) return cache[base].found;
  let found: Detection[] = [];
  try {
    if (group === "git") found = detectGit(root, remote);
    else if (group === "template") found = detectTemplate(root, opts.target || originDefaultBranch(root) || "main");
    else if (group === "workItems") found = await detectWorkItems(ctx, root, opts.storyType);
    else if (group === "policies") found = await detectPolicies(ctx, root);
    else found = await detectFabric(ctx, remote.repo);
  } catch {
    return []; // not cached: the next call may be signed in
  }
  if (group !== "template") writeCache(ctx.env, id, { at: now, found }); // the template is read locally every time
  return found;
}

/** Detects one key; undefined when nothing finds it. */
export async function detectKey(ctx: Ctx, root: string, key: string, opts: { storyType?: string; target?: string } = {}): Promise<Detection | undefined> {
  const g = groupOf(key);
  if (!g) return undefined;
  return (await detectGroup(ctx, root, g, opts)).find((d) => d.key === key);
}

/** Every group (aihub team setup). Fabric only with a token at hand. */
export async function detectAll(ctx: Ctx, root: string, opts: { storyType?: string; refresh?: boolean } = {}): Promise<Detection[]> {
  const gitFound = await detectGroup(ctx, root, "git", opts);
  const target = gitFound.find((d) => d.key === "repositories[0].defaultTarget")?.value as string | undefined;
  const rest = await Promise.all([
    detectGroup(ctx, root, "template", { ...opts, target }),
    detectGroup(ctx, root, "workItems", opts),
    detectGroup(ctx, root, "policies", opts),
    detectGroup(ctx, root, "fabric", opts),
  ]);
  // the default branch is always protected, also when no branch policy guards it
  const all = [...gitFound, ...rest.flat()].map((d) =>
    d.key === "branches.protected" && target && !(d.value as string[]).includes(target) ? { ...d, value: [target, ...(d.value as string[])], source: `default branch and ${d.source}` } : d,
  );
  // pull requests that mostly go to another branch than origin/HEAD: the PR target is a question, not a fact
  const pr = all.find((d) => d.key === "pullRequests.target");
  const rest2 = all.filter((d) => d.key !== "pullRequests.target");
  if (!pr || !target || pr.value === target) return rest2;
  return rest2.map((d) =>
    d.key === "repositories[0].defaultTarget" ? { ...d, value: pr.value, confidence: "guess" as const, source: `${pr.source}; origin/HEAD is ${target}`, choices: [...new Set([String(pr.value), target, ...(pr.choices ?? [])])].slice(0, 3) } : d,
  );
}

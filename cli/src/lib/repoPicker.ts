import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { repoRoot } from "./git.js";
import { tryGit } from "./gitx.js";
import { chooseClone, samePath } from "./cloneChoice.js";
import { configHome } from "./notifyPolicy.js";
import { loadTeam, type TeamConfig } from "./team.js";

/**
 * The repo opener: every repository you could open as a set, local and in Azure DevOps. The local list is read from
 * the file system only (`.git/HEAD` for the branch, `.git/config` for the origin): no git process per repository.
 * The Azure DevOps list comes from the API (per project in team.yaml, else every project you can see) and is cached
 * for a few hours; it is read only when someone asks (the picker opens), never in the background.
 */

export interface LocalRepo {
  name: string;
  path: string;
  /** "" when detached */
  branch: string;
  remoteUrl?: string;
  /** `org/project/repo` of an Azure DevOps origin, lower case */
  key?: string;
  project?: string;
  /** the other clones of the same remote on this PC; this one is used (see dedupeClones) */
  otherClones?: string[];
}

export interface AdoRepo {
  project: string;
  name: string;
  id: string;
  remoteUrl: string;
  defaultBranch: string;
  key: string;
  /** the local clone, when there is one */
  path?: string;
  branch?: string;
  otherClones?: string[];
}

// ---- pure ------------------------------------------------------------------------------------------------------

export const branchFromHead = (head: string): string => /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1].trim() ?? "";

export function originFromConfig(config: string): string | undefined {
  const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(.+)/.exec(config);
  return m?.[1].trim();
}

/** `org/project/repo` (lower case) of an Azure DevOps URL in its https, old visualstudio.com or ssh form. */
export function adoKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let u = url.trim();
  try {
    u = decodeURIComponent(u);
  } catch {
    /* a stray % in a url must not break the whole list of clones */
  }
  u = u.replace(/\.git$/, "");
  const m =
    /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i.exec(u) ??
    /ssh\.dev\.azure\.com[:/]v3\/([^/]+)\/([^/]+)\/([^/?#]+)/i.exec(u) ??
    (() => {
      const v = /([^/.@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i.exec(u);
      return v;
    })();
  return m ? `${m[1]}/${m[2]}/${m[3]}`.toLowerCase() : undefined;
}

/** Joins the Azure DevOps list with the local clones (same origin, else the same name under the repos root). */
export function joinAdoLocal(ado: Omit<AdoRepo, "path" | "branch">[], local: LocalRepo[], reposRoot?: string): AdoRepo[] {
  return ado.map((a) => {
    const l = local.find((x) => x.key === a.key) ?? (reposRoot ? local.find((x) => samePath(x.path, join(reposRoot, a.name))) : undefined);
    return l ? { ...a, path: l.path, branch: l.branch, ...(l.otherClones ? { otherClones: l.otherClones } : {}) } : { ...a };
  });
}


/** One key per remote: the Azure DevOps key, else host/path of any URL (https and ssh alike), lower case. */
export function remoteKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const ado = adoKey(url);
  if (ado) return ado;
  const u = url.trim();
  const m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(u) ?? /^[^@\s/]+@([^:/]+):(.+?)(?:\.git)?\/?$/.exec(u);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

export { repoNameOfUrl } from "./repoName.js";

/** When a clone was last used: the newest of .git/index and .git/HEAD (git writes them on status, commit, switch). */
export function usedAt(dir: string): number {
  let t = 0;
  for (const f of ["index", "HEAD"]) {
    try {
      t = Math.max(t, statSync(join(dir, ".git", f)).mtimeMs);
    } catch {
      /* missing: never used */
    }
  }
  return t;
}

/**
 * One repository is one entry, however often it is cloned: the branch is chosen afterwards, so which clone is used
 * does not matter. Per remote the clone used is the preferred one (`aihub repos prefer`), else the most recently used,
 * else the shortest path; the others go to `otherClones`. Clones without an origin stay apart. Worktrees never get
 * here (readLocal skips them).
 */
export function dedupeClones(repos: LocalRepo[], prefer: Record<string, string> = {}, used: (dir: string) => number = usedAt, rank?: (dir: string) => number): LocalRepo[] {
  const groups = new Map<string, LocalRepo[]>();
  for (const r of repos) {
    const k = remoteKey(r.remoteUrl) ?? `path:${r.path.toLowerCase()}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const preferOf = (names: string[]) => {
    const n = Object.keys(prefer).find((p) => names.some((x) => x.toLowerCase() === p.toLowerCase()));
    return n ? prefer[n] : undefined;
  };
  return [...groups.entries()]
    .map(([k, list]) => {
      if (list.length === 1) return list[0];
      const want = preferOf([k.split("/").pop()!, ...list.map((r) => r.name)]);
      const at = new Map(list.map((r) => [r, used(r.path)]));
      const chosenPath = chooseClone(list.map((r) => ({ path: r.path, lastUsed: at.get(r)!, rank: rank?.(r.path) })), want);
      const chosen = list.find((r) => r.path === chosenPath)!;
      return { ...chosen, otherClones: list.filter((r) => r !== chosen).map((r) => r.path) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- personal clone preference ----------------------------------------------------------------------------------

const prefFile = (env: NodeJS.ProcessEnv) => join(configHome(env), "repos.json");

/** `aihub repos prefer`: repository name -> the clone to use when there are several. Personal, never in team.yaml. */
export function readPreferredClones(env: NodeJS.ProcessEnv): Record<string, string> {
  try {
    return (JSON.parse(readFileSync(prefFile(env), "utf8")) as { prefer?: Record<string, string> }).prefer ?? {};
  } catch {
    return {};
  }
}

export function setPreferredClone(env: NodeJS.ProcessEnv, name: string, dir: string | undefined): Record<string, string> {
  let all: { prefer?: Record<string, string> } = {};
  try {
    all = JSON.parse(readFileSync(prefFile(env), "utf8"));
  } catch {
    /* first preference */
  }
  const prefer = { ...(all.prefer ?? {}) };
  for (const k of Object.keys(prefer)) if (k.toLowerCase() === name.toLowerCase()) delete prefer[k];
  if (dir) {
    if (!existsSync(join(dir, ".git"))) throw new AihubError(`${dir} is not a git clone`);
    prefer[name] = resolve(dir);
  }
  mkdirSync(configHome(env), { recursive: true });
  writeFileSync(prefFile(env), JSON.stringify({ ...all, prefer }, null, 2), "utf8");
  return prefer;
}

// ---- local -----------------------------------------------------------------------------------------------------

function gitDir(dir: string): string | undefined {
  const g = join(dir, ".git");
  try {
    if (statSync(g).isDirectory()) return g;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, "utf8"));
    return m ? resolve(dir, m[1].trim()) : undefined;
  } catch {
    return undefined;
  }
}

/** One clone, read from its files. A linked worktree is skipped (it belongs to a set, not to the list of repositories). */
export function readLocal(dir: string): LocalRepo | undefined {
  const g = gitDir(dir);
  if (!g || existsSync(join(g, "commondir"))) return undefined;
  let branch = "";
  let remoteUrl: string | undefined;
  try {
    branch = branchFromHead(readFileSync(join(g, "HEAD"), "utf8"));
  } catch {
    /* no HEAD: an empty or broken clone still shows */
  }
  try {
    remoteUrl = originFromConfig(readFileSync(join(g, "config"), "utf8"));
  } catch {
    /* no config */
  }
  const key = adoKey(remoteUrl);
  return { name: basename(dir), path: resolve(dir), branch, remoteUrl: remoteUrl?.replace(/^(https?:\/\/)[^@/]+@/, "$1"), key, project: key?.split("/")[1] };
}

/** The clones under the roots (two levels deep), plus the known ones; worktree and set folders are not descended into. */
export function scanLocal(roots: string[], known: string[] = [], depth = 2): LocalRepo[] {
  const out = new Map<string, LocalRepo>();
  const add = (r: LocalRepo | undefined) => r && !out.has(r.path.toLowerCase()) && out.set(r.path.toLowerCase(), r);
  const walk = (d: string, level: number) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".") || n === "node_modules" || n === "worktrees") continue;
      const p = join(d, n);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (existsSync(join(p, ".git"))) add(readLocal(p));
      else if (level < depth) walk(p, level + 1);
    }
  };
  for (const r of roots) if (r && existsSync(r)) walk(resolve(r), 1);
  for (const k of known) add(readLocal(k));
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** --root, else team.yaml `reposRoot` (relative to the repository), else the folder the current repository is in. */
export function reposRootOf(cwd: string, override?: string): string | undefined {
  if (override) return resolve(override);
  let root: string | undefined;
  try {
    root = repoRoot(cwd);
  } catch {
    return undefined;
  }
  const t = loadTeam(root) as TeamConfig & { reposRoot?: string };
  return t.reposRoot ? resolve(root, t.reposRoot) : dirname(root);
}

/** The repositories team.yaml and the saved groups know about, also when they are not under the repos root. */
function knownRepos(cwd: string): string[] {
  try {
    const root = repoRoot(cwd);
    const t = loadTeam(root);
    return [root, ...(t.repositories ?? []).map((r) => (r as { path?: string }).path).filter((p): p is string => !!p).map((p) => resolve(root, p))];
  } catch {
    return [];
  }
}

/** The clones under the repos root, one per remote (`all`: every clone). */
export function localRepos(ctx: Ctx, o: { root?: string; all?: boolean } = {}): { root?: string; repos: LocalRepo[] } {
  const root = reposRootOf(ctx.cwd, o.root);
  const repos = scanLocal(root ? [root] : [], knownRepos(ctx.cwd));
  return { root, repos: o.all ? repos : dedupeClones(repos, readPreferredClones(ctx.env)) };
}

// ---- Azure DevOps ----------------------------------------------------------------------------------------------

export const ADO_CACHE_HOURS = 4;
const cacheFile = (env: NodeJS.ProcessEnv) => join(configHome(env), "cache", "ado-repos.json");

interface Cache {
  at: number;
  org: string;
  repos: Omit<AdoRepo, "path" | "branch">[];
}

/** Every repository of the projects in team.yaml (`projects`), else of every project you can see; cached for a few hours. */
export async function adoRepos(ctx: Ctx, o: { refresh?: boolean; now?: number } = {}): Promise<{ cached: boolean; at: number; repos: Omit<AdoRepo, "path" | "branch">[] }> {
  const { root, client } = repoClient(ctx);
  const org = client.remote.org;
  const now = o.now ?? Date.now();
  const file = cacheFile(ctx.env);
  if (!o.refresh) {
    try {
      const c = JSON.parse(readFileSync(file, "utf8")) as Cache;
      if (c.org === org && now - c.at < ADO_CACHE_HOURS * 3_600_000) return { cached: true, at: c.at, repos: c.repos };
    } catch {
      /* no cache yet */
    }
  }
  const team = loadTeam(root) as TeamConfig & { projects?: string[] };
  const repos: Cache["repos"] = [];
  type Raw = { id: string; name: string; remoteUrl?: string; defaultBranch?: string; isDisabled?: boolean; project?: { name?: string } };
  const add = (project: string, r: Raw) => {
    if (r.isDisabled) return;
    const remoteUrl = (r.remoteUrl ?? "").replace(/^(https?:\/\/)[^@/]+@/, "$1");
    repos.push({ project, name: r.name, id: r.id, remoteUrl, defaultBranch: (r.defaultBranch ?? "").replace(/^refs\/heads\//, ""), key: adoKey(remoteUrl) ?? `${org}/${project}/${r.name}`.toLowerCase() });
  };
  // without a project list: one call for every repository of the organisation you can see
  const projects = team.projects?.length ? team.projects : [];
  if (!projects.length) for (const r of (await client.getOrg<{ value?: Raw[] }>("git/repositories")).value ?? []) add(r.project?.name ?? "", r);
  for (const project of projects) {
    let list: Raw[] = [];
    try {
      list = (await client.forProject(project).get<{ value?: Raw[] }>("git/repositories")).value ?? [];
    } catch {
      continue; // a project you cannot read is left out, the others still show
    }
    for (const r of list) add(project, r);
  }
  repos.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ at: now, org, repos } satisfies Cache), "utf8");
  return { cached: false, at: now, repos };
}

// ---- clone -----------------------------------------------------------------------------------------------------

export interface CloneResult {
  repo: string;
  project: string;
  path: string;
  status: "cloned" | "already there" | "failed";
  error?: string;
}

/** Clones `project/name` (or `name`) repositories into the repos root; a folder that exists is never touched. */
export async function cloneRepos(ctx: Ctx, specs: string[], o: { root?: string } = {}): Promise<CloneResult[]> {
  if (!specs.length) throw new AihubError("aihub repos clone needs --repos <project/name>[,<project/name>]");
  const root = reposRootOf(ctx.cwd, o.root);
  if (!root) throw new AihubError("no repos root: pass --root <folder>, set reposRoot in team.yaml, or run this inside a clone");
  const { repos } = await adoRepos(ctx);
  const pat = ctx.env.AIHUB_ADO_PAT;
  const auth = pat ? ["-c", `http.extraheader=Authorization: Basic ${Buffer.from(`:${pat}`).toString("base64")}`] : [];
  const out: CloneResult[] = [];
  for (const s of specs) {
    const [p, n] = s.includes("/") ? [s.slice(0, s.lastIndexOf("/")), s.slice(s.lastIndexOf("/") + 1)] : ["", s];
    const r = repos.find((x) => x.name.toLowerCase() === n.toLowerCase() && (!p || x.project.toLowerCase() === p.toLowerCase()));
    if (!r) {
      out.push({ repo: n, project: p, path: "", status: "failed", error: `not found in Azure DevOps${p ? ` project ${p}` : ""}` });
      continue;
    }
    const dir = join(root, r.name);
    if (existsSync(dir)) {
      out.push({ repo: r.name, project: r.project, path: dir, status: "already there" });
      continue;
    }
    mkdirSync(root, { recursive: true });
    const res = tryGit(root, [...auth, "clone", "--quiet", r.remoteUrl, dir]);
    out.push(res.ok ? { repo: r.name, project: r.project, path: dir, status: "cloned" } : { repo: r.name, project: r.project, path: dir, status: "failed", error: res.err.split("\n").filter(Boolean).slice(-2).join(" ") || "git clone failed" });
  }
  return out;
}

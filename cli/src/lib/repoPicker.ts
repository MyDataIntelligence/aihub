import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { repoRoot } from "./git.js";
import { tryGit } from "./gitx.js";
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
  const u = decodeURIComponent(url.trim()).replace(/\.git$/, "");
  const m =
    /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i.exec(u) ??
    /ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/?#]+)/i.exec(u) ??
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
    return l ? { ...a, path: l.path, branch: l.branch } : { ...a };
  });
}

const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

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

export function localRepos(ctx: Ctx, o: { root?: string } = {}): { root?: string; repos: LocalRepo[] } {
  const root = reposRootOf(ctx.cwd, o.root);
  return { root, repos: scanLocal(root ? [root] : [], knownRepos(ctx.cwd)) };
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
  const projects = team.projects?.length ? team.projects : ((await client.getOrg<{ value?: { name: string; state?: string }[] }>("projects", { $top: 500 })).value ?? []).filter((p) => !p.state || p.state === "wellFormed").map((p) => p.name);
  const repos: Cache["repos"] = [];
  for (const project of projects) {
    let list: { id: string; name: string; remoteUrl?: string; defaultBranch?: string; isDisabled?: boolean }[] = [];
    try {
      list = (await client.forProject(project).get<{ value?: typeof list }>("git/repositories")).value ?? [];
    } catch {
      continue; // a project you cannot read is left out, the others still show
    }
    for (const r of list) {
      if (r.isDisabled) continue;
      const remoteUrl = (r.remoteUrl ?? "").replace(/^(https?:\/\/)[^@/]+@/, "$1");
      repos.push({ project, name: r.name, id: r.id, remoteUrl, defaultBranch: (r.defaultBranch ?? "").replace(/^refs\/heads\//, ""), key: adoKey(remoteUrl) ?? `${org}/${project}/${r.name}`.toLowerCase() });
    }
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

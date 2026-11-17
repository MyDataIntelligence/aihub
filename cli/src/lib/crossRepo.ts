import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AdoClient, parseRemote, type AdoRemote, type PullRequest } from "./ado.js";
import { makeAuth } from "./auth.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { git, gitRaw, remoteUrl, repoRoot } from "./git.js";
import type { TeamConfig } from "./team.js";

export interface PathMapping {
  from: string;
  to: string;
}
export interface CrossRepoConfig {
  pathMaps?: Record<string, PathMapping[]>;
  testTarget?: { repo?: string; branch?: string };
  testResources?: { fromRepo?: string; paths?: string[]; toPath?: string };
}
export interface RepoEntry {
  name?: string;
  aliases?: string[];
  defaultTarget?: string;
  /** Optional local clone path (absolute, or relative to the current repository root). */
  path?: string;
}

export const crossRepoConfig = (team: TeamConfig): CrossRepoConfig => (team.crossRepo as CrossRepoConfig | undefined) ?? {};
const repoEntries = (team: TeamConfig): RepoEntry[] => (team.repositories ?? []) as RepoEntry[];

/** Repository entry by name or alias (case-insensitive). */
export function findRepoEntry(team: TeamConfig, nameOrAlias: string): RepoEntry | undefined {
  const n = nameOrAlias.toLowerCase();
  return repoEntries(team).find((r) => r.name?.toLowerCase() === n || (r.aliases ?? []).some((a) => a.toLowerCase() === n));
}

export const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-");

const normDir = (d: string) => d.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+|\/+$/g, "").replace(/^\.$/, "");

/** Parse `src=>dst` (also `src->dst`). `.` or empty stands for the repository root. */
export function parsePathMap(spec: string): PathMapping {
  const m = /^(.*?)\s*(?:=>|->)\s*(.*)$/.exec(spec);
  if (!m) throw new AihubError(`--path-map '${spec}' must look like 'srcDir=>dstDir'`);
  return { from: normDir(m[1]), to: normDir(m[2]) };
}

export interface Mapped {
  mapped: { from: string; to: string }[];
  unmapped: string[];
}

/** Rewrite file paths: longest matching source prefix wins. With no mappings paths stay as they are. */
export function mapPaths(files: string[], maps: PathMapping[]): Mapped {
  if (!maps.length) return { mapped: files.map((f) => ({ from: f, to: f })), unmapped: [] };
  const sorted = maps.map((m) => ({ from: normDir(m.from), to: normDir(m.to) })).sort((a, b) => b.from.length - a.from.length);
  const out: Mapped = { mapped: [], unmapped: [] };
  for (const f of files) {
    const hit = sorted.find((m) => m.from === "" || f === m.from || f.startsWith(`${m.from}/`));
    if (!hit) {
      out.unmapped.push(f);
      continue;
    }
    const rest = hit.from === "" ? f : f.slice(hit.from.length).replace(/^\//, "");
    out.mapped.push({ from: f, to: [hit.to, rest].filter(Boolean).join("/") });
  }
  return out;
}

export interface RepoHandle {
  /** Azure DevOps repository name. */
  name: string;
  root: string;
  client: AdoClient;
  /** Remove a temporary clone (no-op for a real checkout). */
  release: () => void;
}

export function clientForRepo(ctx: Ctx, base: AdoRemote, repo: string): AdoClient {
  const auth = makeAuth({ env: ctx.env, exec: ctx.exec, cacheFile: ctx.tokenCache });
  return new AdoClient({ ...base, repo }, auth, ctx.fetch);
}

function repoNameAt(dir: string): string | undefined {
  try {
    return parseRemote(remoteUrl(dir)).repo.toLowerCase();
  } catch {
    return undefined;
  }
}

const isGitDir = (d: string) => existsSync(join(d, ".git"));

/** Local clone of `name`: current repo, entry path, a sibling directory, else a temporary clone of the same organisation. */
export function resolveRepo(ctx: Ctx, team: TeamConfig, nameOrAlias: string): RepoHandle {
  const here = repoRoot(ctx.cwd);
  const hereRemote = parseRemote(remoteUrl(here));
  const entry = findRepoEntry(team, nameOrAlias);
  const name = entry?.name ?? nameOrAlias;
  const mk = (root: string, release: () => void = () => {}): RepoHandle => ({ name, root, client: clientForRepo(ctx, hereRemote, name), release });
  if (hereRemote.repo.toLowerCase() === name.toLowerCase()) return mk(here);
  if (entry?.path) {
    const p = isAbsolute(entry.path) ? entry.path : resolve(here, entry.path);
    if (isGitDir(p)) return mk(repoRoot(p));
    throw new AihubError(`repositories[] path '${entry.path}' for '${name}' is not a git clone`);
  }
  const parent = dirname(here);
  try {
    for (const d of readdirSync(parent, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(parent, d.name);
      if (isGitDir(p) && repoNameAt(p) === name.toLowerCase()) return mk(p);
    }
  } catch {
    /* fall through to a temporary clone */
  }
  return tempClone(here, name, mk);
}

/** Same remote URL with the repository segment replaced. */
export function swapRepoInUrl(url: string, oldRepo: string, newRepo: string): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(/)(?:${esc(oldRepo)}|${esc(encodeURIComponent(oldRepo))})((?:\\.git)?/?(?:[?#].*)?)$`);
  if (!re.test(url)) throw new AihubError(`cannot derive the remote of '${newRepo}' from '${url}'`);
  return url.replace(re, (_m, s: string, tail: string) => `${s}${encodeURIComponent(newRepo)}${tail}`);
}

function tempClone(here: string, name: string, mk: (root: string, release: () => void) => RepoHandle): RepoHandle {
  const url = swapRepoInUrl(remoteUrl(here), parseRemote(remoteUrl(here)).repo, name);
  // carry url.<base>.insteadOf rewrites so the clone resolves the way the user's own git does
  const rewrites = git(here, ["config", "--get-regexp", "^url\\..*\\.insteadof$"], { allowFail: true })
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(" ");
      return [l.slice(0, i), l.slice(i + 1)] as const;
    });
  const base = mkdtempSync(join(tmpdir(), "aihub-clone-"));
  const dir = join(base, name);
  const r = gitRaw(base, [...rewrites.flatMap(([k, v]) => ["-c", `${k}=${v}`]), "clone", "--quiet", url, dir]);
  if (r.status !== 0) {
    rmSync(base, { recursive: true, force: true });
    throw new AihubError(`repository '${name}' is not cloned next to this one and cloning failed: ${r.stderr.split("\n")[0]}`);
  }
  for (const [k, v] of rewrites) gitRaw(dir, ["config", k, v]);
  // the clone commits as the same person as the checkout it was derived from
  for (const k of ["user.name", "user.email", "commit.gpgsign"]) {
    const v = git(here, ["config", "--get", k], { allowFail: true }).trim();
    if (v) gitRaw(dir, ["config", k, v]);
  }
  return mk(dir, () => rmSync(base, { recursive: true, force: true }));
}

export interface StoryPr extends PullRequest {
  repository?: { id?: string; name?: string; project?: { id?: string } };
}

/** PRs linked to a story through artifact links; project-wide so every repository counts. */
export async function storyPrs(base: AdoClient, story: number): Promise<StoryPr[]> {
  const wi = await base.get<{ relations?: { rel: string; url: string }[] }>(`wit/workitems/${story}`, { $expand: "relations" });
  const ids = new Set<number>();
  for (const rel of wi.relations ?? []) {
    if (rel.rel !== "ArtifactLink") continue;
    const m = /PullRequestId\/.*?(\d+)$/i.exec(decodeURIComponent(rel.url));
    if (m) ids.add(Number(m[1]));
  }
  const out: StoryPr[] = [];
  for (const id of [...ids].sort((a, b) => a - b)) out.push(await base.get<StoryPr>(`git/pullrequests/${id}`));
  return out;
}

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Repo } from "./core";

/**
 * One repository is one line in the repo pickers, however often it is cloned on this PC: the branch is chosen
 * afterwards, so which clone is used does not matter. Clones are grouped by their origin URL; worktrees are never
 * listed (findRepos only takes folders with a .git directory). No process: .git/config is read and two files stat'ed.
 */
export interface UniqueRepo extends Repo {
  /** The other clones of the same remote, when there are more. */
  otherClones?: string[];
}

/** The same key for every spelling of one remote: https/ssh, dev.azure.com/visualstudio.com, user@, .git, case. */
export function remoteKey(url: string): string | undefined {
  const u = url.trim();
  if (!u) return undefined;
  let m: RegExpExecArray | null;
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s; // a stray % in a name must not break the whole list
    }
  };
  const ado = (org: string, project: string, repo: string) => `azure/${[org, project, repo].map((s) => decode(s).toLowerCase()).join("/")}`;
  if ((m = /^(?:ssh:\/\/)?(?:[^@\s]+@)?(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/](?:v3\/)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(u))) return ado(m[1], m[2], m[3]);
  if ((m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(u))) return ado(m[1], m[2], m[3]);
  if ((m = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(u))) return ado(m[1], m[2], m[3]);
  // other hosts: scheme://[user@]host[:port]/path or user@host:path
  if ((m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(u))) return `${m[1]}/${m[2]}`.toLowerCase();
  if ((m = /^[^@\s/]+@([^:/]+):(.+?)(?:\.git)?\/?$/.exec(u))) return `${m[1]}/${m[2]}`.toLowerCase();
  // a local path as origin
  return path.resolve(u).replace(/[\\/]+$/, "").toLowerCase();
}

/** The url of remote "origin" from .git/config, without starting git. */
export async function originUrl(folder: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await fs.promises.readFile(path.join(folder, ".git", "config"), "utf8");
  } catch {
    return undefined;
  }
  let inOrigin = false;
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line);
    if (section) {
      inOrigin = /^remote\s+"origin"$/i.test(section[1]);
      continue;
    }
    const kv = inOrigin ? /^\s*url\s*=\s*(.+?)\s*$/i.exec(line) : null;
    if (kv) return kv[1];
  }
  return undefined;
}

/** When the clone was last used: the newest of .git/index and .git/HEAD (git writes them on status, commit, switch). */
async function lastUsed(folder: string): Promise<number> {
  let t = 0;
  for (const f of ["index", "HEAD"]) {
    try {
      t = Math.max(t, (await fs.promises.stat(path.join(folder, ".git", f))).mtimeMs);
    } catch {
      /* missing: never used */
    }
  }
  return t;
}

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** The clone to use: the preferred one, else the most recently used, else the shortest path. */
export function chooseClone(clones: { path: string; lastUsed: number }[], preferred?: string): string {
  if (preferred) {
    const hit = clones.find((c) => samePath(c.path, preferred));
    if (hit) return hit.path;
  }
  return [...clones].sort((a, b) => b.lastUsed - a.lastUsed || a.path.length - b.path.length || a.path.localeCompare(b.path))[0].path;
}

/**
 * One entry per remote. `prefer` maps a repository name (the last part of the remote, or the folder name) to the clone
 * the user wants (`aihub repos prefer <name> <path>`). Order follows the first clone of each remote in `repos`.
 */
export async function uniqueRepos(repos: Repo[], prefer: Record<string, string> = {}, info?: (folder: string) => Promise<{ url?: string; lastUsed: number }>): Promise<UniqueRepo[]> {
  const read = info ?? (async (folder: string) => ({ url: await originUrl(folder), lastUsed: await lastUsed(folder) }));
  const groups = new Map<string, { repos: Repo[]; used: number[]; name: string }>();
  for (const r of repos) {
    const i = await read(r.path);
    const key = (i.url && remoteKey(i.url)) || `path:${path.resolve(r.path).toLowerCase()}`;
    const g = groups.get(key) ?? { repos: [], used: [], name: key.startsWith("path:") ? path.basename(r.path) : key.split("/").pop()! };
    g.repos.push(r);
    g.used.push(i.lastUsed);
    groups.set(key, g);
  }
  const preferOf = (name: string, folder: string) => {
    const k = Object.keys(prefer).find((n) => n.toLowerCase() === name.toLowerCase() || n.toLowerCase() === folder.toLowerCase());
    return k ? prefer[k] : undefined;
  };
  return [...groups.values()].map((g) => {
    if (g.repos.length === 1) return g.repos[0];
    const chosen = chooseClone(g.repos.map((r, i) => ({ path: r.path, lastUsed: g.used[i] })), preferOf(g.name, path.basename(g.repos[0].path)));
    const main = g.repos.find((r) => r.path === chosen)!;
    return { ...main, otherClones: g.repos.filter((r) => r !== main).map((r) => r.path) };
  });
}

/** A quick-pick line: the name, "+N more" only when there are more clones, and their paths in the detail. */
export function cloneItem(r: UniqueRepo): { label: string; description: string; detail?: string } {
  const more = r.otherClones?.length ?? 0;
  return more ? { label: r.name, description: `${r.path}  +${more} more`, detail: `also cloned at ${r.otherClones!.join(", ")}` } : { label: r.name, description: r.path };
}

/** The personal clone preferences of `aihub repos prefer` (<aihub config home>/repos.json); {} when there are none. */
export function readPreferredClones(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const home = env.AIHUB_CONFIG_HOME || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "aihub");
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, "repos.json"), "utf8")) as { prefer?: Record<string, string> };
    return j.prefer ?? {};
  } catch {
    return {};
  }
}

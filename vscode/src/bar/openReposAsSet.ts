/**
 * "Open as Set…" (the repository browser) and "New Set…" (the title bar): several repositories, cloned or not, each on its own
 * branch, as ONE set through `aihub worktree open`. This file is the pure part (no vscode): the argument, which local clone is
 * which repository, the CLI arguments and the answer. The flow is in openReposAsSetUi.ts.
 */

export interface SetRepoArg {
  /** the repository name (as Azure DevOps names it) */
  name: string;
  project?: string;
  /** needed to clone it when it is not on this PC */
  remoteUrl?: string;
  /** an existing branch to open */
  branch?: string;
  /** a branch to make (from `from`, else the repository's target branch); an existing one with that name is used */
  newBranch?: string;
  from?: string;
}

export interface OpenReposArg {
  repos: SetRepoArg[];
  story?: number;
  window?: "new" | "this";
  /** the shared new branch of every repository that names none of its own */
  newBranch?: string;
  /** the base of the shared new branch */
  from?: string;
}

export type OpenReposErrorKind = "badInput" | "cancelled" | "failed" | "cliMissing" | "cliTooOld";

export interface OpenReposRow {
  repo: string;
  ok: boolean;
  branch: string;
  /** the folder of this repository in the set */
  path?: string;
  /** true when it was cloned for this set */
  cloned?: boolean;
  /** what happened (CLI state: created, existing, reused-worktree, moved, recreated, ...) */
  state?: string;
  /** one sentence when ok is false */
  error?: string;
}

export interface OpenReposResult {
  story?: number;
  /** the set folder (absent when nothing could be opened) */
  folder?: string;
  workspace?: string;
  /** the window was asked to open the set */
  opened: boolean;
  /** the story already had a set: that set was opened, nothing was made */
  existingSet?: { id: string; folder: string };
  repos: OpenReposRow[];
}

export interface OpenReposError {
  error: { kind: OpenReposErrorKind; message: string };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const posInt = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
};

/** The argument checked and trimmed; a sentence for what is missing. */
export function parseOpenRepos(a: unknown): OpenReposArg | { problem: string } {
  const o = (a ?? {}) as Record<string, unknown>;
  const list = Array.isArray(o.repos) ? o.repos : [];
  if (!list.length) return { problem: "which repositories? ({ repos: [{ name, remoteUrl?, branch? | newBranch? }] })" };
  const newBranch = str(o.newBranch);
  const repos: SetRepoArg[] = [];
  const seen = new Set<string>();
  for (const x of list) {
    const r = (x ?? {}) as Record<string, unknown>;
    const name = str(r.name);
    if (!name) return { problem: "every repository needs a name" };
    if (seen.has(name.toLowerCase())) return { problem: `${name} is in the list twice` };
    seen.add(name.toLowerCase());
    const row: SetRepoArg = { name, project: str(r.project), remoteUrl: str(r.remoteUrl), branch: str(r.branch), newBranch: str(r.newBranch), from: str(r.from) };
    if (!row.branch && !row.newBranch && !newBranch) return { problem: `${name}: which branch? (branch, newBranch, or a shared newBranch for the set)` };
    repos.push(row);
  }
  const window = o.window === "this" ? "this" : o.window === "new" ? "new" : undefined;
  return { repos, story: posInt(o.story), window, newBranch, from: str(o.from) };
}

/** `org/project/repo` of an Azure DevOps url (https, user@, visualstudio.com, ssh), lower case; else the url without user and .git. */
export function remoteKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let u = url.trim();
  try {
    u = decodeURIComponent(u);
  } catch {
    /* keep it as it is */
  }
  u = u.replace(/\.git$/i, "").replace(/\/+$/, "");
  const m =
    /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i.exec(u) ??
    /ssh\.dev\.azure\.com[:/]v3\/([^/]+)\/([^/]+)\/([^/?#]+)/i.exec(u) ??
    /([^/.@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i.exec(u);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`.toLowerCase();
  return u.replace(/^[a-z]+:\/\/[^@/]+@/i, "").toLowerCase();
}

export interface LocalClone {
  name: string;
  path: string;
  remote?: string;
}

/** The clone on this PC of a repository: the same remote, else (no remote known on one side) the same name. */
export function cloneOf(r: SetRepoArg, locals: LocalClone[]): LocalClone | undefined {
  const key = remoteKey(r.remoteUrl);
  if (key) {
    const same = locals.find((l) => remoteKey(l.remote) === key);
    if (same) return same;
    // a clone without a remote url, or another remote form: the name decides only when its remote says nothing else
    return locals.find((l) => l.name.toLowerCase() === r.name.toLowerCase() && !l.remote);
  }
  return locals.find((l) => l.name.toLowerCase() === r.name.toLowerCase());
}

/** The branch each repository gets, and the set's own branch (named after the shared new branch, else the first one). */
export function branchesOf(arg: OpenReposArg): { setBranch: string; per: { name: string; branch: string; from?: string }[] } {
  const per = arg.repos.map((r) => {
    const branch = r.newBranch ?? r.branch ?? arg.newBranch!;
    const made = !!r.newBranch || (!r.branch && !!arg.newBranch);
    const from = made ? (r.from ?? (r.newBranch ? undefined : arg.from)) : undefined;
    return { name: r.name, branch, from };
  });
  const setBranch = arg.newBranch ?? arg.repos.find((r) => r.newBranch)?.newBranch ?? per[0].branch;
  return { setBranch, per };
}

/**
 * `aihub worktree open` for the repositories that are on this PC: one new set, each repository on its own branch
 * (`--branch-for`), new branches from their own base (`--from-for`), the story, and no window (the extension opens it).
 */
export function openArgs(arg: OpenReposArg, present: { name: string; cliName: string; path: string }[]): string[] {
  const { setBranch, per } = branchesOf(arg);
  const mine = per.filter((p) => present.some((x) => x.name.toLowerCase() === p.name.toLowerCase()));
  // the CLI names a clone by its remote (repoNameOfUrl), else by its folder
  const nameOf = (n: string) => present.find((x) => x.name.toLowerCase() === n.toLowerCase())!.cliName;
  const froms = mine.filter((p) => p.from);
  return [
    "worktree",
    "open",
    "--repos",
    present.map((p) => p.path).join(","),
    "--branch",
    setBranch,
    "--branch-for",
    mine.map((p) => `${nameOf(p.name)}=${p.branch}`).join(","),
    ...(froms.length ? ["--from-for", froms.map((p) => `${nameOf(p.name)}=${p.from}`).join(",")] : []),
    ...(arg.story ? ["--story", String(arg.story)] : []),
    "--new-set",
    "--window",
    "none",
    "--json",
  ];
}

interface CliRepo {
  repo: string;
  ok: boolean;
  state: string;
  branch: string;
  path?: string;
  note: string;
}

/** The name the CLI gives a clone: the repository of its remote, else its folder name (as repoGroups.resolveRepos). */
export function cliNameOf(path: string, remote: string | undefined, nameOfUrl: (u: string | undefined) => string | undefined): string {
  return nameOfUrl(remote) ?? path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

/** The answer: the CLI's rows plus the repositories that were not cloned or not found (one sentence each). */
export function resultOf(cli: { story?: number; folder?: string; workspace?: string; repos: CliRepo[] } | undefined, o: { opened: boolean; cloned: string[]; failed: OpenReposRow[] }): OpenReposResult {
  const rows: OpenReposRow[] = (cli?.repos ?? []).map((r) => ({
    repo: r.repo,
    ok: r.ok,
    branch: r.branch,
    ...(r.path ? { path: r.path } : {}),
    ...(o.cloned.some((c) => c.toLowerCase() === r.repo.toLowerCase()) ? { cloned: true } : {}),
    state: r.state,
    ...(r.ok ? {} : { error: r.note }),
  }));
  return { ...(cli?.story ? { story: cli.story } : {}), ...(cli?.folder && cli.workspace ? { folder: cli.folder, workspace: cli.workspace } : {}), opened: o.opened, repos: [...rows, ...o.failed] };
}

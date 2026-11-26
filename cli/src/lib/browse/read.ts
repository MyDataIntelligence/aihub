import { spawnSync } from "../proc.js";
import { adoKey, localRepos } from "../repoPicker.js";
import { rowOf, type RawBuild, type RunRow } from "../pipelineView.js";
import {
  BrowseError,
  cached,
  cacheWrite,
  guarded,
  meOf,
  normPath,
  parseRef,
  part,
  personOf,
  pool,
  repoClientOf,
  shortSha,
  TTL,
  versionQuery,
  webCommitUrl,
  webFileUrl,
  webRepoUrl,
  type Browse,
  type BrowseErrorKind,
  type MeInfo,
  type Person,
  type ReadMeta,
  type RefOut,
  type RefSpec,
} from "./core.js";
import { hunks, type Hunk } from "./lineDiff.js";

// ---- shapes ----------------------------------------------------------------------------------------------------------

export interface Clone {
  path: string;
  branch: string;
}

export interface RepoRow {
  id: string;
  project: string;
  repo: string;
  defaultBranch: string;
  sizeBytes: number | null;
  canOpen: boolean;
  reason: "disabled" | "noAccess" | "empty" | null;
  clone: Clone | null;
  webUrl: string;
  remoteUrl: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  webUrl: string;
  repos: RepoRow[];
  cannotOpen: number;
}

export interface CommitInfo {
  id: string;
  short: string;
  message: string;
  at: string | null;
  by: Person;
}

export type PartError = { part: string; kind: BrowseErrorKind; message: string };

interface RawRepo {
  id: string;
  name: string;
  defaultBranch?: string;
  size?: number;
  remoteUrl?: string;
  webUrl?: string;
  isDisabled?: boolean;
  project?: { id?: string; name?: string };
}

interface RawItem {
  objectId: string;
  gitObjectType: "tree" | "blob" | "commit" | string;
  commitId: string;
  path: string;
  isFolder?: boolean;
  content?: string;
  contentMetadata?: { isBinary?: boolean; encoding?: number; fileName?: string };
  latestProcessedChange?: RawCommit;
}

interface RawCommit {
  commitId: string;
  comment?: string;
  author?: { name?: string; email?: string; date?: string };
  committer?: { name?: string; email?: string; date?: string };
  parents?: string[];
  remoteUrl?: string;
}

const firstLine = (s: string | undefined) => (s ?? "").split(/\r?\n/)[0].trim();

export function commitOf(c: RawCommit, me: MeInfo): CommitInfo {
  return { id: c.commitId, short: shortSha(c.commitId), message: firstLine(c.comment), at: c.author?.date ?? c.committer?.date ?? null, by: personOf(c.author, me) };
}

// ---- clones on this PC -----------------------------------------------------------------------------------------------

/** `org/project/repo` (lower case) -> the clone used for it, read from the file system (no git per repository). */
export function clonesOf(b: Browse): Map<string, Clone> {
  const out = new Map<string, Clone>();
  try {
    for (const r of localRepos(b.ctx).repos) if (r.key) out.set(r.key, { path: r.path, branch: r.branch });
  } catch {
    /* no repos root: nothing is cloned as far as we know */
  }
  return out;
}

const keyOf = (b: Browse, project: string, repo: string, remoteUrl?: string) => adoKey(remoteUrl) ?? `${b.org}/${project}/${repo}`.toLowerCase();

// ---- projects --------------------------------------------------------------------------------------------------------

export interface ProjectsResult extends ReadMeta {
  org: string;
  projects: ProjectRow[];
}

interface ProjectsRaw {
  projects: { id: string; name: string; description?: string }[];
  repos: RawRepo[];
}

async function projectsRaw(b: Browse): Promise<{ data: ProjectsRaw; meta: ReadMeta }> {
  return guarded(b, "org", () =>
    cached(b, `projects|${b.org}`, TTL.lists, async () => {
      const [p, r] = await Promise.all([
        b.client.request<{ value?: { id: string; name: string; description?: string }[] }>("GET", "projects", { orgLevel: true, query: { $top: 1000 } }),
        b.client.request<{ value?: RawRepo[] }>("GET", "git/repositories", { orgLevel: true }),
      ]);
      return { projects: (p.data.value ?? []).map((x) => ({ id: x.id, name: x.name, description: x.description })), repos: r.data.value ?? [] };
    }),
  );
}

function repoRow(b: Browse, r: RawRepo, project: string, clones: Map<string, Clone>): RepoRow {
  const remoteUrl = (r.remoteUrl ?? "").replace(/^(https?:\/\/)[^@/]+@/, "$1");
  const reason = r.isDisabled ? "disabled" : !r.defaultBranch ? "empty" : null;
  return {
    id: r.id,
    project,
    repo: r.name,
    defaultBranch: (r.defaultBranch ?? "").replace(/^refs\/heads\//, ""),
    sizeBytes: typeof r.size === "number" ? r.size : null,
    canOpen: !r.isDisabled,
    reason,
    clone: clones.get(keyOf(b, project, r.name, remoteUrl)) ?? null,
    webUrl: r.webUrl ?? webRepoUrl(b, project, r.name),
    remoteUrl,
  };
}

export function mapProjects(b: Browse, raw: ProjectsRaw, clones: Map<string, Clone>): ProjectRow[] {
  return raw.projects
    .map((p) => {
      const repos = raw.repos
        .filter((r) => (r.project?.id ?? "").toLowerCase() === p.id.toLowerCase() || (r.project?.name ?? "") === p.name)
        .map((r) => repoRow(b, r, p.name, clones))
        .sort((x, y) => x.repo.localeCompare(y.repo));
      return { id: p.id, name: p.name, description: p.description?.trim() || null, webUrl: `${b.client.remote.orgUrl}/${encodeURIComponent(p.name)}`, repos, cannotOpen: repos.filter((r) => !r.canOpen).length };
    })
    .sort((x, y) => x.name.localeCompare(y.name));
}

export async function browseProjects(b: Browse): Promise<ProjectsResult> {
  const { data, meta } = await projectsRaw(b);
  return { org: b.org, ...meta, projects: mapProjects(b, data, clonesOf(b)) };
}

async function projectRow(b: Browse, project: string, clones = clonesOf(b)): Promise<{ row: ProjectRow; meta: ReadMeta }> {
  const { data, meta } = await projectsRaw(b);
  const row = mapProjects(b, data, clones).find((p) => p.name.toLowerCase() === project.toLowerCase());
  if (!row) throw new BrowseError("notFound", `project '${project}' not found in ${b.org}, or you have no access to it`);
  return { row, meta };
}

async function repoRowOf(b: Browse, project: string, repo: string): Promise<RepoRow> {
  const { row } = await projectRow(b, project);
  const r = row.repos.find((x) => x.repo.toLowerCase() === repo.toLowerCase());
  if (!r) throw new BrowseError("notFound", `repository '${repo}' not found in ${project}, or you have no access to it`);
  if (!r.canOpen) throw new BrowseError("noAccess", `repository '${repo}' is disabled`);
  return r;
}

// ---- project page ----------------------------------------------------------------------------------------------------

export interface ProjectPage extends ReadMeta {
  project: { name: string; description: string | null; webUrl: string };
  repos: (RepoRow & { description: string | null; language: string | null; lastActivity: (CommitInfo & { commit: string }) | null })[];
  cannotOpen: { repo: string; reason: string }[];
  recentFiles: { repo: string; path: string; at: string | null; by: Person; commit: string; message: string }[];
  activeAuthors: (Person & { commits: number })[];
  errors: PartError[];
}

/** The first paragraph of a README that is prose (no heading, badge, table or code), at most 200 characters. */
export function readmeSummary(md: string): string | null {
  const paras = md.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  let inCode = false;
  for (const p of paras) {
    const t = p.trim();
    if ((t.match(/```/g)?.length ?? 0) % 2 === 1) inCode = !inCode;
    if (inCode || !t || /^(#|```|\||<|!\[|\[!\[|>|-{3,})/.test(t)) continue;
    const one = t.replace(/\s+/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/`|\*\*|(?<![\w])__|__(?![\w])/g, "");
    return one.length > 200 ? `${one.slice(0, 197)}...` : one;
  }
  return null;
}

const MAX_PROJECT_REPOS = 30;

export async function browseProject(b: Browse, project: string, days = 30): Promise<ProjectPage> {
  const me = await meOf(b);
  const clones = clonesOf(b);
  const { row } = await projectRow(b, project, clones);
  const errors: PartError[] = [];
  const now = b.now();
  const since = new Date(now - days * 86_400_000).toISOString();
  const { data, meta } = await cached(b, `project|${b.org}|${row.name}|${days}`, TTL.project, async () => {
    const pc = b.client.forProject(row.name);
    const open = row.repos.filter((r) => r.canOpen && r.defaultBranch).slice(0, MAX_PROJECT_REPOS);
    const langs = await part(
      errors,
      "language",
      async () => {
        const r = await pc.get<{ repositoryLanguageAnalytics?: { name: string; id?: string; languageBreakdown?: { name: string; languagePercentage?: number }[] }[] }>("projectanalysis/languagemetrics", { "api-version": "7.1-preview.1" });
        const m = new Map<string, string>();
        for (const x of r.repositoryLanguageAnalytics ?? []) {
          const top = [...(x.languageBreakdown ?? [])].sort((p, q) => (q.languagePercentage ?? 0) - (p.languagePercentage ?? 0))[0];
          if (top?.name) m.set(x.name.toLowerCase(), top.name);
        }
        return [...m];
      },
      [] as [string, string][],
    );
    const perRepo = await pool(open, 6, async (r) => {
      const rc = pc.forRepo(r.repo);
      const commits = await rc
        .get<{ value?: RawCommit[] }>(`${rc.repoPath()}/commits`, { "searchCriteria.$top": 100, "searchCriteria.itemVersion.version": r.defaultBranch })
        .then((x) => x.value ?? [])
        .catch((e) => (errors.push({ part: `commits:${r.repo}`, kind: "failed", message: (e as Error).message }), [] as RawCommit[]));
      const readme = await rc
        .get<RawItem>(`${rc.repoPath()}/items`, { path: "/README.md", includeContent: true, ...versionQuery({ name: r.defaultBranch, kind: "branch" }) })
        .then((x) => readmeSummary(x.content ?? ""))
        .catch(() => null);
      return { repo: r.repo, commits, readme };
    });
    return { langs, perRepo };
  }, () => !errors.length);
  const langs = new Map(data.langs);
  const repos: ProjectPage["repos"] = row.repos.map((r) => {
    const p = data.perRepo.find((x) => x.repo === r.repo);
    const last = p?.commits[0];
    return { ...r, description: p?.readme ?? null, language: langs.get(r.repo.toLowerCase()) ?? null, lastActivity: last ? { ...commitOf(last, me), commit: last.commitId } : null };
  });
  // the commits of the last `days`, newest first, over every repository
  const recent = data.perRepo
    .flatMap((p) => p.commits.filter((c) => (c.author?.date ?? "") >= since).map((c) => ({ repo: p.repo, c })))
    .sort((x, y) => (y.c.author?.date ?? "").localeCompare(x.c.author?.date ?? ""));
  const authors = new Map<string, Person & { commits: number }>();
  for (const { c } of recent) {
    const who = personOf(c.author, me);
    const k = who.email || who.name;
    const a = authors.get(k) ?? { ...who, commits: 0 };
    a.commits++;
    authors.set(k, a);
  }
  const recentFiles = await part(
    errors,
    "recentFiles",
    () =>
      cached(b, `recentFiles|${b.org}|${row.name}|${recent.slice(0, 8).map((x) => x.c.commitId).join(",")}`, TTL.forever, async () => {
        const files: ProjectPage["recentFiles"] = [];
        const seen = new Set<string>();
        const changes = await pool(recent.slice(0, 8), 4, async ({ repo, c }) => {
          const rc = b.client.forProject(row.name).forRepo(repo);
          const r = await rc.get<{ changes?: { item?: { path?: string; gitObjectType?: string; isFolder?: boolean }; changeType?: string }[] }>(`${rc.repoPath()}/commits/${c.commitId}/changes`, { $top: 30 });
          return { repo, c, changes: r.changes ?? [] };
        });
        for (const x of changes)
          for (const ch of x.changes) {
            const path = ch.item?.path;
            if (!path || ch.item?.isFolder || ch.item?.gitObjectType === "tree" || /delete/i.test(ch.changeType ?? "")) continue;
            const k = `${x.repo}|${path}`;
            if (seen.has(k) || files.length >= 15) continue;
            seen.add(k);
            files.push({ repo: x.repo, path, at: x.c.author?.date ?? null, by: personOf(x.c.author, me), commit: x.c.commitId, message: firstLine(x.c.comment) });
          }
        return files;
      }).then((x) => x.data),
    [] as ProjectPage["recentFiles"],
  );
  return {
    ...meta,
    project: { name: row.name, description: row.description, webUrl: row.webUrl },
    repos,
    cannotOpen: row.repos.filter((r) => !r.canOpen).map((r) => ({ repo: r.repo, reason: r.reason ?? "noAccess" })),
    recentFiles,
    activeAuthors: [...authors.values()].sort((x, y) => y.commits - x.commits || x.name.localeCompare(y.name)).slice(0, 8),
    errors,
  };
}

// ---- items -----------------------------------------------------------------------------------------------------------

export interface ItemRow {
  name: string;
  path: string;
  kind: "folder" | "file" | "submodule";
  sizeBytes: number | null;
  objectId: string;
  lastCommit: CommitInfo | null;
}

export interface ItemsResult extends ReadMeta {
  ref: RefOut;
  path: string;
  items: ItemRow[];
}

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? "/";

export function mapItems(raw: RawItem[], path: string, me: MeInfo): ItemRow[] {
  return raw
    .filter((x) => normPath(x.path) !== path)
    .map((x) => ({
      name: baseName(x.path),
      path: normPath(x.path),
      kind: (x.gitObjectType === "tree" || x.isFolder ? "folder" : x.gitObjectType === "commit" ? "submodule" : "file") as ItemRow["kind"],
      sizeBytes: null,
      objectId: x.objectId,
      lastCommit: x.latestProcessedChange ? commitOf(x.latestProcessedChange, me) : null,
    }))
    .sort((a, b) => (a.kind === "folder" ? 0 : 1) - (b.kind === "folder" ? 0 : 1) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** A read at a ref: at a commit id it never changes (kept for good), at a branch or tag for 2 minutes; the answer names the commit. */
async function atRef<T extends { ref: RefOut }>(b: Browse, base: string, ref: RefSpec, work: () => Promise<T>): Promise<{ data: T; meta: ReadMeta }> {
  if (ref.kind === "commit" && ref.name.length === 40) return cached(b, `${base}|commit:${ref.name}`, TTL.forever, work);
  const r = await cached(b, `${base}|${ref.kind}:${ref.name}`, TTL.branchRef, work);
  if (!r.meta.cached) cachedPut(b, `${base}|commit:${r.data.ref.commit}`, r.data);
  return r;
}

function cachedPut<T>(b: Browse, key: string, data: T): void {
  cacheWrite(b.env, key, data, b.now());
}

async function refOrDefault(b: Browse, project: string, repo: string, ref: string | undefined): Promise<{ spec: RefSpec; row: RepoRow }> {
  const row = await repoRowOf(b, project, repo);
  const spec = parseRef(ref) ?? (row.defaultBranch ? { name: row.defaultBranch, kind: "branch" as const } : undefined);
  if (!spec) throw new BrowseError("notFound", `repository '${repo}' is empty (no default branch)`);
  return { spec, row };
}

export async function browseItems(b: Browse, o: { project: string; repo: string; path?: string; ref?: string; lastCommit?: boolean }): Promise<ItemsResult> {
  const me = o.lastCommit ? await meOf(b) : { id: "", name: "", email: "" };
  const { spec, row } = await refOrDefault(b, o.project, o.repo, o.ref);
  const path = normPath(o.path);
  const rc = repoClientOf(b, row.project, row.repo);
  const { data, meta } = await guarded(b, `${row.project}|${row.repo}`, () =>
    atRef(b, `items|${b.org}|${row.project}|${row.repo}|${path}|${o.lastCommit ? "lc" : ""}`, spec, async () => {
      const r = await rc.get<{ value?: RawItem[] }>(`${rc.repoPath()}/items`, {
        scopePath: path,
        recursionLevel: "OneLevel",
        ...(o.lastCommit ? { latestProcessedChange: true } : {}),
        ...versionQuery(spec),
      });
      const value = r.value ?? [];
      const self = value.find((x) => normPath(x.path) === path);
      if (self && self.gitObjectType === "blob") throw new BrowseError("badInput", `${path} is a file, not a folder (use aihub browse file)`);
      return { ref: { name: spec.name, kind: spec.kind, commit: (self ?? value[0])?.commitId ?? "" }, path, items: mapItems(value, path, me) };
    }),
  );
  return { ...meta, ...data };
}

// ---- file ------------------------------------------------------------------------------------------------------------

export interface FileResult extends ReadMeta {
  ref: RefOut;
  path: string;
  objectId: string;
  sizeBytes: number | null;
  lastCommit: CommitInfo | null;
  binary: boolean;
  tooLarge: boolean;
  content: string | null;
  webUrl: string;
}

export const MAX_FILE_BYTES = 1024 * 1024;

export function looksBinary(s: string): boolean {
  return s.slice(0, 8000).includes("\u0000");
}

export async function readFileAt(b: Browse, project: string, repo: string, path: string, spec: RefSpec, maxBytes = MAX_FILE_BYTES): Promise<Omit<FileResult, "readAt" | "cached" | "webUrl">> {
  const me = await meOf(b);
  const rc = repoClientOf(b, project, repo);
  const x = await rc.get<RawItem>(`${rc.repoPath()}/items`, { path, includeContent: true, includeContentMetadata: true, latestProcessedChange: true, ...versionQuery(spec) });
  if (x.gitObjectType === "tree" || x.isFolder) throw new BrowseError("badInput", `${path} is a folder, not a file (use aihub browse items)`);
  const raw = x.content ?? "";
  const size = Buffer.byteLength(raw, "utf8");
  const binary = !!x.contentMetadata?.isBinary || looksBinary(raw);
  const tooLarge = !binary && size > maxBytes;
  return {
    ref: { name: spec.name, kind: spec.kind, commit: x.commitId },
    path,
    objectId: x.objectId,
    sizeBytes: binary ? null : size,
    lastCommit: x.latestProcessedChange ? commitOf(x.latestProcessedChange, me) : null,
    binary,
    tooLarge,
    content: binary || tooLarge ? null : raw,
  };
}

export async function browseFile(b: Browse, o: { project: string; repo: string; path: string; ref?: string; maxBytes?: number }): Promise<FileResult> {
  const { spec, row } = await refOrDefault(b, o.project, o.repo, o.ref);
  const path = normPath(o.path);
  if (path === "/") throw new BrowseError("badInput", "aihub browse file needs --path <file>");
  const { data, meta } = await guarded(b, `${row.project}|${row.repo}`, () =>
    atRef(b, `file|${b.org}|${row.project}|${row.repo}|${path}|${o.maxBytes ?? ""}`, spec, () => readFileAt(b, row.project, row.repo, path, spec, o.maxBytes)),
  );
  return { ...meta, ...data, webUrl: webFileUrl(b, row.project, row.repo, path, spec) };
}

// ---- branches --------------------------------------------------------------------------------------------------------

export interface BranchesResult extends ReadMeta {
  default: string;
  count: number;
  branches: { name: string; commit: string; isMine: boolean; isDefault: boolean; by: Person | null }[];
  tags: { name: string; commit: string }[];
  more: boolean;
}

interface RawRef {
  name: string;
  objectId: string;
  peeledObjectId?: string;
  creator?: { displayName?: string; uniqueName?: string; id?: string };
}

export function mapBranches(refs: RawRef[], def: string, me: MeInfo, filter?: string, top = 50): Omit<BranchesResult, "readAt" | "cached"> {
  const f = filter?.toLowerCase();
  const heads = refs.filter((r) => r.name.startsWith("refs/heads/"));
  const all = heads
    .map((r) => {
      const by = r.creator ? personOf(r.creator, me) : null;
      const name = r.name.slice("refs/heads/".length);
      return { name, commit: r.objectId, isMine: !!by?.isMe, isDefault: name === def, by };
    })
    .filter((x) => !f || x.name.toLowerCase().includes(f))
    .sort((x, y) => Number(y.isDefault) - Number(x.isDefault) || Number(y.isMine) - Number(x.isMine) || x.name.localeCompare(y.name));
  const tags = refs
    .filter((r) => r.name.startsWith("refs/tags/"))
    .map((r) => ({ name: r.name.slice("refs/tags/".length), commit: r.peeledObjectId ?? r.objectId }))
    .filter((x) => !f || x.name.toLowerCase().includes(f))
    .sort((x, y) => y.name.localeCompare(x.name, undefined, { numeric: true }));
  return { default: def, count: heads.length, branches: all.slice(0, top), tags: tags.slice(0, top), more: all.length > top || tags.length > top };
}

async function refsOf(b: Browse, row: RepoRow): Promise<{ data: RawRef[]; meta: ReadMeta }> {
  const rc = repoClientOf(b, row.project, row.repo);
  return cached(b, `refs|${b.org}|${row.project}|${row.repo}`, TTL.short, async () => {
    const [heads, tags] = await Promise.all([rc.list<RawRef>(`${rc.repoPath()}/refs`, { filter: "heads/" }), rc.list<RawRef>(`${rc.repoPath()}/refs`, { filter: "tags/", peelTags: true })]);
    return [...heads, ...tags].map((r) => ({ name: r.name, objectId: r.objectId, peeledObjectId: r.peeledObjectId, creator: r.creator ? { displayName: r.creator.displayName, uniqueName: r.creator.uniqueName, id: r.creator.id } : undefined }));
  });
}

export async function browseBranches(b: Browse, o: { project: string; repo: string; filter?: string; top?: number }): Promise<BranchesResult> {
  const row = await repoRowOf(b, o.project, o.repo);
  const me = await meOf(b);
  const { data, meta } = await guarded(b, `${row.project}|${row.repo}`, () => refsOf(b, row));
  return { ...meta, ...mapBranches(data, row.defaultBranch, me, o.filter, o.top ?? 50) };
}

// ---- history and diff ------------------------------------------------------------------------------------------------

export interface HistoryResult extends ReadMeta {
  ref: { name: string; kind: RefSpec["kind"] };
  path: string;
  commits: (CommitInfo & { webUrl: string })[];
  more: boolean;
}

export async function browseHistory(b: Browse, o: { project: string; repo: string; path?: string; ref?: string; top?: number; skip?: number }): Promise<HistoryResult> {
  const { spec, row } = await refOrDefault(b, o.project, o.repo, o.ref);
  const path = normPath(o.path);
  const top = Math.min(Math.max(o.top ?? 50, 1), 500);
  const skip = Math.max(o.skip ?? 0, 0);
  const me = await meOf(b);
  const rc = repoClientOf(b, row.project, row.repo);
  const { data, meta } = await guarded(b, `${row.project}|${row.repo}`, () =>
    cached(b, `history|${b.org}|${row.project}|${row.repo}|${path}|${spec.kind}:${spec.name}|${top}|${skip}`, spec.kind === "commit" && spec.name.length === 40 ? TTL.forever : TTL.short, async () => {
      const r = await rc.get<{ value?: RawCommit[] }>(`${rc.repoPath()}/commits`, {
        ...(path !== "/" ? { "searchCriteria.itemPath": path } : {}),
        "searchCriteria.itemVersion.version": spec.name,
        "searchCriteria.itemVersion.versionType": spec.kind,
        "searchCriteria.$top": top + 1,
        "searchCriteria.$skip": skip,
      });
      return r.value ?? [];
    }),
  );
  return {
    ...meta,
    ref: { name: spec.name, kind: spec.kind },
    path,
    commits: data.slice(0, top).map((c) => ({ ...commitOf(c, me), webUrl: webCommitUrl(b, row.project, row.repo, c.commitId) })),
    more: data.length > top,
  };
}

export interface Side {
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
}

export interface DiffResult extends ReadMeta {
  commit: CommitInfo & { webUrl: string };
  parent: string | null;
  path: string;
  oldPath: string | null;
  changeType: "add" | "edit" | "delete" | "rename" | "none";
  before: Side | null;
  after: Side | null;
  hunks: Hunk[];
}

export function changeTypeOf(t: string | undefined): DiffResult["changeType"] {
  const s = (t ?? "").toLowerCase();
  if (s.includes("rename")) return "rename";
  if (s.includes("delete")) return "delete";
  if (s.includes("add")) return "add";
  if (s.includes("edit")) return "edit";
  return "none";
}

export async function browseDiff(b: Browse, o: { project: string; repo: string; commit: string; path: string }): Promise<DiffResult> {
  const row = await repoRowOf(b, o.project, o.repo);
  const path = normPath(o.path);
  if (!/^[0-9a-f]{7,40}$/i.test(o.commit)) throw new BrowseError("badInput", `'${o.commit}' is not a commit id`);
  const me = await meOf(b);
  const rc = repoClientOf(b, row.project, row.repo);
  const { data, meta } = await guarded(b, `${row.project}|${row.repo}`, () =>
    cached(b, `diff|${b.org}|${row.project}|${row.repo}|${o.commit}|${path}`, o.commit.length === 40 ? TTL.forever : TTL.short, async () => {
      const c = await rc.get<RawCommit>(`${rc.repoPath()}/commits/${o.commit}`);
      const ch = await rc.get<{ changes?: { item?: { path?: string }; changeType?: string; sourceServerItem?: string; originalPath?: string }[] }>(`${rc.repoPath()}/commits/${c.commitId}/changes`, { $top: 2000 });
      const hit = (ch.changes ?? []).find((x) => normPath(x.item?.path) === path);
      const changeType = changeTypeOf(hit?.changeType);
      const oldPath = changeType === "rename" ? normPath(hit?.sourceServerItem ?? hit?.originalPath) : null;
      const parent = c.parents?.[0] ?? null;
      const side = async (p: string, at: string | null): Promise<Side | null> => {
        if (!at) return null;
        try {
          const f = await readFileAt(b, row.project, row.repo, p, { name: at, kind: "commit" });
          return { content: f.content, binary: f.binary, tooLarge: f.tooLarge };
        } catch {
          return null; // the file is not there in that version
        }
      };
      const before = changeType === "add" ? null : await side(oldPath ?? path, parent);
      const after = changeType === "delete" ? null : await side(path, c.commitId);
      const textual = (s: Side | null) => !s || s.content !== null;
      const h = textual(before) && textual(after) ? hunks(before?.content ?? "", after?.content ?? "") : [];
      return { commit: { ...commitOf(c, me), webUrl: webCommitUrl(b, row.project, row.repo, c.commitId) }, parent, path, oldPath, changeType, before, after, hunks: h };
    }),
  );
  return { ...meta, ...data };
}

// ---- blame -----------------------------------------------------------------------------------------------------------

export type BlameResult =
  | (ReadMeta & { available: true; source: "local"; ref: { name: string; kind: RefSpec["kind"] }; clone: string; lines: { n: number; commit: string }[]; commits: Record<string, Omit<CommitInfo, "id">> })
  | (ReadMeta & { available: false; reason: string; clone: string | null });

/** `git blame --porcelain` -> one commit per line and the facts of each commit. */
export function parsePorcelain(text: string, me: MeInfo): { lines: { n: number; commit: string }[]; commits: Record<string, Omit<CommitInfo, "id">> } {
  const lines: { n: number; commit: string }[] = [];
  const commits: Record<string, Omit<CommitInfo, "id">> = {};
  const facts: Record<string, { name?: string; email?: string; time?: number; summary?: string }> = {};
  let cur = "";
  for (const l of text.split("\n")) {
    const h = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(l);
    if (h) {
      cur = h[1];
      lines.push({ n: Number(h[2]), commit: cur });
      facts[cur] ??= {};
      continue;
    }
    if (!cur) continue;
    const f = facts[cur];
    if (l.startsWith("author ")) f.name = l.slice(7);
    else if (l.startsWith("author-mail ")) f.email = l.slice(12).replace(/[<>]/g, "");
    else if (l.startsWith("author-time ")) f.time = Number(l.slice(12));
    else if (l.startsWith("summary ")) f.summary = l.slice(8);
  }
  for (const [id, f] of Object.entries(facts)) commits[id] = { short: shortSha(id), message: f.summary ?? "", at: f.time ? new Date(f.time * 1000).toISOString() : null, by: personOf({ name: f.name, email: f.email }, me) };
  return { lines, commits };
}

/**
 * Azure DevOps has no public annotate (blame) REST API (checked: .../blame, .../annotate, .../annotations answer 404), so blame
 * runs `git blame` in a clone on this PC, at the remote's version of the ref; without a clone it is reported as not available.
 */
export async function browseBlame(b: Browse, o: { project: string; repo: string; path: string; ref?: string }): Promise<BlameResult> {
  const { spec, row } = await refOrDefault(b, o.project, o.repo, o.ref);
  const path = normPath(o.path);
  const readAt = new Date(b.now()).toISOString();
  if (!row.clone) return { readAt, cached: false, available: false, reason: "not available for remote repositories: clone it to see who changed each line", clone: null };
  const rev = spec.kind === "branch" ? `origin/${spec.name}` : spec.kind === "tag" ? `refs/tags/${spec.name}` : spec.name;
  const me = await meOf(b);
  const r = spawnSync("git", ["blame", "--porcelain", rev, "--", path.slice(1)], { cwd: row.clone.path, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    const why = (r.stderr || "").split("\n")[0];
    return { readAt, cached: false, available: false, reason: /no such path|no such ref|bad revision|unknown revision/i.test(why) ? `the clone does not have this version yet (fetch first): ${why}` : `git blame failed: ${why}`, clone: row.clone.path };
  }
  return { readAt, cached: false, available: true, source: "local", ref: { name: spec.name, kind: spec.kind }, clone: row.clone.path, ...parsePorcelain(r.stdout, me) };
}

// ---- repository page -------------------------------------------------------------------------------------------------

export interface RepoPage extends ReadMeta {
  repo: RepoRow;
  ref: RefOut;
  readme: { path: string; markdown: string; truncated: boolean } | null;
  root: ItemRow[];
  branches: { count: number; default: string; items: TopBranch[] };
  pullRequests: { count: number; items: { id: number; title: string; by: Person; source: string; target: string; isDraft: boolean; createdAt: string | null; webUrl: string }[] };
  commits: (CommitInfo & { webUrl: string })[];
  pipelines: { runs: RunRow[] };
  errors: PartError[];
}

const README_MAX = 256 * 1024;

export interface TopBranch {
  name: string;
  isDefault: boolean;
  isMine: boolean;
  /** the date of its newest commit */
  at: string | null;
  commit: string;
  /** commits ahead of / behind the default branch */
  ahead: number | null;
  behind: number | null;
}

interface RawBranchStat {
  name: string;
  aheadCount?: number;
  behindCount?: number;
  commit?: RawCommit;
}

/** The three branches the repository page shows: the default one, then mine, then the most recently changed (newest first). */
export function topBranches(heads: RawRef[], stats: RawBranchStat[], def: string, me: MeInfo, n = 3): TopBranch[] {
  const byName = new Map(stats.map((s) => [s.name, s]));
  const all = heads.map((r) => {
    const name = r.name.replace(/^refs\/heads\//, "");
    const s = byName.get(name);
    return {
      name,
      isDefault: name === def,
      isMine: !!r.creator && personOf(r.creator, me).isMe,
      at: s?.commit?.committer?.date ?? s?.commit?.author?.date ?? null,
      commit: r.objectId,
      ahead: name === def ? 0 : (s?.aheadCount ?? null),
      behind: name === def ? 0 : (s?.behindCount ?? null),
    };
  });
  const newest = (a: TopBranch, b: TopBranch) => (b.at ?? "").localeCompare(a.at ?? "") || a.name.localeCompare(b.name);
  const out: TopBranch[] = [];
  const add = (x: TopBranch | undefined) => {
    if (x && out.length < n && !out.includes(x)) out.push(x);
  };
  add(all.find((x) => x.isDefault));
  add(all.filter((x) => x.isMine && !x.isDefault).sort(newest)[0]);
  for (const x of all.filter((y) => !y.isDefault).sort(newest)) add(x);
  return out;
}

export async function browseRepo(b: Browse, o: { project: string; repo: string; ref?: string }): Promise<RepoPage> {
  const { spec, row } = await refOrDefault(b, o.project, o.repo, o.ref);
  const me = await meOf(b);
  const rc = repoClientOf(b, row.project, row.repo);
  const errors: PartError[] = [];
  const { data, meta } = await guarded(b, `${row.project}|${row.repo}`, () =>
    cached(b, `repo|${b.org}|${row.project}|${row.repo}|${spec.kind}:${spec.name}`, TTL.short, async () => {
      const rootRaw = await part(errors, "root", () => rc.get<{ value?: RawItem[] }>(`${rc.repoPath()}/items`, { scopePath: "/", recursionLevel: "OneLevel", latestProcessedChange: true, ...versionQuery(spec) }).then((x) => x.value ?? []), [] as RawItem[]);
      const commitId = rootRaw.find((x) => normPath(x.path) === "/")?.commitId ?? rootRaw[0]?.commitId ?? "";
      const root = mapItems(rootRaw, "/", me);
      const readmeItem = root.find((x) => x.kind === "file" && /^readme(\.md|\.markdown|\.txt)?$/i.test(x.name));
      const at: RefSpec = commitId ? { name: commitId, kind: "commit" } : spec;
      const [readme, refs, prs, commits, builds] = await Promise.all([
        readmeItem
          ? part(
              errors,
              "readme",
              async () => {
                const f = await readFileAt(b, row.project, row.repo, readmeItem.path, at, README_MAX);
                return { path: readmeItem.path, markdown: f.content ?? "", truncated: f.tooLarge };
              },
              null,
            )
          : Promise.resolve(null),
        part(
          errors,
          "branches",
          async () => {
            const [heads, stats] = await Promise.all([
              rc.list<RawRef>(`${rc.repoPath()}/refs`, { filter: "heads/" }),
              rc.get<{ value?: RawBranchStat[] }>(`${rc.repoPath()}/stats/branches`).then((x) => x.value ?? []).catch(() => [] as RawBranchStat[]),
            ]);
            return { count: heads.length, items: topBranches(heads, stats, row.defaultBranch, me) };
          },
          { count: 0, items: [] as TopBranch[] },
        ),
        part(
          errors,
          "pullRequests",
          () =>
            rc.get<{ value?: { pullRequestId: number; title: string; createdBy?: { displayName?: string; uniqueName?: string; id?: string }; sourceRefName: string; targetRefName: string; isDraft?: boolean; creationDate?: string }[] }>(`${rc.repoPath()}/pullrequests`, {
              "searchCriteria.status": "active",
              $top: 100,
            }),
          { value: [] },
        ),
        part(errors, "commits", () => rc.get<{ value?: RawCommit[] }>(`${rc.repoPath()}/commits`, { "searchCriteria.$top": 10, "searchCriteria.itemVersion.version": at.name, "searchCriteria.itemVersion.versionType": at.kind }).then((x) => x.value ?? []), [] as RawCommit[]),
        part(errors, "pipelines", () => b.client.forProject(row.project).get<{ value?: RawBuild[] }>("build/builds", { repositoryId: row.id, repositoryType: "TfsGit", $top: 5, queryOrder: "queueTimeDescending" }).then((x) => x.value ?? []), [] as RawBuild[]),
      ]);
      const now = b.now();
      const prItems = (prs.value ?? []).map((p) => ({
        id: p.pullRequestId,
        title: p.title,
        by: personOf(p.createdBy, me),
        source: p.sourceRefName.replace(/^refs\/heads\//, ""),
        target: p.targetRefName.replace(/^refs\/heads\//, ""),
        isDraft: !!p.isDraft,
        createdAt: p.creationDate ?? null,
        webUrl: `${webRepoUrl(b, row.project, row.repo)}/pullrequest/${p.pullRequestId}`,
      }));
      return {
        ref: { name: spec.name, kind: spec.kind, commit: commitId },
        readme,
        root,
        branches: { count: refs.count, default: row.defaultBranch, items: refs.items },
        pullRequests: { count: prItems.length, items: prItems.slice(0, 20) },
        commits: commits.map((c) => ({ ...commitOf(c, me), webUrl: webCommitUrl(b, row.project, row.repo, c.commitId) })),
        pipelines: { runs: builds.map((x) => rowOf(b.client.forProject(row.project), x, me.id || undefined, row.clone?.path ?? null, now)) },
        errors,
      };
    }, (d) => !d.errors.length),
  );
  // a part that failed is not kept: the next read tries it again
  return { ...meta, repo: row, ...data };
}

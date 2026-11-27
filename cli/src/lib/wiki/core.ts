import { BrowseError, cached, cacheRead, cacheWrite, guarded, TTL, type Browse, type ReadMeta } from "../browse/core.js";

/**
 * The wiki browser: every project wiki and code wiki of the organisation, read and edited without a clone. A project
 * wiki is a hidden git repository (branch wikiMaster) edited through the Pages API (If-Match on the page's ETag); a code
 * wiki is a folder of a normal repository, edited through `aihub browse push` (a feature branch and a pull request).
 * Every read is cached in the user's config folder; a write moves the wiki's generation on, so the next read is fresh.
 */

export type WikiKind = "project" | "code";

export interface WikiRow {
  id: string;
  name: string;
  kind: WikiKind;
  project: string;
  projectId: string;
  /** the repository of a code wiki (a project wiki's own repository is hidden) */
  repo: string | null;
  repoId: string;
  /** the published branch of a code wiki */
  branch: string | null;
  /** the published folder of a code wiki */
  mappedPath: string | null;
  webUrl: string;
}

/** The facts of one wiki that the reads and writes need. */
export interface WikiInfo extends WikiRow {
  /** the branch of the wiki's repository: wikiMaster for a project wiki */
  gitBranch: string;
}

export interface RawWiki {
  id: string;
  name: string;
  type?: string;
  projectId?: string;
  repositoryId?: string;
  mappedPath?: string;
  versions?: { version?: string }[];
  remoteUrl?: string;
}

// ---- paths -----------------------------------------------------------------------------------------------------------

/** A page path as Azure DevOps shows it: `/Runbooks/Order export` (no .md, spaces, leading slash). */
export function pagePath(p: string | undefined): string {
  const s = (p ?? "/").replace(/\\/g, "/").trim().replace(/\.md$/i, "");
  const parts = s.split("/").filter(Boolean);
  return parts.length ? `/${parts.join("/")}` : "/";
}

/** One page name as a file name: a dash stands for a space, a real dash is %2D, and the characters git cannot hold are %XX. */
export function nameToFile(name: string): string {
  return name.replace(/[%\-:<>*?|"#\\/]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).replace(/ /g, "-");
}

export function fileToName(file: string): string {
  const s = file.replace(/\.md$/i, "").replace(/-/g, " ");
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** `/Runbooks/Order export` -> `/Runbooks/Order-export.md` (relative to the wiki's folder). */
export const pageToGitPath = (p: string): string => (pagePath(p) === "/" ? "/" : `${pagePath(p).split("/").filter(Boolean).map(nameToFile).join("/").replace(/^/, "/")}.md`);

/** `/Runbooks/Order-export.md` -> `/Runbooks/Order export`. */
export const gitPathToPage = (g: string): string => `/${g.replace(/\\/g, "/").split("/").filter(Boolean).map(fileToName).join("/")}`;

/** The file of a page in the wiki's repository: the code wiki's folder in front. */
export function fileInRepo(w: Pick<WikiInfo, "kind" | "mappedPath">, gitItemPath: string): string {
  const folder = w.kind === "code" && w.mappedPath && w.mappedPath !== "/" ? w.mappedPath.replace(/\/+$/, "") : "";
  const g = gitItemPath.startsWith("/") ? gitItemPath : `/${gitItemPath}`;
  if (folder && g.toLowerCase().startsWith(`${folder.toLowerCase()}/`)) return g;
  return `${folder}${g}`;
}

/** A repository file of the wiki back to the path relative to the wiki's folder. */
export function relToWiki(w: Pick<WikiInfo, "kind" | "mappedPath">, file: string): string | null {
  const folder = w.kind === "code" && w.mappedPath && w.mappedPath !== "/" ? w.mappedPath.replace(/\/+$/, "") : "";
  const f = file.startsWith("/") ? file : `/${file}`;
  if (!folder) return f;
  return f.toLowerCase().startsWith(`${folder.toLowerCase()}/`) ? f.slice(folder.length) : null;
}

export const nameOf = (p: string) => (pagePath(p) === "/" ? "/" : pagePath(p).split("/").pop()!);
export const parentOf = (p: string) => {
  const parts = pagePath(p).split("/").filter(Boolean);
  return parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : "/";
};

export const webPageUrl = (b: Browse, w: Pick<WikiInfo, "project" | "id">, path: string) =>
  `${b.client.remote.orgUrl}/${encodeURIComponent(w.project)}/_wiki/wikis/${encodeURIComponent(w.id)}?pagePath=${encodeURIComponent(pagePath(path))}`;

// ---- the generation of a wiki (a write makes the next read fresh) ----------------------------------------------------

const genKey = (b: Browse, wikiId: string) => `wiki-gen|${b.org}|${wikiId}`;

export const generationOf = (b: Browse, wikiId: string): number => cacheRead<number>(b.env, genKey(b, wikiId), TTL.forever, 0)?.data ?? 0;

export function bumpGeneration(b: Browse, wikiId: string): void {
  cacheWrite(b.env, genKey(b, wikiId), generationOf(b, wikiId) + 1, 0);
}

// ---- the wikis -------------------------------------------------------------------------------------------------------

export interface WikisResult extends ReadMeta {
  org: string;
  wikis: WikiRow[];
  projects: { name: string; wikis: number }[];
}

export function kindOfRaw(w: RawWiki): WikiKind {
  return w.type === "codeWiki" ? "code" : "project";
}

export function mapWikis(b: Browse, raw: RawWiki[], projects: Map<string, string>, repos: Map<string, string>): WikiRow[] {
  const rows = raw.map((w): WikiRow => {
    const kind = kindOfRaw(w);
    const project = projects.get((w.projectId ?? "").toLowerCase()) ?? w.projectId ?? "";
    return {
      id: w.id,
      name: w.name,
      kind,
      project,
      projectId: w.projectId ?? "",
      repo: kind === "code" ? (repos.get((w.repositoryId ?? "").toLowerCase()) ?? null) : null,
      repoId: w.repositoryId ?? w.id,
      branch: kind === "code" ? (w.versions?.[0]?.version ?? null) : null,
      mappedPath: kind === "code" ? (w.mappedPath ?? "/") : null,
      webUrl: `${b.client.remote.orgUrl}/${encodeURIComponent(project)}/_wiki/wikis/${encodeURIComponent(w.id)}`,
    };
  });
  return rows.sort((a, c) => a.project.localeCompare(c.project, undefined, { sensitivity: "base" }) || (a.kind === c.kind ? 0 : a.kind === "project" ? -1 : 1) || a.name.localeCompare(c.name, undefined, { sensitivity: "base" }));
}

interface WikisRaw {
  wikis: RawWiki[];
  projects: [string, string][];
  repos: [string, string][];
}

async function wikisRaw(b: Browse): Promise<{ data: WikisRaw; meta: ReadMeta }> {
  return guarded(b, "wikis", () =>
    cached(b, `wikis|${b.org}`, TTL.lists, async () => {
      const [wikis, projects] = await Promise.all([
        b.client.request<{ value?: RawWiki[] }>("GET", "wiki/wikis", { orgLevel: true }).then((r) => r.data.value ?? []),
        b.client.request<{ value?: { id: string; name: string }[] }>("GET", "projects", { orgLevel: true, query: { $top: 1000 } }).then((r) => r.data.value ?? []),
      ]);
      // the repository names only when there is a code wiki (one call for the organisation)
      const repos = wikis.some((w) => w.type === "codeWiki")
        ? await b.client.request<{ value?: { id: string; name: string }[] }>("GET", "git/repositories", { orgLevel: true }).then((r) => r.data.value ?? [])
        : [];
      return { wikis, projects: projects.map((p) => [p.id.toLowerCase(), p.name] as [string, string]), repos: repos.map((r) => [r.id.toLowerCase(), r.name] as [string, string]) };
    }),
  );
}

export async function wikiList(b: Browse): Promise<WikisResult> {
  const { data, meta } = await wikisRaw(b);
  const wikis = mapWikis(b, data.wikis, new Map(data.projects), new Map(data.repos));
  const per = new Map<string, number>();
  for (const w of wikis) per.set(w.project, (per.get(w.project) ?? 0) + 1);
  return { ...meta, org: b.org, wikis, projects: [...per].map(([name, n]) => ({ name, wikis: n })) };
}

/** One wiki of a project, by name or id. */
export async function wikiOf(b: Browse, project: string, wiki: string): Promise<WikiInfo> {
  if (!project.trim() || !wiki.trim()) throw new BrowseError("badInput", "a project and a wiki are needed (--project P --wiki W)");
  const { data } = await wikisRaw(b);
  const rows = mapWikis(b, data.wikis, new Map(data.projects), new Map(data.repos));
  const want = wiki.toLowerCase();
  const inProject = rows.filter((w) => w.project.toLowerCase() === project.toLowerCase() || w.projectId.toLowerCase() === project.toLowerCase());
  const w = inProject.find((x) => x.name.toLowerCase() === want || x.id.toLowerCase() === want);
  if (!w) {
    if (!b.refresh) return wikiOf({ ...b, refresh: true }, project, wiki); // a wiki made since the list was read
    throw new BrowseError("notFound", `wiki '${wiki}' not found in project '${project}'${inProject.length ? `; there: ${inProject.map((x) => x.name).join(", ")}` : ""}`);
  }
  const raw = data.wikis.find((x) => x.id === w.id);
  return { ...w, gitBranch: w.branch ?? raw?.versions?.[0]?.version ?? "wikiMaster" };
}

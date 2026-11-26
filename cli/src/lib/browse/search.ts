import {
  BrowseError,
  cached,
  cacheRead,
  cacheWrite,
  guarded,
  kindOf,
  normPath,
  pool,
  repoClientOf,
  TTL,
  type Browse,
  type ReadMeta,
} from "./core.js";
import { browseProjects, clonesOf, readFileAt, type Clone } from "./read.js";

/**
 * Ctrl+P and code search over every repository. Both use Azure DevOps Code Search (almsearch) when the organisation has
 * it; Ctrl+P falls back to the trees of the repositories you opened recently or marked as favourite (kept per commit).
 */

interface RawHit {
  fileName: string;
  path: string;
  project?: { name?: string };
  repository?: { name?: string };
  versions?: { branchName?: string; changeId?: string }[];
  matches?: { content?: { charOffset: number; length: number }[]; fileName?: { charOffset: number; length: number }[] };
}

/** Code Search is a POST that only reads. A 404 (or the "not installed" message) means the organisation has no Code Search. */
async function codeSearch(b: Browse, body: object): Promise<{ count?: number; results?: RawHit[] }> {
  try {
    return await b.client.forService("almsearch").request<{ count?: number; results?: RawHit[] }>("POST", "search/codesearchresults", { body, orgLevel: true, query: { "api-version": "7.1" } }).then((r) => r.data);
  } catch (e) {
    const m = (e as Error).message;
    if (/\(404\)|not installed|SearchServiceNotAvailable|extension.*search|is not enabled/i.test(m)) throw new BrowseError("searchUnavailable", "Code Search is not available in this Azure DevOps organisation (an administrator installs it from the Marketplace)");
    throw e;
  }
}

const cloneOf = (clones: Map<string, Clone>, org: string, project: string, repo: string) => clones.get(`${org}/${project}/${repo}`.toLowerCase()) ?? null;

// ---- recent and favourite repositories (for the Ctrl+P fallback) -----------------------------------------------------

const recentKey = (b: Browse) => `recent-repos|${b.org}`;

/** Remembers a repository you opened in the browser (the last 20). */
export function rememberRepo(b: Browse, project: string, repo: string): void {
  const now = b.now();
  const list = cacheRead<{ project: string; repo: string }[]>(b.env, recentKey(b), TTL.forever, now)?.data ?? [];
  const next = [{ project, repo }, ...list.filter((x) => !(x.project.toLowerCase() === project.toLowerCase() && x.repo.toLowerCase() === repo.toLowerCase()))].slice(0, 20);
  cacheWrite(b.env, recentKey(b), next, now);
}

export const recentRepos = (b: Browse) => cacheRead<{ project: string; repo: string }[]>(b.env, recentKey(b), TTL.forever, b.now())?.data ?? [];

// ---- Ctrl+P ----------------------------------------------------------------------------------------------------------

export interface FindRow {
  name: string;
  path: string;
  project: string;
  repo: string;
  clone: Clone | null;
}

export interface FindResult extends ReadMeta {
  route: "codeSearch" | "treeCache";
  results: FindRow[];
  searched: { repos: number | null; notSearched: { project: string; repo: string; reason: string }[] };
}

/** File-name match score: exact name, then prefix, then word start, then anywhere, then a fuzzy subsequence; 0 = no match. */
export function nameScore(name: string, q: string): number {
  const n = name.toLowerCase();
  const s = q.toLowerCase();
  if (!s) return 0;
  if (n === s) return 100;
  if (n.startsWith(s)) return 80;
  if (new RegExp(`(^|[._\\-/ ])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(n)) return 60;
  if (n.includes(s)) return 40;
  let i = 0;
  for (const ch of n) if (ch === s[i]) i++;
  return i === s.length ? 10 : 0;
}

export function rankFind(rows: FindRow[], q: string, top: number): FindRow[] {
  const query = q.replace(/^.*\//, "");
  return rows
    .map((r) => ({ r, s: nameScore(r.name, query) + (q.includes("/") && r.path.toLowerCase().includes(q.toLowerCase()) ? 20 : 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => Number(!!b.r.clone) - Number(!!a.r.clone) || b.s - a.s || a.r.path.length - b.r.path.length || a.r.path.localeCompare(b.r.path))
    .slice(0, top)
    .map((x) => x.r);
}

async function treeOf(b: Browse, project: string, repo: string, branch: string): Promise<string[]> {
  const rc = repoClientOf(b, project, repo);
  // which commit the branch is on (2 min), then the tree of that commit (for good)
  const head = await cached(b, `head|${b.org}|${project}|${repo}|${branch}`, TTL.lists, async () => {
    const r = await rc.get<{ value?: { objectId: string }[] }>(`${rc.repoPath()}/refs`, { filter: `heads/${branch}` });
    return r.value?.[0]?.objectId ?? "";
  });
  if (!head.data) return [];
  return (
    await cached(b, `tree|${b.org}|${project}|${repo}|${head.data}`, TTL.forever, async () => {
      const r = await rc.get<{ value?: { path: string; gitObjectType: string }[] }>(`${rc.repoPath()}/items`, { scopePath: "/", recursionLevel: "Full", "versionDescriptor.version": head.data, "versionDescriptor.versionType": "commit" });
      return (r.value ?? []).filter((x) => x.gitObjectType === "blob").map((x) => x.path);
    })
  ).data;
}

export async function browseFind(b: Browse, o: { query: string; top?: number; repos?: string[] }): Promise<FindResult> {
  const q = o.query.trim();
  if (!q) throw new BrowseError("badInput", "aihub browse find needs --query <file name>");
  const top = Math.min(Math.max(o.top ?? 50, 1), 200);
  const clones = clonesOf(b);
  const readAt = new Date(b.now()).toISOString();
  try {
    const name = q.replace(/^.*\//, "");
    const r = await guarded(b, "search", () => codeSearch(b, { searchText: `file:*${name}*`, $skip: 0, $top: 200, includeFacets: false }));
    const rows: FindRow[] = (r.results ?? []).map((x) => {
      const project = x.project?.name ?? "";
      const repo = x.repository?.name ?? "";
      return { name: x.fileName, path: normPath(x.path), project, repo, clone: cloneOf(clones, b.org, project, repo) };
    });
    return { readAt, cached: false, route: "codeSearch", results: rankFind(rows, q, top), searched: { repos: null, notSearched: [] } };
  } catch (e) {
    if (kindOf(e) !== "searchUnavailable") throw e;
  }
  // fallback: the trees of the favourite and recent repositories
  const { projects } = await browseProjects(b);
  const want = [...(o.repos ?? []).map((s) => ({ project: s.split("/")[0], repo: s.split("/").slice(1).join("/") })), ...recentRepos(b)];
  const seen = new Set<string>();
  const pick = want.filter((x) => {
    const k = `${x.project}/${x.repo}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const notSearched: FindResult["searched"]["notSearched"] = [];
  const all = projects.flatMap((p) => p.repos);
  for (const r of all) if (!pick.some((x) => x.project.toLowerCase() === r.project.toLowerCase() && x.repo.toLowerCase() === r.repo.toLowerCase())) notSearched.push({ project: r.project, repo: r.repo, reason: r.canOpen ? "never opened" : (r.reason ?? "noAccess") });
  const rows: FindRow[] = [];
  let searched = 0;
  await pool(pick.slice(0, 20), 4, async (x) => {
    const row = all.find((r) => r.project.toLowerCase() === x.project.toLowerCase() && r.repo.toLowerCase() === x.repo.toLowerCase());
    if (!row || !row.canOpen || !row.defaultBranch) return;
    try {
      const paths = await treeOf(b, row.project, row.repo, row.defaultBranch);
      searched++;
      for (const p of paths) rows.push({ name: p.split("/").pop() ?? p, path: p, project: row.project, repo: row.repo, clone: row.clone });
    } catch (e) {
      notSearched.push({ project: row.project, repo: row.repo, reason: kindOf(e) });
    }
  });
  return { readAt, cached: false, route: "treeCache", results: rankFind(rows, q, top), searched: { repos: searched, notSearched } };
}

// ---- code search -----------------------------------------------------------------------------------------------------

export interface SearchMatch {
  line: number;
  text: string;
  ranges: [number, number][];
}

export interface SearchResult extends ReadMeta {
  count: number;
  results: { project: string; repo: string; path: string; branch: string; commit: string | null; clone: Clone | null; matches: SearchMatch[] }[];
  notSearched: { what: string; reason: string }[];
}

/** Turns Code Search's character offsets into lines with the marked ranges (1-based lines, 0-based columns). */
export function linesOf(content: string, hits: { charOffset: number; length: number }[], maxLines = 20): SearchMatch[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === "\n") starts.push(i + 1);
  const lineAt = (off: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const byLine = new Map<number, [number, number][]>();
  for (const h of [...hits].sort((a, b) => a.charOffset - b.charOffset)) {
    const ln = lineAt(h.charOffset);
    const col = h.charOffset - starts[ln];
    const list = byLine.get(ln) ?? [];
    list.push([col, col + h.length]);
    byLine.set(ln, list);
  }
  return [...byLine.entries()].slice(0, maxLines).map(([ln, ranges]) => {
    const end = ln + 1 < starts.length ? starts[ln + 1] - 1 : content.length;
    const text = content.slice(starts[ln], end).replace(/\r$/, "");
    return { line: ln + 1, text: text.length > 400 ? text.slice(0, 400) : text, ranges };
  });
}

export async function browseSearch(b: Browse, o: { text: string; project?: string; repo?: string; path?: string; ext?: string[]; top?: number }): Promise<SearchResult> {
  const text = o.text.trim();
  if (!text) throw new BrowseError("badInput", "aihub browse search needs --text <text>");
  const top = Math.min(Math.max(o.top ?? 25, 1), 100);
  const filters: Record<string, string[]> = {};
  if (o.project) filters.Project = [o.project];
  if (o.repo) {
    if (!o.project) throw new BrowseError("badInput", "--repo needs --project too (Code Search filters a repository within a project)");
    filters.Repository = [o.repo];
  }
  if (o.path) filters.Path = [normPath(o.path)];
  const ext = (o.ext ?? []).map((e) => e.replace(/^\*?\./, "").trim()).filter(Boolean);
  const searchText = ext.length ? `${text} ${ext.length === 1 ? `ext:${ext[0]}` : `(${ext.map((e) => `ext:${e}`).join(" OR ")})`}` : text;
  const clones = clonesOf(b);
  const { data, meta } = await guarded(b, "search", () =>
    cached(b, `search|${b.org}|${searchText}|${JSON.stringify(filters)}|${top}`, TTL.short, () => codeSearch(b, { searchText, $skip: 0, $top: top, filters, includeFacets: false })),
  );
  const notSearched: SearchResult["notSearched"] = [];
  const results = await pool(data.results ?? [], 6, async (x) => {
    const project = x.project?.name ?? "";
    const repo = x.repository?.name ?? "";
    const commit = x.versions?.[0]?.changeId ?? null;
    const path = normPath(x.path);
    let matches: SearchMatch[] = [];
    const hits = x.matches?.content ?? [];
    if (hits.length && commit) {
      try {
        // the lines come from the file at the indexed commit (kept for good)
        const f = await cached(b, `file|${b.org}|${project}|${repo}|${path}||commit:${commit}`, TTL.forever, () => readFileAt(b, project, repo, path, { name: commit, kind: "commit" }));
        if (f.data.content !== null) matches = linesOf(f.data.content, hits);
      } catch (e) {
        notSearched.push({ what: `${project}/${repo}${path}`, reason: `lines not read: ${kindOf(e)}` });
      }
    }
    return { project, repo, path, branch: x.versions?.[0]?.branchName ?? "", commit, clone: cloneOf(clones, b.org, project, repo), matches };
  });
  if ((data.count ?? 0) > results.length) notSearched.push({ what: `${(data.count ?? 0) - results.length} more file(s)`, reason: `only the first ${top} are shown (--top)` });
  return { ...meta, count: data.count ?? results.length, results, notSearched };
}

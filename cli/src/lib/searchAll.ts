import { BrowseError, cached, guarded, kindOf, pool, repoClientOf, TTL, type Browse, type BrowseErrorKind } from "./browse/core.js";
import { browseProjects, type RepoRow } from "./browse/read.js";
import { browseFind, browseSearch, nameScore, recentRepos } from "./browse/search.js";

/**
 * Search Everywhere over Azure DevOps: one text, every kind of thing the user can open (repositories, file names, text in
 * files, branches, work items, pull requests, wiki pages, pipelines), all within the projects the user can read. Every kind
 * is looked up at the same time and fails on its own: a kind that fails (or has no search service) is a part with an
 * error, the others still come. Every read goes through the browse cache (lists for hours, searches for 2 minutes).
 */

export const SEARCH_KINDS = ["repos", "files", "text", "branches", "workitems", "prs", "wiki", "pipelines"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export interface SearchHit {
  kind: SearchKind;
  /** the line the user reads first: a repository, a file name, a branch, "#123 Title", a page title, a pipeline */
  title: string;
  /** where it is: project/repo, a path, a folder, the matching line of a file */
  detail: string;
  project?: string;
  repo?: string;
  path?: string;
  branch?: string;
  /** a work item or pull request number, a pipeline id */
  id?: number;
  /** a work item type (User Story, Bug, Task) or pull request status (active, completed, abandoned) */
  type?: string;
  state?: string;
  wiki?: string;
  line?: number;
  /** a closed work item (Done, Closed, Removed) or a completed / abandoned pull request: shown last and greyed */
  closed?: boolean;
  /** a repository cloned on this PC: where (the UI shows "cloned" and the path as its tooltip) */
  localPath?: string;
  url?: string;
}

export interface SearchPart {
  kind: SearchKind;
  status: "ok" | "failed";
  /** how it was searched: codeSearch, local (ripgrep in the clones), treeCache, wikiSearch, titles, wiql, id, lists */
  route?: string;
  count: number;
  /** more than `results` were found: the tab of this kind shows more */
  more: boolean;
  results: SearchHit[];
  /** what was not searched (repositories not cloned, projects over the limit) */
  note?: string;
  error?: { kind: BrowseErrorKind | "timeout"; message: string };
  tookMs: number;
}

export interface SearchAllResult {
  org: string;
  text: string;
  kinds: SearchPart[];
}

export interface SearchAllOptions {
  text: string;
  kinds?: SearchKind[];
  /** results per kind (5 for the All tab, 50 for one tab) */
  top?: number;
  project?: string;
  /** each part as soon as it is ready (the extension shows the groups one by one) */
  onPart?: (p: SearchPart) => void;
  /** a kind that takes longer than this fails with `timeout`, the others still come */
  timeoutMs?: number;
}

/** At most this many projects are read for the per-project kinds (pull requests, pipelines). */
export const MAX_PROJECTS = 25;
/** Branches are looked up in the repositories cloned on this PC and the ones opened lately, at most this many. */
export const MAX_BRANCH_REPOS = 12;

export function parseKinds(s: string | undefined): SearchKind[] {
  if (!s) return [...SEARCH_KINDS];
  const alias: Record<string, SearchKind> = { repositories: "repos", repo: "repos", file: "files", code: "text", branch: "branches", items: "workitems", stories: "workitems", "work-items": "workitems", pr: "prs", "pull-requests": "prs", pullrequests: "prs", wikis: "wiki", pipeline: "pipelines" };
  const out: SearchKind[] = [];
  for (const raw of s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    const k = (SEARCH_KINDS as readonly string[]).includes(raw) ? (raw as SearchKind) : alias[raw];
    if (!k) throw new BrowseError("badInput", `unknown kind '${raw}'; kinds: ${SEARCH_KINDS.join(", ")}`);
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** `#123` or `123`: a number to look up exactly. */
export const numberOf = (text: string): number | undefined => {
  const m = /^#?(\d{1,9})$/.exec(text.trim());
  return m ? Number(m[1]) : undefined;
};

/** Ranks rows by the score of a name (nameScore: exact, prefix, word start, anywhere, fuzzy), shortest first on a tie. */
function rank<T>(rows: T[], name: (r: T) => string, q: string): T[] {
  return rows
    .map((r) => ({ r, s: nameScore(name(r), q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || name(a.r).length - name(b.r).length || name(a.r).localeCompare(name(b.r)))
    .map((x) => x.r);
}

const contains = (s: string | undefined, q: string) => !!s && s.toLowerCase().includes(q.toLowerCase());

type Found = Omit<SearchPart, "kind" | "status" | "tookMs" | "more" | "count"> & { count?: number };

async function allRepos(b: Browse, project?: string): Promise<RepoRow[]> {
  const { projects } = await browseProjects(b);
  return projects.filter((p) => !project || p.name.toLowerCase() === project.toLowerCase()).flatMap((p) => p.repos);
}

async function projectNames(b: Browse, project?: string): Promise<{ names: string[]; skipped: number }> {
  const { projects } = await browseProjects(b);
  const all = projects.map((p) => p.name).filter((n) => !project || n.toLowerCase() === project.toLowerCase());
  return { names: all.slice(0, MAX_PROJECTS), skipped: Math.max(all.length - MAX_PROJECTS, 0) };
}

// ---- the kinds -------------------------------------------------------------------------------------------------------

async function repos(b: Browse, q: string, top: number, project?: string): Promise<Found> {
  const { projects } = await browseProjects(b);
  const inScope = projects.filter((p) => !project || p.name.toLowerCase() === project.toLowerCase());
  const repoHits = rank(inScope.flatMap((p) => p.repos).filter((r) => r.canOpen), (r) => r.repo, q).map<SearchHit>((r) => ({
    kind: "repos",
    title: r.repo,
    detail: r.project,
    ...(r.clone ? { localPath: r.clone.path } : {}),
    project: r.project,
    repo: r.repo,
    branch: r.defaultBranch || undefined,
    type: "repository",
    url: r.webUrl,
  }));
  const projectHits = rank(inScope, (p) => p.name, q).map<SearchHit>((p) => ({ kind: "repos", title: p.name, detail: `project, ${p.repos.length} repositor${p.repos.length === 1 ? "y" : "ies"}`, project: p.name, type: "project", url: p.webUrl }));
  const all = [...projectHits, ...repoHits];
  return { route: "lists", count: all.length, results: all.slice(0, top) };
}

async function files(b: Browse, q: string, top: number): Promise<Found> {
  const r = await browseFind(b, { query: q, top: Math.max(top + 1, 10) });
  const hits = r.results.map<SearchHit>((x) => ({ kind: "files", title: x.name, detail: `${x.project}/${x.repo}${x.path}`, project: x.project, repo: x.repo, path: x.path }));
  const not = r.searched.notSearched.length;
  return { route: r.route, count: hits.length, results: hits.slice(0, top), ...(r.route === "treeCache" && not ? { note: `no Code Search: ${r.searched.repos ?? 0} recently opened repositories searched, ${not} not` } : {}) };
}

async function text(b: Browse, q: string, top: number, project?: string): Promise<Found> {
  if (q.length < 2) return { route: "none", count: 0, results: [], note: "text needs at least 2 characters" };
  const r = await browseSearch(b, { text: q, top: Math.max(top, 5), project });
  const hits = r.results.map<SearchHit>((x) => {
    const m = x.matches[0];
    return {
      kind: "text",
      title: `${x.path.split("/").pop() ?? x.path}${m ? `:${m.line}` : ""}`,
      detail: m ? m.text.trim().slice(0, 160) : `${x.project}/${x.repo}${x.path}`,
      project: x.project,
      repo: x.repo,
      path: x.path,
      branch: x.branch ? x.branch.replace(/^refs\/heads\//, "") : undefined,
      line: m?.line,
    };
  });
  const note = r.route === "local" ? `no Code Search: only the clones on this PC were searched${r.tool ? ` (${r.tool})` : ""}` : undefined;
  return { route: r.route, count: r.count, results: hits.slice(0, top), ...(note ? { note } : {}) };
}

async function branches(b: Browse, q: string, top: number, project?: string): Promise<Found> {
  const all = (await allRepos(b, project)).filter((r) => r.canOpen && r.defaultBranch);
  const recent = recentRepos(b);
  const key = (p: string, r: string) => `${p}/${r}`.toLowerCase();
  const wanted = new Set([...all.filter((r) => r.clone).map((r) => key(r.project, r.repo)), ...recent.map((r) => key(r.project, r.repo))]);
  // a repository whose name matches is searched too: "orders" finds the branches of repo "orders-etl"
  for (const r of all) if (nameScore(r.repo, q) >= 40) wanted.add(key(r.project, r.repo));
  const pick = all.filter((r) => wanted.has(key(r.project, r.repo))).slice(0, MAX_BRANCH_REPOS);
  const skipped = all.length - pick.length;
  const rows: SearchHit[] = [];
  await pool(pick, 4, async (r) => {
    const rc = repoClientOf(b, r.project, r.repo);
    try {
      const refs = await guarded(b, `${r.project}/${r.repo}`, () =>
        cached(b, `branch-search|${b.org}|${r.project}|${r.repo}|${q.toLowerCase()}`, TTL.short, async () => {
          const x = await rc.get<{ value?: { name: string; objectId: string }[] }>(`${rc.repoPath()}/refs`, { filter: "heads/", filterContains: q, $top: 50 });
          return (x.value ?? []).map((v) => v.name.replace(/^refs\/heads\//, ""));
        }),
      );
      for (const name of refs.data) rows.push({ kind: "branches", title: name, detail: `${r.project}/${r.repo}${name === r.defaultBranch ? "  (default)" : ""}`, project: r.project, repo: r.repo, branch: name });
    } catch {
      /* one repository that cannot be read does not stop the others */
    }
  });
  const ranked = rank(rows, (h) => h.title.split("/").pop() ?? h.title, q.split("/").pop() ?? q);
  // a name that only contains the text (not by the fuzzy score) still counts: the server matched it
  const rest = rows.filter((h) => !ranked.includes(h));
  const out = [...ranked, ...rest];
  return { route: "refs", count: out.length, results: out.slice(0, top), ...(skipped > 0 ? { note: `searched ${pick.length} repositories (cloned, opened lately or with a matching name), not the other ${skipped}` } : {}) };
}

interface RawItem {
  id: number;
  fields?: Record<string, unknown>;
}

const ITEM_FIELDS = ["System.Id", "System.Title", "System.WorkItemType", "System.State", "System.TeamProject", "System.ChangedDate"];

/** States that mean the work is over, in the processes of Azure DevOps (Agile, Scrum, CMMI, Basic). */
export const CLOSED_STATES = ["done", "closed", "removed", "completed", "cut", "inactive"];

/**
 * How well a title matches the text: the whole title, its start, a word start, anywhere, every word somewhere; 0 = not at all.
 * Ranks work items and pull requests within open and closed.
 */
export function titleScore(title: string, q: string): number {
  const t = title.toLowerCase().trim();
  const s = q.toLowerCase().replace(/^[#!]/, "").trim();
  if (!s) return 0;
  if (t === s) return 100;
  if (t.startsWith(s)) return 80;
  if (new RegExp(`(^|[^a-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t)) return 60;
  if (t.includes(s)) return 40;
  const words = s.split(/\s+/).filter(Boolean);
  return words.length > 1 && words.every((w) => t.includes(w)) ? 20 : 0;
}

/** Open before closed; within each the best title match, then the most recently changed. */
export function rankItems<T>(rows: T[], o: { title: (x: T) => string; closed: (x: T) => boolean; changed: (x: T) => number }, q: string): T[] {
  return rows
    .map((x) => ({ x, c: o.closed(x) ? 1 : 0, s: titleScore(o.title(x), q), t: o.changed(x) }))
    .sort((a, b) => a.c - b.c || b.s - a.s || b.t - a.t)
    .map((r) => r.x);
}

const itemClosed = (x: RawItem) => CLOSED_STATES.includes(String(x.fields?.["System.State"] ?? "").toLowerCase());
const itemChanged = (x: RawItem) => Date.parse(String(x.fields?.["System.ChangedDate"] ?? "")) || 0;

function itemHit(b: Browse, x: RawItem): SearchHit {
  const f = x.fields ?? {};
  const project = String(f["System.TeamProject"] ?? "");
  return {
    kind: "workitems",
    title: `#${x.id} ${String(f["System.Title"] ?? "")}`,
    detail: [f["System.WorkItemType"], f["System.State"], project].filter(Boolean).join(" · "),
    id: x.id,
    type: String(f["System.WorkItemType"] ?? "") || undefined,
    state: String(f["System.State"] ?? "") || undefined,
    project: project || undefined,
    ...(itemClosed(x) ? { closed: true } : {}),
    url: `${b.client.remote.orgUrl}/${encodeURIComponent(project)}/_workitems/edit/${x.id}`,
  };
}

/** WIQL needs the text inside single quotes: a quote is doubled. */
export const wiqlText = (s: string) => s.replace(/'/g, "''");

async function workitems(b: Browse, q: string, top: number, project?: string): Promise<Found> {
  const n = numberOf(q);
  const out: SearchHit[] = [];
  if (n) {
    try {
      const x = await cached(b, `wi|${b.org}|${n}`, TTL.short, () => b.client.request<RawItem>("GET", `wit/workitems/${n}`, { orgLevel: true, query: { fields: ITEM_FIELDS.join(",") } }).then((r) => r.data));
      out.push(itemHit(b, x.data));
    } catch (e) {
      if (kindOf(e) !== "notFound") throw e;
    }
  }
  if (q.length < 2 && !n) return { route: "wiql", count: out.length, results: out };
  const where = [`[System.Title] CONTAINS '${wiqlText(q)}'`, ...(project ? [`[System.TeamProject] = '${wiqlText(project)}'`] : [])].join(" AND ");
  const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${where} ORDER BY [System.ChangedDate] DESC`;
  const found = await cached(b, `wi-search|${b.org}|${project ?? ""}|${q.toLowerCase()}`, TTL.short, async () => {
    const ids = await b.client.request<{ workItems?: { id: number }[] }>("POST", "wit/wiql", { orgLevel: true, body: { query: wiql }, query: { $top: 50 } }).then((r) => (r.data.workItems ?? []).map((w) => w.id));
    if (!ids.length) return { ids: [] as number[], items: [] as RawItem[] };
    const items = await b.client.request<{ value?: RawItem[] }>("POST", "wit/workitemsbatch", { orgLevel: true, body: { ids: ids.slice(0, 50), fields: ITEM_FIELDS } }).then((r) => r.data.value ?? []);
    return { ids, items };
  });
  // the exact #number first (above), then open before Done/Closed, the best title match, the most recently changed
  const rows = found.data.items.filter((x) => x.id !== n);
  for (const x of rankItems(rows, { title: (r) => String(r.fields?.["System.Title"] ?? ""), closed: itemClosed, changed: itemChanged }, q)) out.push(itemHit(b, x));
  return { route: n ? "id+wiql" : "wiql", count: out.length, results: out.slice(0, top) };
}

interface RawPr {
  pullRequestId: number;
  title?: string;
  status?: string;
  sourceRefName?: string;
  targetRefName?: string;
  isDraft?: boolean;
  repository?: { name?: string; project?: { name?: string } };
}

function prHit(b: Browse, x: RawPr, projectName?: string): SearchHit {
  const project = x.repository?.project?.name ?? projectName ?? "";
  const repo = x.repository?.name ?? "";
  const src = (x.sourceRefName ?? "").replace(/^refs\/heads\//, "");
  const tgt = (x.targetRefName ?? "").replace(/^refs\/heads\//, "");
  return {
    kind: "prs",
    title: `!${x.pullRequestId} ${x.title ?? ""}`,
    detail: [`${project}/${repo}`, src && tgt ? `${src} → ${tgt}` : src, x.isDraft ? "draft" : x.status].filter(Boolean).join(" · "),
    id: x.pullRequestId,
    project,
    repo,
    branch: src || undefined,
    state: x.isDraft && x.status === "active" ? "draft" : x.status,
    ...(x.status && x.status !== "active" ? { closed: true } : {}),
    url: `${b.client.remote.orgUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${x.pullRequestId}`,
  };
}

async function prs(b: Browse, q: string, top: number, project?: string): Promise<Found> {
  const n = numberOf(q.replace(/^!/, ""));
  const out: SearchHit[] = [];
  if (n) {
    try {
      const x = await cached(b, `pr|${b.org}|${n}`, TTL.short, () => b.client.request<RawPr>("GET", `git/pullrequests/${n}`, { orgLevel: true }).then((r) => r.data));
      out.push(prHit(b, x.data));
    } catch (e) {
      if (kindOf(e) !== "notFound") throw e;
    }
  }
  const { names, skipped } = await projectNames(b, project);
  const rows: { pr: RawPr; project: string }[] = [];
  let failed = 0;
  await pool(names, 4, async (p) => {
    try {
      const list = await guarded(b, p, () =>
        cached(b, `pr-list|${b.org}|${p}`, TTL.short, () =>
          b.client.forProject(p).get<{ value?: RawPr[] }>("git/pullrequests", { "searchCriteria.status": "all", $top: 200 }).then((r) => r.value ?? []),
        ),
      );
      for (const pr of list.data) rows.push({ pr, project: p });
    } catch {
      failed++;
    }
  });
  const q2 = q.replace(/^[!#]/, "");
  const match = (x: RawPr) => contains(x.title, q2) || contains(x.sourceRefName?.replace(/^refs\/heads\//, ""), q2) || (n !== undefined && x.pullRequestId === n);
  // active before completed and abandoned; within each the best title match, then the newest
  const hits = rankItems(
    rows.filter((r) => match(r.pr) && r.pr.pullRequestId !== n),
    { title: (r) => r.pr.title ?? "", closed: (r) => r.pr.status !== "active", changed: (r) => r.pr.pullRequestId },
    q2,
  ).map((r) => prHit(b, r.pr, r.project));
  out.push(...hits);
  const notes = [skipped ? `${skipped} projects not searched (at most ${MAX_PROJECTS})` : "", failed ? `${failed} project${failed === 1 ? "" : "s"} could not be read` : ""].filter(Boolean);
  if (failed && failed === names.length && !out.length) throw new BrowseError("failed", "no project's pull requests could be read");
  return { route: n ? "id+lists" : "lists", count: out.length, results: out.slice(0, top), ...(notes.length ? { note: notes.join("; ") } : {}) };
}

async function wiki(b: Browse, q: string, top: number, project?: string): Promise<Found> {
  const { wikiSearch } = await import("./wiki/search.js");
  try {
    const r = await wikiSearch(b, { text: q, project, top: Math.max(top, 5) });
    const hits = r.results.map<SearchHit>((x) => ({
      kind: "wiki",
      title: x.path.split("/").filter(Boolean).pop() ?? x.path,
      detail: x.hits[0]?.text.trim().slice(0, 160) || `${x.project} · ${x.wiki.name}${x.path}`,
      project: x.project,
      wiki: x.wiki.name,
      path: x.path,
    }));
    return { route: "wikiSearch", count: r.count, results: hits.slice(0, top) };
  } catch (e) {
    if (kindOf(e) !== "searchUnavailable") throw e;
  }
  // no search service: the page titles of every wiki (one full tree per wiki, kept for hours)
  const { wikiList } = await import("./wiki/core.js");
  const wikis = (await wikiList(b)).wikis.filter((w) => !project || w.project.toLowerCase() === project.toLowerCase()).slice(0, 10);
  const rows: SearchHit[] = [];
  await pool(wikis, 3, async (w) => {
    try {
      const tree = await cached(b, `wiki-titles|${b.org}|${w.id}`, TTL.lists, async () => {
        const c = b.client.forProject(w.project);
        const version = w.kind === "code" && w.branch ? { "versionDescriptor.version": w.branch, "versionDescriptor.versionType": "branch" } : {};
        const root = await c.get<{ path: string; subPages?: unknown[] }>(`wiki/wikis/${encodeURIComponent(w.id)}/pages`, { path: "/", recursionLevel: "full", ...version });
        const paths: string[] = [];
        const walk = (p: { path: string; subPages?: unknown[] }) => {
          if (p.path && p.path !== "/") paths.push(p.path);
          for (const s of (p.subPages ?? []) as { path: string; subPages?: unknown[] }[]) walk(s);
        };
        walk(root);
        return paths;
      });
      for (const p of tree.data) rows.push({ kind: "wiki", title: p.split("/").pop() ?? p, detail: `${w.project} · ${w.name}${p}`, project: w.project, wiki: w.name, path: p });
    } catch {
      /* a wiki that cannot be read does not stop the others */
    }
  });
  const ranked = rank(rows, (h) => h.title, q);
  return { route: "titles", count: ranked.length, results: ranked.slice(0, top), note: "no wiki search in this organisation: page titles only" };
}

async function pipelines(b: Browse, q: string, top: number, project?: string): Promise<Found> {
  const { browsePipelines } = await import("./browse/pipelines.js");
  const { names, skipped } = await projectNames(b, project);
  const rows: SearchHit[] = [];
  let failed = 0;
  await pool(names, 4, async (p) => {
    try {
      for (const x of (await browsePipelines(b, p)).pipelines) {
        const run = x.latestRun ? `${x.latestRun.state} on ${x.latestRun.branch}` : "never run";
        rows.push({ kind: "pipelines", title: x.name, detail: `${p}${x.folder === "\\" ? "" : ` ${x.folder}`} · ${run}`, project: p, repo: x.repo ?? undefined, id: x.id, state: x.latestRun?.state, path: x.yamlPath ?? undefined, url: x.webUrl });
      }
    } catch {
      failed++;
    }
  });
  const ranked = rank(rows, (h) => h.title, q);
  const extra = rows.filter((h) => !ranked.includes(h) && contains(h.detail, q));
  const out = [...ranked, ...extra];
  if (failed && failed === names.length) throw new BrowseError("failed", "no project's pipelines could be read");
  const notes = [skipped ? `${skipped} projects not searched (at most ${MAX_PROJECTS})` : "", failed ? `${failed} project${failed === 1 ? "" : "s"} could not be read` : ""].filter(Boolean);
  return { route: "lists", count: out.length, results: out.slice(0, top), ...(notes.length ? { note: notes.join("; ") } : {}) };
}

const RUN: Record<SearchKind, (b: Browse, q: string, top: number, project?: string) => Promise<Found>> = {
  repos,
  files: (b, q, top) => files(b, q, top),
  text,
  branches,
  workitems,
  prs,
  wiki,
  pipelines,
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, reject) => (t = setTimeout(() => reject(Object.assign(new Error(`took longer than ${Math.round(ms / 1000)} s`), { timeout: true })), ms)))]).finally(() => clearTimeout(t));
}

/** Every asked kind at the same time; each answers on its own (onPart) and the whole answer has them in the asked order. */
export async function searchAll(b: Browse, o: SearchAllOptions): Promise<SearchAllResult> {
  const q = (o.text ?? "").trim();
  if (!q) throw new BrowseError("badInput", "what to search? aihub search all <text>");
  const kinds = o.kinds?.length ? o.kinds : [...SEARCH_KINDS];
  const top = Math.min(Math.max(o.top ?? 5, 1), 100);
  const timeoutMs = o.timeoutMs ?? 30_000;
  const parts = await Promise.all(
    kinds.map(async (kind): Promise<SearchPart> => {
      const t0 = Date.now();
      let part: SearchPart;
      try {
        const f = await withTimeout(RUN[kind](b, q, top, o.project), timeoutMs);
        const count = f.count ?? f.results.length;
        part = { kind, status: "ok", route: f.route, count, more: count > f.results.length, results: f.results, ...(f.note ? { note: f.note } : {}), tookMs: Date.now() - t0 };
      } catch (e) {
        const timeout = !!(e as { timeout?: boolean }).timeout;
        part = { kind, status: "failed", count: 0, more: false, results: [], error: { kind: timeout ? "timeout" : kindOf(e), message: String((e as Error)?.message ?? e).replace(/^aihub:\s*/, "") }, tookMs: Date.now() - t0 };
      }
      o.onPart?.(part);
      return part;
    }),
  );
  return { org: b.org, text: q, kinds: parts };
}

const LABEL: Record<SearchKind, string> = { repos: "Repositories", files: "Files", text: "Text", branches: "Branches", workitems: "Work Items", prs: "Pull Requests", wiki: "Wiki", pipelines: "Pipelines" };

/** The answer as text for a chat (the agent reads it): one group per kind, a failed kind says why. */
export function searchAllText(r: SearchAllResult): string {
  const lines: string[] = [];
  for (const p of r.kinds) {
    lines.push(`${LABEL[p.kind]}${p.status === "ok" ? ` (${p.count}${p.more ? ", more with --kinds " + p.kind + " --top 50" : ""})` : ""}`);
    if (p.status === "failed") lines.push(`  not searched: ${p.error?.message}`);
    else if (!p.results.length) lines.push("  nothing found");
    for (const h of p.results) lines.push(`  ${h.title}   ${h.detail}`);
    if (p.note) lines.push(`  (${p.note})`);
  }
  return lines.join("\n");
}

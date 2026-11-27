import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { BrowseError, kindOf, meOf, TTL, cached, type Browse } from "../browse/core.js";
import { hunks, type Hunk } from "../browse/lineDiff.js";
import { bumpGeneration, fileToName, generationOf, gitPathToPage, nameOf, nameToFile, pagePath, parentOf, relToWiki, webPageUrl, wikiOf, type WikiInfo } from "./core.js";
import { changeOf, commitsOf, fileOfPage, pagesApi, projectClient, type LastChange, type RawPage } from "./read.js";
import { templateText } from "./templates.js";
import { readZip } from "./zip.js";

const quoted = (etag: string) => (etag.startsWith('"') ? etag : `"${etag}"`);
const bare = (etag: string | null | undefined) => (etag ? etag.replace(/^W\//, "").replace(/"/g, "") : null);
const isStale = (e: unknown) => /\((409|412)\)|precondition|has been modified|version.*(conflict|mismatch)|WikiPageHasConflicts|out of date/i.test(String((e as Error)?.message ?? e));

function needProjectWiki(w: WikiInfo, what: string): void {
  if (w.kind === "code")
    throw new BrowseError("badInput", `${w.name} is a code wiki: ${what} goes through the repository (aihub browse push to a new branch and a pull request)`);
}

async function currentOf(b: Browse, w: WikiInfo, path: string): Promise<{ content: string; etag: string | null; lastChange: LastChange | null }> {
  const pc = projectClient(b, w);
  const r = await pc.request<RawPage>("GET", pagesApi(w), { query: { path, includeContent: true } });
  const me = await meOf(b);
  const commits = await commitsOf(b, w, fileOfPage(w, path, r.data.gitItemPath), w.gitBranch, 1).catch(() => []);
  return { content: (r.data.content ?? "").replace(/\r\n/g, "\n"), etag: bare(r.headers.get("etag")), lastChange: commits[0] ? changeOf(commits[0], me) : null };
}

/** The text of a blob of the wiki's repository (the version an edit started from), or null when it cannot be read. */
async function blobText(b: Browse, w: WikiInfo, objectId: string): Promise<string | null> {
  if (!/^[0-9a-f]{40}$/i.test(objectId)) return null;
  try {
    const r = await projectClient(b, w).request<string>("GET", `git/repositories/${encodeURIComponent(w.repoId)}/blobs/${objectId}`, { raw: true, query: { $format: "text" } });
    return r.data.replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

// ---- publish ---------------------------------------------------------------------------------------------------------

export type PublishResult =
  | { status: "published"; path: string; etag: string | null; version: string | null; webUrl: string; overwrote: boolean }
  | {
      status: "conflict";
      kind: "conflict";
      path: string;
      yourEtag: string;
      current: { content: string; etag: string | null; lastChange: LastChange | null };
      base: { content: string | null };
      theirs: { hunks: Hunk[] };
      mine: { hunks: Hunk[] };
    };

export async function wikiPublish(b: Browse, o: { project: string; wiki: string; path: string; content: string; etag?: string; comment?: string; force?: boolean }): Promise<PublishResult> {
  const w = await wikiOf(b, o.project, o.wiki);
  needProjectWiki(w, "a change");
  const path = pagePath(o.path);
  if (path === "/") throw new BrowseError("badInput", "which page? pass --path /Parent/Page");
  if (!o.etag && !o.force) throw new BrowseError("badInput", "--etag is needed (page.etag of aihub wiki browse page): it tells whether someone else changed the page meanwhile");
  const pc = projectClient(b, w);
  let etag = bare(o.etag);
  if (o.force) etag = (await currentOf(b, w, path)).etag; // Overwrite: on top of the newest version, on purpose
  const comment = (o.comment ?? "").trim();
  try {
    const r = await pc.request<RawPage>("PUT", pagesApi(w), { query: { path, ...(comment ? { comment } : {}) }, body: { content: o.content }, headers: etag ? { "If-Match": quoted(etag) } : {} });
    bumpGeneration(b, w.id);
    const commits = await commitsOf(b, w, fileOfPage(w, path, r.data.gitItemPath), w.gitBranch, 1).catch(() => []);
    return { status: "published", path, etag: bare(r.headers.get("etag")), version: commits[0]?.commitId ?? null, webUrl: webPageUrl(b, w, path), overwrote: !!o.force };
  } catch (e) {
    if (!isStale(e) || o.force) throw e;
    const current = await currentOf(b, w, path);
    const base = await blobText(b, w, etag ?? "");
    return {
      status: "conflict",
      kind: "conflict",
      path,
      yourEtag: etag ?? "",
      current,
      base: { content: base },
      theirs: { hunks: hunks(base ?? "", current.content) },
      mine: { hunks: hunks(base ?? current.content, o.content) },
    };
  }
}

// ---- a new page ------------------------------------------------------------------------------------------------------

export type CreateResult =
  | { status: "created"; path: string; etag: string | null; webUrl: string }
  | { status: "push"; path: string; content: string; code: { project: string; repo: string; branch: string; filePath: string; baseCommit: string } };

export async function wikiCreate(b: Browse, o: { project: string; wiki: string; parent?: string; name: string; template?: string; content?: string; comment?: string }): Promise<CreateResult> {
  const w = await wikiOf(b, o.project, o.wiki);
  const name = (o.name ?? "").trim();
  if (!name || /[\\/]/.test(name)) throw new BrowseError("badInput", "--name is the page name, without a slash (choose the parent with --parent)");
  const parent = pagePath(o.parent);
  const path = pagePath(`${parent === "/" ? "" : parent}/${name}`);
  let content: string;
  try {
    content = o.content ?? templateText(o.template, name);
  } catch (e) {
    throw new BrowseError("badInput", (e as Error).message);
  }
  const pc = projectClient(b, w);
  if (w.kind === "code") {
    if (!w.repo) throw new BrowseError("notFound", `the repository of ${w.name} cannot be read`);
    const parentFile = parent === "/" ? fileOfPage(w, "/", "/") : fileOfPage(w, parent).replace(/\.md$/i, "");
    // a file in a repository keeps a plain name: spaces become dashes, nothing is %-encoded
    const plain = name.replace(/[%:<>*?|"#\\]/g, "").trim().replace(/\s+/g, "-");
    const filePath = `${parentFile.replace(/\/+$/, "")}/${plain}.md`;
    const refs = await pc.get<{ value?: { name: string; objectId: string }[] }>(`git/repositories/${encodeURIComponent(w.repoId)}/refs`, { filter: `heads/${w.gitBranch}` });
    const head = refs.value?.find((x) => x.name === `refs/heads/${w.gitBranch}`)?.objectId ?? "";
    return { status: "push", path, content, code: { project: w.project, repo: w.repo, branch: w.gitBranch, filePath, baseCommit: head } };
  }
  try {
    await pc.request("GET", pagesApi(w), { query: { path } });
    throw new BrowseError("badInput", `page ${path} already exists in ${w.name}`);
  } catch (e) {
    if (e instanceof BrowseError) throw e;
    if (kindOf(e) !== "notFound") throw e;
  }
  const comment = (o.comment ?? "").trim();
  const r = await pc.request<RawPage>("PUT", pagesApi(w), { query: { path, ...(comment ? { comment } : {}) }, body: { content } });
  bumpGeneration(b, w.id);
  return { status: "created", path, etag: bare(r.headers.get("etag")), webUrl: webPageUrl(b, w, path) };
}

// ---- links to a page, and moving it -----------------------------------------------------------------------------------

/** Links are compared loosely: a dash and a space are the same (people write /Page-name and /Page%20name for "Page name"). */
const normLink = (p: string) => fileToName(p.replace(/^\/+/, "")).replace(/-/g, " ").toLowerCase();

export interface LinkRewrite {
  content: string;
  count: number;
  before: string[];
  after: string[];
}

const encodeSeg = (s: string, percent: boolean) => (percent ? nameToFile(s).replace(/-/g, "%20") : nameToFile(s));

/** Rewrites the wiki links to `from` (and its subpages) to `to`, in the style they were written in. Web links stay. */
export function rewriteLinks(md: string, from: string, to: string): LinkRewrite {
  const f = normLink(pagePath(from).slice(1));
  const before: string[] = [];
  const after: string[] = [];
  let count = 0;
  const lines = md.split("\n").map((line) => {
    let changed = false;
    const one = (target: string): string | null => {
      if (!target.startsWith("/") || target.startsWith("//")) return null;
      const cut = target.search(/[#?]/);
      const pathPart = cut >= 0 ? target.slice(0, cut) : target;
      const suffix = cut >= 0 ? target.slice(cut) : "";
      const md = /\.md$/i.test(pathPart);
      const norm = normLink(pathPart.replace(/\.md$/i, "").replace(/\/+$/, ""));
      if (norm !== f && !norm.startsWith(`${f}/`)) return null;
      // the segments the move does not change keep the text they were written with; only the new ones are encoded
      const raw = pathPart.replace(/\.md$/i, "").replace(/\/+$/, "").split("/").filter(Boolean);
      const fromSegs = pagePath(from).split("/").filter(Boolean);
      const toSegs = pagePath(to).split("/").filter(Boolean);
      let same = 0;
      while (same < fromSegs.length && same < toSegs.length && fromSegs[same].toLowerCase() === toSegs[same].toLowerCase()) same++;
      const percent = /%20/.test(pathPart) || / /.test(pathPart);
      const segs = [...raw.slice(0, same), ...toSegs.slice(same).map((s) => encodeSeg(s, percent)), ...raw.slice(fromSegs.length)];
      return `/${segs.join("/")}${md ? ".md" : ""}${suffix}`;
    };
    const next = line
      .replace(/(\]\(\s*<?)([^)\s>]+)/g, (m, pre: string, target: string) => {
        const r = one(target);
        if (r === null) return m;
        changed = true;
        count++;
        return `${pre}${r}`;
      })
      .replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/, (m, pre: string, target: string) => {
        const r = one(target);
        if (r === null) return m;
        changed = true;
        count++;
        return `${pre}${r}`;
      });
    if (changed) {
      before.push(line);
      after.push(next);
    }
    return next;
  });
  return { content: lines.join("\n"), count, before, after };
}

interface WikiFiles {
  pages: { path: string; content: string }[];
}

/** Every page of a project wiki in one download (a zip of the wiki's repository), kept a short while. */
async function allPages(b: Browse, w: WikiInfo): Promise<WikiFiles> {
  return (
    await cached(b, `wikizip|${b.org}|${w.id}|g${generationOf(b, w.id)}`, TTL.short, async () => {
      const url =
        `${b.client.remote.orgUrl}/${encodeURIComponent(w.project)}/_apis/git/repositories/${encodeURIComponent(w.repoId)}/items` +
        `?path=%2F&versionDescriptor.version=${encodeURIComponent(w.gitBranch)}&versionDescriptor.versionType=branch&$format=zip&download=true&api-version=7.1`;
      const zip = Buffer.from(await b.client.fetchBytes(url, 150 * 1024 * 1024));
      const pages: WikiFiles["pages"] = [];
      for (const e of readZip(zip)) {
        const name = `/${e.name.replace(/^\/+/, "")}`;
        if (!/\.md$/i.test(name) || /\/\.attachments\//i.test(name)) continue;
        const rel = relToWiki(w, name);
        if (rel === null) continue;
        pages.push({ path: gitPathToPage(rel), content: e.data.toString("utf8").replace(/^ï»¿/, "").replace(/\r\n/g, "\n") });
      }
      return { pages };
    })
  ).data;
}

export interface MovePlan {
  from: string;
  to: string;
  subpages: string[];
  links: { page: string; count: number; before: string[]; after: string[] }[];
  linkCount: number;
  pageCount: number;
  outsideNote: string;
}

function targetOf(from: string, to: string): string {
  const f = pagePath(from);
  const t = pagePath(to);
  if (f === "/") throw new BrowseError("badInput", "the wiki's root cannot be moved");
  if (t === "/" || t.toLowerCase() === f.toLowerCase()) throw new BrowseError("badInput", "--to must be a new page path, such as /How we work/Backfill");
  if (t.toLowerCase().startsWith(`${f.toLowerCase()}/`)) throw new BrowseError("badInput", "a page cannot move under itself");
  return t;
}

export async function wikiMovePlan(b: Browse, o: { project: string; wiki: string; path: string; to: string }): Promise<MovePlan> {
  const w = await wikiOf(b, o.project, o.wiki);
  needProjectWiki(w, "moving a page");
  const from = pagePath(o.path);
  const to = targetOf(from, o.to);
  const { pages } = await allPages(b, w);
  if (!pages.some((p) => p.path.toLowerCase() === from.toLowerCase())) throw new BrowseError("notFound", `page ${from} not found in ${w.name}`);
  const subpages = pages.filter((p) => p.path.toLowerCase().startsWith(`${from.toLowerCase()}/`)).map((p) => p.path).sort();
  const links = pages
    .map((p) => ({ page: p.path, ...rewriteLinks(p.content, from, to) }))
    .filter((x) => x.count > 0)
    .map(({ page, count, before, after }) => ({ page, count, before, after }));
  return {
    from,
    to,
    subpages,
    links,
    linkCount: links.reduce((n, l) => n + l.count, 0),
    pageCount: links.length,
    outsideNote: "Links outside the wiki (work items, pull requests, bookmarks, other wikis) keep the old path.",
  };
}

export interface MoveResult {
  status: "moved";
  from: string;
  to: string;
  linksUpdated: { page: string; count: number }[];
  linkErrors: { page: string; message: string }[];
  webUrl: string;
}

export async function wikiMove(b: Browse, o: { project: string; wiki: string; path: string; to: string; updateLinks?: boolean; comment?: string; order?: number }): Promise<MoveResult> {
  const w = await wikiOf(b, o.project, o.wiki);
  needProjectWiki(w, "moving a page");
  const from = pagePath(o.path);
  const to = targetOf(from, o.to);
  const plan = o.updateLinks === false ? null : await wikiMovePlan({ ...b, refresh: true }, o);
  const pc = projectClient(b, w);
  const comment = (o.comment ?? "").trim() || `Moved ${from} to ${to}`;
  // Azure DevOps needs newOrder when the parent changes ("Nullable object must have a value"): last under the new parent.
  // A rename within the same parent keeps its place without one.
  let order = o.order;
  if (order === undefined && parentOf(from).toLowerCase() !== parentOf(to).toLowerCase()) {
    const level = await pc.get<RawPage>(pagesApi(w), { path: parentOf(to), recursionLevel: "oneLevel" }).catch(() => ({ path: parentOf(to), subPages: [] }) as RawPage);
    order = (level.subPages ?? []).length;
  }
  await pc.request("POST", `wiki/wikis/${encodeURIComponent(w.id)}/pagemoves`, {
    query: { "api-version": "7.1", comment },
    body: { path: from, newPath: to, ...(order !== undefined ? { newOrder: order } : {}) },
  });
  bumpGeneration(b, w.id);
  const linksUpdated: MoveResult["linksUpdated"] = [];
  const linkErrors: MoveResult["linkErrors"] = [];
  for (const l of plan?.links ?? []) {
    // a page that moved along is at its new path now
    const lower = l.page.toLowerCase();
    const now = lower === from.toLowerCase() || lower.startsWith(`${from.toLowerCase()}/`) ? `${to}${l.page.slice(from.length)}` : l.page;
    try {
      const cur = await currentOf(b, w, now);
      const r = rewriteLinks(cur.content, from, to);
      if (!r.count) continue;
      await pc.request("PUT", pagesApi(w), { query: { path: now, comment: `Links updated after moving ${nameOf(from)} to ${to}` }, body: { content: r.content }, headers: cur.etag ? { "If-Match": quoted(cur.etag) } : {} });
      linksUpdated.push({ page: now, count: r.count });
    } catch (e) {
      linkErrors.push({ page: now, message: String((e as Error).message ?? e).replace(/^aihub:\s*/, "") });
    }
  }
  if (linksUpdated.length) bumpGeneration(b, w.id);
  return { status: "moved", from, to, linksUpdated, linkErrors, webUrl: webPageUrl(b, w, to) };
}

// ---- attachments -----------------------------------------------------------------------------------------------------

export async function wikiUpload(b: Browse, o: { project: string; wiki: string; file: string; name?: string }): Promise<{ name: string; ref: string; markdown: string; bytes: number }> {
  const w = await wikiOf(b, o.project, o.wiki);
  needProjectWiki(w, "an attachment");
  let bytes: Buffer;
  try {
    bytes = readFileSync(o.file);
  } catch (e) {
    throw new BrowseError("badInput", `cannot read ${o.file}: ${(e as Error).message}`);
  }
  if (bytes.length > 19 * 1024 * 1024) throw new BrowseError("badInput", "an attachment may be at most 19 MB");
  const name = (o.name?.trim() || basename(o.file)).replace(/\s+/g, "-");
  const r = await projectClient(b, w).request<{ name?: string; path?: string }>("PUT", `wiki/wikis/${encodeURIComponent(w.id)}/attachments`, {
    query: { name },
    rawBody: new TextEncoder().encode(bytes.toString("base64")),
    contentType: "application/octet-stream",
  });
  const ref = r.data.path ?? `/.attachments/${r.data.name ?? name}`;
  const alt = (r.data.name ?? name).replace(/\.[^.]+$/, "");
  return { name: r.data.name ?? name, ref, markdown: `![${alt}](${ref.replace(/ /g, "%20")})`, bytes: bytes.length };
}

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parse } from "yaml";
import { configHome } from "../configHome.js";
import { BrowseError, kindOf, type Browse } from "../browse/core.js";
import { hunks, type Hunk } from "../browse/lineDiff.js";
import { secretIn } from "../browse/change.js";
import { teamOf } from "../browse/push.js";
import { readFileAt } from "../browse/read.js";
import { TEAM_FILE, type TeamConfig } from "../team.js";
import { nameOf, pagePath, parentOf, wikiOf } from "./core.js";
import { wikiPage } from "./read.js";
import { wikiCreate, wikiPublish } from "./write.js";

/**
 * Update Wiki with Context from…: a workspace per update in the user's config folder (never in a repository). `pages/` holds
 * the chosen wiki pages as markdown files (`pages/Runbooks/Order export.md` is the page /Runbooks/Order export); `.base/` the
 * version each one was read at, with its ETag in update.json. The agent reads the chosen source files (remote through
 * `aihub browse`, or a clone on this PC, read only) and edits the files under pages/. Nothing reaches the wiki until `apply`,
 * page by page or all, with If-Match on the ETag the page was read at: a page someone changed meanwhile is a conflict, never
 * overwritten. Only the chosen wiki; new pages only when no page was chosen (a whole wiki or project).
 */

export interface WikiSource {
  project: string;
  repo: string;
  /** a folder or file in the repository; empty: the whole repository */
  path?: string;
  /** a branch, `tag:<name>` or `commit:<sha>`; default: the default branch */
  ref?: string;
  /** a clone on this PC (read only); without it the source is read remotely */
  local?: string;
}

export interface UpdatePage {
  path: string;
  /** the ETag the page was read at; null for a page that did not exist */
  etag: string | null;
  version: string | null;
  exists: boolean;
}

export interface UpdateMeta {
  id: string;
  org: string;
  project: string;
  wiki: string;
  wikiId: string;
  /** the chosen pages; empty: the whole wiki (the agent may also propose new pages) */
  chosen: string[];
  allowNew: boolean;
  pages: UpdatePage[];
  sources: WikiSource[];
  prompt?: string;
  language?: string;
  createdAt: string;
  status: "open" | "applied" | "discarded";
  applied: { path: string; status: string; at: string; etag?: string | null }[];
}

export const updatesRoot = (env: NodeJS.ProcessEnv) => join(configHome(env), "wiki-updates");
const dirOf = (env: NodeJS.ProcessEnv, id: string) => {
  if (!/^[\w.-]+$/.test(id)) throw new BrowseError("badInput", `'${id}' is not a wiki update id`);
  return join(updatesRoot(env), id);
};
const metaFile = (dir: string) => join(dir, "update.json");
const pagesDir = (dir: string) => join(dir, "pages");
const baseDir = (dir: string) => join(dir, ".base");

export function readUpdate(env: NodeJS.ProcessEnv, id: string): { dir: string; meta: UpdateMeta } {
  const dir = dirOf(env, id);
  try {
    return { dir, meta: JSON.parse(readFileSync(metaFile(dir), "utf8")) as UpdateMeta };
  } catch {
    throw new BrowseError("notFound", `there is no wiki update '${id}' on this PC (aihub wiki update list)`);
  }
}
const writeMeta = (dir: string, meta: UpdateMeta) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(metaFile(dir), JSON.stringify(meta, null, 2), "utf8");
};

// ---- page <-> file ---------------------------------------------------------------------------------------------------

/** `/Runbooks/Order export` -> `Runbooks/Order export.md`: readable names; only the characters a file cannot hold are %XX. */
export function pageFile(path: string): string {
  const segs = pagePath(path).split("/").filter(Boolean);
  if (!segs.length) throw new BrowseError("badInput", "a page path is needed, such as /Runbooks/Order export");
  return `${segs.map((s) => s.replace(/[%:*?"<>|\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)).join("/")}.md`;
}

export function fileToPage(file: string): string {
  const segs = file.replace(/\\/g, "/").replace(/\.md$/i, "").split("/").filter(Boolean);
  return `/${segs
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join("/")}`;
}

function walk(root: string, at = root, out: string[] = []): string[] {
  if (!existsSync(at)) return out;
  for (const e of readdirSync(at, { withFileTypes: true })) {
    const p = join(at, e.name);
    if (e.isDirectory()) walk(root, p, out);
    else if (e.isFile() && /\.md$/i.test(e.name)) out.push(relative(root, p).split(sep).join("/"));
  }
  return out;
}

const readText = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n") : null);

// ---- team: language and the page template ---------------------------------------------------------------------------

function findUp(start: string, rel: string): string | undefined {
  let d = start;
  for (let i = 0; i < 30; i++) {
    const f = join(d, rel);
    if (existsSync(f)) return f;
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
  return undefined;
}

/** team.yaml of the clone the CLI runs in, else of the first source repository (remote). */
async function teamFor(b: Browse, sources: WikiSource[]): Promise<{ team: TeamConfig; template: string | null }> {
  const local = findUp(b.ctx.cwd, TEAM_FILE);
  let team: TeamConfig = {};
  let root: string | undefined;
  if (local) {
    try {
      team = (parse(readFileSync(local, "utf8")) as TeamConfig) ?? {};
      root = dirname(dirname(dirname(dirname(dirname(local)))));
    } catch {
      team = {};
    }
  } else if (sources[0]) {
    // the team file of the first source repository; a repository that cannot be read only means: no team settings
    try {
      const s = sources[0];
      team = await teamOf(b, s.project, s.repo, s.ref && !/^(tag|commit):/i.test(s.ref) ? s.ref : await defaultBranch(b, s));
    } catch {
      team = {};
    }
  }
  const wiki = team.wiki ?? {};
  let template: string | null = null;
  if (wiki.pageTemplate) {
    const p = wiki.pageTemplate.replace(/^\/+/, "");
    if (root) template = readText(join(root, p));
    else if (sources[0]) {
      const ref = await defaultBranch(b, sources[0]).catch(() => "");
      template = ref ? await readFileAt(b, sources[0].project, sources[0].repo, `/${p}`, { name: ref, kind: "branch" }).then((f) => f.content).catch(() => null) : null;
    }
  }
  return { team, template };
}

async function defaultBranch(b: Browse, s: WikiSource): Promise<string> {
  const rc = b.client.forProject(s.project).forRepo(s.repo);
  const r = await rc.get<{ defaultBranch?: string }>(rc.repoPath());
  return (r.defaultBranch ?? "main").replace(/^refs\/heads\//, "");
}

// ---- TASK.md ---------------------------------------------------------------------------------------------------------

const LANG: Record<string, string> = { nl: "Dutch", en: "English", de: "German", fr: "French" };

export function updateTaskText(meta: UpdateMeta, o: { template: string | null }): string {
  const id = meta.id;
  const w = `--project "${meta.project}" --wiki "${meta.wiki}"`;
  const sourceLines = meta.sources.map((s) => {
    const what = `${s.project}/${s.repo}${s.path && s.path !== "/" ? s.path : ""}${s.ref ? ` at ${s.ref}` : ""}`;
    if (s.local) return `- ${what}: a clone on this PC at \`${join(s.local, (s.path ?? "").replace(/^\/+/, ""))}\` (read it with your normal tools; never change, commit or push it).`;
    const args = `--project "${s.project}" --repo "${s.repo}"${s.ref ? ` --ref "${s.ref}"` : ""}`;
    if (s.path && /\.[a-z0-9]{1,8}$/i.test(s.path)) return `- ${what}: remote, no clone. Read it: \`aihub browse file ${args} --path "${s.path}"\`.`;
    return `- ${what}: remote, no clone. A folder: \`aihub browse items ${args} --path "${s.path || "/"}"\`; a file: \`aihub browse file ${args} --path "<file>"\`; search: \`aihub browse search --text "<text>" --project "${s.project}" --repo "${s.repo}"\`.`;
  });
  const lang = meta.language ? LANG[meta.language] ?? meta.language : null;
  return [
    `# Wiki update ${id}`,
    "",
    "## What to do",
    "",
    meta.prompt?.trim() || "Bring the wiki pages below up to date with what the source files say: correct what is out of date, add what is missing, keep what is still true. Do not invent anything the sources do not show.",
    "",
    "## The pages",
    "",
    `Wiki ${meta.wiki} (project ${meta.project}). Each page is a markdown file under ./pages: \`pages/Runbooks/Order export.md\` is the page /Runbooks/Order export.`,
    ...(meta.chosen.length
      ? [`Update only these pages: ${meta.chosen.join(", ")}. Other pages may be read for context but stay as they are.`]
      : [
          "No page was chosen: the whole wiki is in scope. Read the tree first (`aihub wiki browse tree " + w + " --path /<folder>`, one level per call) and fetch a page before you change it.",
          "You may propose a NEW page by creating a new file under ./pages (its folder is its parent page); it is shown to the user as new.",
        ]),
    `- Fetch another page of this wiki into ./pages: \`aihub wiki update read --id ${id} --path "/Parent/Page"\`.`,
    "- Edit the files under ./pages with your normal edit tools. Keep the page's own structure and headings unless the sources ask for more.",
    ...(lang ? [`- Write in ${lang} (the team language).`] : ["- Write in the language the page is already written in."]),
    ...(o.template ? ["- A new page follows the team's wiki template:", "", "```markdown", o.template.trim(), "```"] : []),
    "",
    "## The sources",
    "",
    ...(sourceLines.length ? sourceLines : ["(no sources chosen: ask the user which repositories, folders or files to use)"]),
    "",
    "## Check and finish",
    "",
    `- See your proposal: \`aihub wiki update diff --id ${id}\`.`,
    `- Undo one page: \`aihub wiki update discard --id ${id} --path "/Parent/Page"\`.`,
    "- End with a short summary in the chat: per page what changed and from which source file.",
    "",
    "## Fixed limits",
    "",
    "- Do not publish: never run `aihub wiki update apply`, `aihub wiki browse publish`, `create` or `move`. The user reviews the diff and publishes each page.",
    `- Only wiki ${meta.wiki}; never write to a repository, never commit, push or run git.`,
    "- No secrets (keys, passwords, tokens) in a page.",
    "",
  ].join("\n");
}

// ---- start / read ----------------------------------------------------------------------------------------------------

function newId(wiki: string, now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${wiki.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}-${stamp}-${Math.random().toString(16).slice(2, 6)}`;
}

export interface UpdateStart {
  id: string;
  dir: string;
  pagesDir: string;
  project: string;
  wiki: string;
  chosen: string[];
  allowNew: boolean;
  pages: { path: string; file: string; exists: boolean }[];
  sources: WikiSource[];
  language: string | null;
  template: boolean;
  taskFile: string;
  agentPrompt: string;
}

export function parseSources(raw: unknown): WikiSource[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BrowseError("badInput", "the sources file holds a JSON list: [{ project, repo, path?, ref?, local? }]");
  return raw.map((s, i) => {
    const x = s as Partial<WikiSource>;
    if (typeof x?.project !== "string" || !x.project.trim() || typeof x.repo !== "string" || !x.repo.trim()) throw new BrowseError("badInput", `source ${i + 1} needs a project and a repo`);
    return { project: x.project, repo: x.repo, ...(x.path ? { path: x.path.startsWith("/") ? x.path : `/${x.path}` } : {}), ...(x.ref ? { ref: x.ref } : {}), ...(x.local ? { local: x.local } : {}) };
  });
}

export async function updateStart(b: Browse, o: { project: string; wiki: string; pages?: string[]; sources?: WikiSource[]; prompt?: string }): Promise<UpdateStart> {
  const w = await wikiOf(b, o.project, o.wiki);
  if (w.kind === "code") throw new BrowseError("badInput", `${w.name} is a code wiki: update its pages with Change with Agent on repository ${w.repo} (aihub browse change start)`);
  const chosen = (o.pages ?? []).map((p) => pagePath(p)).filter((p, i, a) => p !== "/" && a.indexOf(p) === i);
  const sources = o.sources ?? [];
  const { team, template } = await teamFor(b, sources);
  const id = newId(w.name, b.now());
  const dir = dirOf(b.env, id);
  mkdirSync(pagesDir(dir), { recursive: true });
  mkdirSync(baseDir(dir), { recursive: true });
  const language = typeof team.language === "string" && team.language.trim() ? team.language.trim() : undefined;
  const meta: UpdateMeta = { id, org: b.org, project: w.project, wiki: w.name, wikiId: w.id, chosen, allowNew: chosen.length === 0, pages: [], sources, ...(o.prompt ? { prompt: o.prompt } : {}), ...(language ? { language } : {}), createdAt: new Date(b.now()).toISOString(), status: "open", applied: [] };
  for (const p of chosen) await fetchPage(b, dir, meta, p);
  writeMeta(dir, meta);
  const taskFile = join(dir, "TASK.md");
  writeFileSync(taskFile, updateTaskText(meta, { template }), "utf8");
  return {
    id,
    dir,
    pagesDir: pagesDir(dir),
    project: w.project,
    wiki: w.name,
    chosen,
    allowNew: meta.allowNew,
    pages: meta.pages.map((p) => ({ path: p.path, file: join(pagesDir(dir), pageFile(p.path)), exists: p.exists })),
    sources,
    language: language ?? null,
    template: template !== null,
    taskFile,
    // relative to the workspace (the agent starts there): no path, no quote, so it survives every shell
    agentPrompt: "Read TASK.md and update the wiki pages under ./pages as it describes. Do not publish.",
  };
}

/** Reads a page of the wiki into pages/ and .base/ (once); a page that does not exist is noted as such. */
async function fetchPage(b: Browse, dir: string, meta: UpdateMeta, path: string): Promise<UpdatePage> {
  const known = meta.pages.find((x) => x.path.toLowerCase() === path.toLowerCase());
  if (known) return known;
  const file = pageFile(path);
  let page: UpdatePage;
  try {
    const r = await wikiPage({ ...b, refresh: true }, { project: meta.project, wiki: meta.wikiId, path });
    mkdirSync(dirname(join(baseDir(dir), file)), { recursive: true });
    mkdirSync(dirname(join(pagesDir(dir), file)), { recursive: true });
    writeFileSync(join(baseDir(dir), file), r.page.content, "utf8");
    if (!existsSync(join(pagesDir(dir), file))) writeFileSync(join(pagesDir(dir), file), r.page.content, "utf8");
    page = { path: r.page.path, etag: r.page.etag, version: r.page.version, exists: true };
  } catch (e) {
    if (kindOf(e) !== "notFound") throw e;
    page = { path, etag: null, version: null, exists: false };
  }
  meta.pages.push(page);
  return page;
}

export async function updateRead(b: Browse, id: string, path: string) {
  const { dir, meta } = readUpdate(b.env, id);
  const p = pagePath(path);
  const page = await fetchPage(b, dir, meta, p);
  writeMeta(dir, meta);
  if (!page.exists) throw new BrowseError("notFound", `page ${p} is not in ${meta.wiki}${meta.allowNew ? ` (create ./pages/${pageFile(p)} to propose it as a new page)` : ""}`);
  return { id, path: page.path, file: join(pagesDir(dir), pageFile(page.path)), content: readText(join(pagesDir(dir), pageFile(page.path))) };
}

/** A page's proposal set from a file (for an agent without file tools); the same checks as diff apply. */
export function updateWrite(env: NodeJS.ProcessEnv, id: string, path: string, content: string) {
  const { dir, meta } = readUpdate(env, id);
  if (meta.status !== "open") throw new BrowseError("badInput", `wiki update ${id} is ${meta.status}; start a new one`);
  const f = pageFile(path);
  mkdirSync(dirname(join(pagesDir(dir), f)), { recursive: true });
  writeFileSync(join(pagesDir(dir), f), content.replace(/\r\n/g, "\n"), "utf8");
  const d = updateDiff(env, id);
  return { id, path: pagePath(path), file: join(pagesDir(dir), f), pages: d.totals.pages, problems: d.problems };
}

// ---- diff ------------------------------------------------------------------------------------------------------------

export interface PageChange {
  path: string;
  status: "modified" | "added";
  additions: number;
  deletions: number;
  hunks: Hunk[];
  /** applied already in this update */
  applied: boolean;
}

export interface UpdateProblem {
  path: string;
  kind: "notChosen" | "newNotAllowed" | "secret" | "empty";
  message: string;
}

export function updateDiff(env: NodeJS.ProcessEnv, id: string) {
  const { dir, meta } = readUpdate(env, id);
  const pages: PageChange[] = [];
  const contents: Record<string, string> = {};
  const problems: UpdateProblem[] = [];
  for (const f of walk(pagesDir(dir))) {
    const path = fileToPage(f);
    const content = readText(join(pagesDir(dir), f)) ?? "";
    const known = meta.pages.find((x) => x.path.toLowerCase() === path.toLowerCase());
    const base = known?.exists ? readText(join(baseDir(dir), f)) : null;
    if (base !== null && base === content) continue;
    const h = hunks(base ?? "", content);
    const count = (k: "add" | "del") => h.reduce((n, x) => n + x.lines.filter((l) => l.kind === k).length, 0);
    const status: PageChange["status"] = base === null ? "added" : "modified";
    const p = known?.path ?? path;
    pages.push({ path: p, status, additions: count("add"), deletions: count("del"), hunks: h, applied: meta.applied.some((a) => a.path.toLowerCase() === p.toLowerCase() && a.status !== "conflict" && a.status !== "failed") });
    contents[p] = content;
    if (status === "added" && !meta.allowNew) problems.push({ path: p, kind: "newNotAllowed", message: `${p} is a new page; new pages are only proposed when no page was chosen` });
    if (status === "modified" && meta.chosen.length && !meta.chosen.some((c) => c.toLowerCase() === p.toLowerCase())) problems.push({ path: p, kind: "notChosen", message: `${p} was not chosen; only ${meta.chosen.join(", ")} may change` });
    if (!content.trim()) problems.push({ path: p, kind: "empty", message: `${p} would be empty` });
    const s = secretIn(content);
    if (s) problems.push({ path: p, kind: "secret", message: `${p} contains ${s}` });
  }
  pages.sort((a, c) => a.path.localeCompare(c.path));
  return {
    id,
    status: meta.status,
    project: meta.project,
    wiki: meta.wiki,
    chosen: meta.chosen,
    allowNew: meta.allowNew,
    dir,
    pagesDir: pagesDir(dir),
    pages,
    totals: { pages: pages.length, added: pages.filter((x) => x.status === "added").length, additions: pages.reduce((n, x) => n + x.additions, 0), deletions: pages.reduce((n, x) => n + x.deletions, 0) },
    problems,
    applied: meta.applied,
    contents,
  };
}

// ---- apply / discard / list ------------------------------------------------------------------------------------------

export interface ApplyRow {
  path: string;
  status: "published" | "created" | "conflict" | "refused" | "failed" | "unchanged";
  message?: string;
  etag?: string | null;
  webUrl?: string;
  /** a conflict: who changed the page meanwhile */
  current?: { etag: string | null; lastChange: unknown };
}

/** Publishes the chosen proposals (all when no --path) with If-Match on the ETag each page was read at. A conflict is never overwritten. */
export async function updateApply(b: Browse, id: string, o: { paths?: string[]; comment?: string }) {
  const { dir, meta } = readUpdate(b.env, id);
  if (meta.status === "discarded") throw new BrowseError("badInput", `wiki update ${id} is discarded; start a new one`);
  const d = updateDiff(b.env, id);
  const want = (o.paths ?? []).map((p) => pagePath(p).toLowerCase());
  const todo = d.pages.filter((p) => !p.applied && (!want.length || want.includes(p.path.toLowerCase())));
  if (want.length) for (const p of want) if (!d.pages.some((x) => x.path.toLowerCase() === p)) throw new BrowseError("badInput", `${p} has no proposed change in this update`);
  const comment = (o.comment ?? "").trim() || "Updated with context from the source files (aihub wiki update)";
  const results: ApplyRow[] = [];
  for (const page of todo) {
    const problem = d.problems.find((x) => x.path === page.path);
    if (problem) {
      results.push({ path: page.path, status: "refused", message: problem.message });
      continue;
    }
    const content = d.contents[page.path];
    const known = meta.pages.find((x) => x.path === page.path);
    try {
      if (page.status === "added") {
        const r = await wikiCreate(b, { project: meta.project, wiki: meta.wikiId, parent: parentOf(page.path), name: nameOf(page.path), content, comment });
        if (r.status !== "created") throw new BrowseError("badInput", "a code wiki page is created through the repository");
        results.push({ path: page.path, status: "created", etag: r.etag, webUrl: r.webUrl });
        meta.pages.push({ path: page.path, etag: r.etag, version: null, exists: true });
      } else {
        const r = await wikiPublish(b, { project: meta.project, wiki: meta.wikiId, path: page.path, content, etag: known?.etag ?? undefined, comment });
        if (r.status === "conflict") {
          results.push({ path: page.path, status: "conflict", message: `${page.path} changed in the wiki after it was read${r.current.lastChange ? ` (${(r.current.lastChange as { by?: { name?: string } }).by?.name ?? "someone"})` : ""}; nothing was published`, current: { etag: r.current.etag, lastChange: r.current.lastChange } });
          continue;
        }
        results.push({ path: page.path, status: "published", etag: r.etag, webUrl: r.webUrl });
        if (known) {
          known.etag = r.etag;
          known.version = r.version;
        }
      }
      // the published text is the new base: the page no longer shows as a proposal
      const f = pageFile(page.path);
      mkdirSync(dirname(join(baseDir(dir), f)), { recursive: true });
      writeFileSync(join(baseDir(dir), f), content, "utf8");
    } catch (e) {
      results.push({ path: page.path, status: "failed", message: String((e as Error).message ?? e).replace(/^aihub:\s*/, "") });
    }
  }
  const at = new Date(b.now()).toISOString();
  for (const r of results) meta.applied.push({ path: r.path, status: r.status, at, ...(r.etag !== undefined ? { etag: r.etag } : {}) });
  writeMeta(dir, meta);
  const left = updateDiff(b.env, id).pages.map((p) => p.path);
  if (!left.length) {
    meta.status = "applied";
    writeMeta(dir, meta);
  }
  return { id, results, left };
}

/** Discard one proposal (the page goes back to what was read; a new page goes) or, without a path, the whole update. */
export function updateDiscard(env: NodeJS.ProcessEnv, id: string, path?: string) {
  const { dir, meta } = readUpdate(env, id);
  if (!path) {
    rmSync(dir, { recursive: true, force: true });
    return { id, discarded: true, path: null };
  }
  const p = pagePath(path);
  const known = meta.pages.find((x) => x.path.toLowerCase() === p.toLowerCase());
  const f = pageFile(known?.path ?? p);
  const base = known?.exists ? readText(join(baseDir(dir), f)) : null;
  if (base !== null) writeFileSync(join(pagesDir(dir), f), base, "utf8");
  else rmSync(join(pagesDir(dir), f), { force: true });
  return { id, discarded: true, path: known?.path ?? p };
}

export function updateList(env: NodeJS.ProcessEnv) {
  const root = updatesRoot(env);
  if (!existsSync(root)) return { updates: [] };
  const updates = readdirSync(root)
    .map((id) => {
      try {
        const m = JSON.parse(readFileSync(metaFile(join(root, id)), "utf8")) as UpdateMeta;
        return { id: m.id, project: m.project, wiki: m.wiki, chosen: m.chosen, status: m.status, createdAt: m.createdAt, dir: join(root, id), updatedAt: statSync(join(root, id)).mtime.toISOString() };
      } catch {
        return undefined;
      }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, c) => c.createdAt.localeCompare(a.createdAt));
  return { updates };
}

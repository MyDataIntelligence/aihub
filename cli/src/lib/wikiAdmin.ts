import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { trace } from "./trace.js";
import type { AdoClient } from "./ado.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { confirmDelete, cut, day, emit, encode, table, top, type Flags } from "./devops.js";
import { pickWiki } from "./wiki.js";
import { readUtf8 } from "./team.js";

interface WikiRef {
  id: string;
  name: string;
  type?: string;
  repositoryId?: string;
  mappedPath?: string;
  versions?: { version?: string }[];
}

const normPath = (p: string) => "/" + p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "").replace(/\/+$/, "");

async function chosen(c: AdoClient, v: Flags): Promise<WikiRef> {
  return (await pickWiki(c, typeof v.wiki === "string" ? v.wiki : undefined)) as WikiRef;
}

const pagesBase = (w: WikiRef) => `wiki/wikis/${encode(w.id)}/pages`;

export async function wikiList(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const all = await c.list<WikiRef>("wiki/wikis");
  emit(ctx, v, all.map((w) => ({ id: w.id, name: w.name, type: w.type })), all.length ? table([["wiki", "type", "id"], ...all.map((w) => [w.name, w.type ?? "", w.id])]) : "this project has no wiki");
}

interface PageNode {
  path: string;
  order?: number;
  isParentPage?: boolean;
  subPages?: PageNode[];
}

export async function wikiPages(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const w = await chosen(c, v);
  const root = typeof v.path === "string" ? normPath(v.path) : "/";
  const r = await c.get<PageNode>(pagesBase(w), { path: root, recursionLevel: "full" });
  const flat: string[] = [];
  const walk = (n: PageNode, depth: number) => {
    if (n.path !== "/") flat.push(`${"  ".repeat(depth)}${n.path.split("/").pop()}${n.subPages?.length ? "/" : ""}`);
    (n.subPages ?? []).forEach((s) => walk(s, n.path === "/" ? depth : depth + 1));
  };
  walk(r, 0);
  const paths: string[] = [];
  const collect = (n: PageNode) => {
    if (n.path !== "/") paths.push(n.path);
    (n.subPages ?? []).forEach(collect);
  };
  collect(r);
  emit(ctx, v, { wiki: w.name, pages: paths }, flat.length ? flat.slice(0, top(v, 500)).join("\n") : `${w.name} has no pages under ${root}`);
}

export async function wikiRead(c: AdoClient, ctx: Ctx, v: Flags, page: string): Promise<void> {
  const w = await chosen(c, v);
  const path = normPath(page);
  const r = await c.request<{ content?: string; id?: number; path?: string }>("GET", pagesBase(w), { query: { path, includeContent: true } });
  const content = (r.data.content ?? "").replace(/\r\n/g, "\n");
  emit(ctx, v, { wiki: w.name, path, id: r.data.id, content }, content);
}

async function body(v: Flags): Promise<string> {
  if (typeof v["body-file"] !== "string") throw new AihubError("--body-file <markdown file> is required");
  const text = readUtf8(v["body-file"]);
  if (!text.trim()) throw new AihubError("the body file is empty");
  return text;
}

export async function wikiCreate(c: AdoClient, ctx: Ctx, v: Flags, page: string): Promise<void> {
  const w = await chosen(c, v);
  const path = normPath(page);
  const content = await body(v);
  try {
    await c.request("GET", pagesBase(w), { query: { path } });
    throw new AihubError(`page ${path} already exists in ${w.name}; change it with: aihub wiki update --page ${path.slice(1)} --body-file <file> --publish`);
  } catch (e) {
    if (!(e instanceof AihubError) || !/\(404\)/.test(e.message)) throw e;
  }
  await c.request("PUT", pagesBase(w), { query: { path }, body: { content } });
  emit(ctx, v, { wiki: w.name, path, created: !trace.dryRun }, `${trace.dryRun ? "dry-run: would create" : "created"} ${w.name}${path} (${content.length} chars)`);
}

export async function wikiMove(c: AdoClient, ctx: Ctx, v: Flags, page: string, to: string): Promise<void> {
  const w = await chosen(c, v);
  await c.request("POST", `wiki/wikis/${encode(w.id)}/pagemoves`, { query: { "api-version": "7.1-preview.1" }, body: { path: normPath(page), newPath: normPath(to), newOrder: typeof v.order === "string" ? Number(v.order) : 0 } });
  emit(ctx, v, { wiki: w.name, from: normPath(page), to: normPath(to) }, `${trace.dryRun ? "dry-run: would move" : "moved"} ${normPath(page)} to ${normPath(to)}`);
}

export async function wikiDelete(c: AdoClient, ctx: Ctx, v: Flags, page: string): Promise<void> {
  confirmDelete(v, `wiki page '${page}'`);
  const w = await chosen(c, v);
  await c.request("DELETE", pagesBase(w), { query: { path: normPath(page) } });
  emit(ctx, v, { wiki: w.name, path: normPath(page), deleted: !trace.dryRun }, `${trace.dryRun ? "dry-run: would delete" : "deleted"} ${w.name}${normPath(page)}`);
}

/** Upload a file the page can reference as `![alt](/.attachments/<name>)`. */
export async function wikiAttach(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const w = await chosen(c, v);
  if (typeof v.file !== "string") throw new AihubError("--file <image or document> is required");
  let bytes: Buffer;
  try {
    bytes = readFileSync(v.file);
  } catch (e) {
    throw new AihubError(`cannot read ${v.file}: ${(e as Error).message}`);
  }
  if (bytes.length > 19 * 1024 * 1024) throw new AihubError("an attachment may be at most 19 MB");
  const name = typeof v.name === "string" ? v.name : basename(v.file);
  const r = await c.request<{ name?: string; path?: string }>("PUT", `wiki/wikis/${encode(w.id)}/attachments`, { query: { name }, rawBody: new TextEncoder().encode(bytes.toString("base64")), contentType: "application/octet-stream" });
  const ref = `/.attachments/${r.data.name ?? name}`;
  emit(ctx, v, { wiki: w.name, name, path: r.data.path ?? ref }, `${trace.dryRun ? "dry-run: would attach" : "attached"} ${name} (${bytes.length} bytes); in a page: ![${name}](${ref})`);
}

/** Commits that touched a page: a wiki is a git repository, the page is a file. */
export async function wikiHistory(c: AdoClient, ctx: Ctx, v: Flags, page: string): Promise<void> {
  const w = await chosen(c, v);
  if (!w.repositoryId) throw new AihubError(`wiki '${w.name}' has no repository to read history from`);
  const file = `${w.mappedPath && w.mappedPath !== "/" ? w.mappedPath.replace(/\/$/, "") : ""}${normPath(page).replace(/ /g, "-")}.md`;
  const r = await c
    .get<{ value?: any[] }>(`git/repositories/${w.repositoryId}/commits`, { "searchCriteria.itemPath": file, "searchCriteria.$top": top(v, 20), ...(w.versions?.[0]?.version ? { "searchCriteria.itemVersion.version": w.versions[0].version } : {}) })
    .catch((e) => {
      if (e instanceof AihubError && /\(404\)/.test(e.message)) return { value: [] };
      throw e;
    });
  const rows = (r.value ?? []).map((x) => ({ commit: String(x.commitId).slice(0, 8), date: day(x.author?.date), author: x.author?.name, comment: x.comment }));
  emit(ctx, v, rows, rows.length ? rows.map((x) => `${x.commit} ${x.date} ${cut(x.author, 20)} ${cut(x.comment, 60)}`).join("\n") : `no history for ${file}`);
}

export async function wikiCreateWiki(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const name = typeof v.name === "string" ? v.name : "";
  if (!name) throw new AihubError("--name <wiki name> is required");
  const project = await c.request<{ id: string }>("GET", `projects/${encode(c.remote.project)}`, { orgLevel: true, query: { "api-version": "7.1" } }).then((r) => r.data);
  let payload: any;
  if (v.code) {
    const repo = await c.get<{ id: string }>(typeof v.repo === "string" ? `git/repositories/${encode(v.repo)}` : c.repoPath());
    payload = { name, type: "codeWiki", projectId: project.id, repositoryId: repo.id, mappedPath: typeof v.folder === "string" ? normPath(v.folder) : "/", version: { version: typeof v.branch === "string" ? v.branch : "main" } };
  } else payload = { name, type: "projectWiki", projectId: project.id };
  const made = await c.post<{ id?: string }>("wiki/wikis", payload);
  emit(ctx, v, { name, type: payload.type, id: made.id }, `${trace.dryRun ? "dry-run: would create" : "created"} ${v.code ? "code wiki" : "project wiki"} '${name}'`);
}

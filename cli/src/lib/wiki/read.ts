import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, posix } from "node:path";
import { configHome } from "../configHome.js";
import { BrowseError, cached, cacheRead, cacheWrite, guarded, kindOf, meOf, personOf, shortSha, TTL, type Browse, type Person, type ReadMeta } from "../browse/core.js";
import { hunks, type Hunk } from "../browse/lineDiff.js";
import { readFileAt } from "../browse/read.js";
import { fileInRepo, generationOf, nameOf, pagePath, pageToGitPath, webPageUrl, wikiOf, type WikiInfo, type WikiKind } from "./core.js";

export const pagesApi = (w: WikiInfo) => `wiki/wikis/${encodeURIComponent(w.id)}/pages`;
export const projectClient = (b: Browse, w: Pick<WikiInfo, "project">) => b.client.forProject(w.project);
const scope = (w: WikiInfo) => `wiki|${w.project}|${w.id}`;
const wkey = (b: Browse, w: WikiInfo, what: string) => `wiki|${b.org}|${w.id}|g${generationOf(b, w.id)}|${what}`;

export const wikiRef = (w: WikiInfo) => ({ id: w.id, name: w.name, kind: w.kind as WikiKind, project: w.project });

// ---- the page tree (one level per call) ------------------------------------------------------------------------------

export interface TreePage {
  path: string;
  name: string;
  order: number;
  hasChildren: boolean;
  id: number | null;
  gitItemPath: string | null;
}

export interface TreeResult extends ReadMeta {
  wiki: ReturnType<typeof wikiRef>;
  path: string;
  pages: TreePage[];
}

export interface RawPage {
  id?: number;
  path: string;
  order?: number;
  isParentPage?: boolean;
  gitItemPath?: string;
  subPages?: RawPage[];
  content?: string;
}

/** The children of a page in the order of Azure DevOps (the `order` of the .order file, then the name). */
export function mapTree(raw: RawPage): TreePage[] {
  return (raw.subPages ?? [])
    .filter((p) => !nameOf(p.path).startsWith(".")) // a code wiki lists its repository's .folders too; Azure DevOps hides them
    .map((p) => ({ path: p.path, name: nameOf(p.path), order: p.order ?? Number.MAX_SAFE_INTEGER, hasChildren: !!p.isParentPage || !!p.subPages?.length, id: p.id ?? null, gitItemPath: p.gitItemPath ?? null }))
    .sort((a, c) => a.order - c.order || a.name.localeCompare(c.name, undefined, { sensitivity: "base" }));
}

export async function wikiTree(b: Browse, o: { project: string; wiki: string; path?: string }): Promise<TreeResult> {
  const w = await wikiOf(b, o.project, o.wiki);
  const path = pagePath(o.path);
  const { data, meta } = await guarded(b, scope(w), () =>
    cached(b, wkey(b, w, `tree|${path.toLowerCase()}`), TTL.lists, () => projectClient(b, w).get<RawPage>(pagesApi(w), { path, recursionLevel: "oneLevel", ...versionOf(w) })),
  );
  return { ...meta, wiki: wikiRef(w), path, pages: mapTree(data) };
}

/** A code wiki is read at its published branch. */
export const versionOf = (w: WikiInfo) => (w.kind === "code" ? { "versionDescriptor.version": w.gitBranch, "versionDescriptor.versionType": "branch" } : {});

// ---- one page --------------------------------------------------------------------------------------------------------

export interface LastChange {
  by: Person;
  at: string | null;
  commit: string;
  short: string;
  message: string;
}

export interface PageResult extends ReadMeta {
  wiki: ReturnType<typeof wikiRef>;
  page: { path: string; name: string; id: number | null; gitItemPath: string; content: string; etag: string | null; version: string | null };
  lastChange: LastChange | null;
  attachments: { name: string; ref: string }[];
  /** a code wiki: the repository file, for `aihub browse push` */
  code: { project: string; repo: string; branch: string; filePath: string; baseCommit: string } | null;
  webUrl: string;
}

/** Images and files the markdown refers to: `![x](/.attachments/a.png)`, `[doc](./img/b.pdf)`. Web links are not attachments. */
export function attachmentsOf(md: string): { name: string; ref: string }[] {
  const out = new Map<string, { name: string; ref: string }>();
  const re = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const m of md.matchAll(re)) {
    const ref = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("#")) continue;
    const isImage = m[0].startsWith("!");
    if (!isImage && !/\/\.attachments\//i.test(ref)) continue;
    const clean = ref.split(/[?#]/)[0].replace(/^<|>$/g, "");
    let name = clean.split("/").pop() ?? clean;
    try {
      name = decodeURIComponent(name);
    } catch {
      /* keep */
    }
    if (!out.has(clean)) out.set(clean, { name, ref: clean });
  }
  return [...out.values()];
}

interface RawCommit {
  commitId: string;
  comment?: string;
  author?: { name?: string; email?: string; date?: string };
}

export const changeOf = (c: RawCommit, me: Awaited<ReturnType<typeof meOf>>): LastChange => ({
  by: personOf(c.author, me),
  at: c.author?.date ?? null,
  commit: c.commitId,
  short: shortSha(c.commitId),
  message: (c.comment ?? "").split(/\r?\n/)[0].trim(),
});

export async function commitsOf(b: Browse, w: WikiInfo, file: string, version: string, top: number): Promise<RawCommit[]> {
  const pc = projectClient(b, w);
  const r = await pc.get<{ value?: RawCommit[] }>(`git/repositories/${encodeURIComponent(w.repoId)}/commits`, {
    "searchCriteria.itemPath": file,
    "searchCriteria.itemVersion.version": version,
    "searchCriteria.itemVersion.versionType": /^[0-9a-f]{40}$/i.test(version) ? "commit" : "branch",
    "searchCriteria.$top": top,
  });
  return r.value ?? [];
}

/** The file of a page in its repository (from the path, when the tree did not give it). */
export const fileOfPage = (w: WikiInfo, path: string, gitItemPath?: string | null) => fileInRepo(w, gitItemPath || pageToGitPath(path));

export async function wikiPage(b: Browse, o: { project: string; wiki: string; path: string; version?: string }): Promise<PageResult> {
  const w = await wikiOf(b, o.project, o.wiki);
  const path = pagePath(o.path);
  if (path === "/") throw new BrowseError("badInput", "which page? pass --path /Parent/Page");
  if (o.version && !/^[0-9a-f]{40}$/i.test(o.version)) throw new BrowseError("badInput", "--version must be a full commit id (a version from aihub wiki browse history)");
  const me = await meOf(b);
  const pc = projectClient(b, w);
  const { data, meta } = await guarded(b, scope(w), () =>
    cached(b, wkey(b, w, `page|${path.toLowerCase()}|${o.version ?? ""}`), o.version ? TTL.forever : TTL.project, async () => {
      if (o.version || w.kind === "code") {
        // a version, or a code wiki: the file at a commit or at the published branch (one call gives the text and its last change)
        const file = fileOfPage(w, path);
        const spec = o.version ? { name: o.version, kind: "commit" as const } : { name: w.gitBranch, kind: "branch" as const };
        const f = await readFileAt(b, w.project, w.repoId, file, spec, 4 * 1024 * 1024).catch((e) => {
          if (kindOf(e) === "notFound") throw new BrowseError("notFound", `page ${path} not found in ${w.name}${o.version ? ` at ${shortSha(o.version)}` : ""}`);
          throw e;
        });
        if (f.content === null) throw new BrowseError("badInput", `${file} is not a text page`);
        const last = f.lastCommit ? { by: f.lastCommit.by, at: f.lastCommit.at, commit: f.lastCommit.id, short: f.lastCommit.short, message: f.lastCommit.message } : null;
        return { id: null as number | null, gitItemPath: file, content: f.content, etag: w.kind === "project" ? null : f.objectId, commit: f.ref.commit, last };
      }
      const r = await pc.request<RawPage>("GET", pagesApi(w), { query: { path, includeContent: true } }).catch((e) => {
        if (kindOf(e) === "notFound") throw new BrowseError("notFound", `page ${path} not found in ${w.name}`);
        throw e;
      });
      const gitItemPath = r.data.gitItemPath ?? pageToGitPath(path);
      const commits = await commitsOf(b, w, fileOfPage(w, path, gitItemPath), w.gitBranch, 1).catch(() => []);
      return {
        id: r.data.id ?? null,
        gitItemPath: fileOfPage(w, path, gitItemPath),
        content: (r.data.content ?? "").replace(/\r\n/g, "\n"),
        etag: r.headers.get("etag")?.replace(/^W\//, "").replace(/"/g, "") ?? null,
        commit: commits[0]?.commitId ?? null,
        last: commits[0] ? changeOf(commits[0], me) : null,
      };
    }),
  );
  return {
    ...meta,
    wiki: wikiRef(w),
    page: { path, name: nameOf(path), id: data.id, gitItemPath: data.gitItemPath, content: data.content, etag: data.etag, version: o.version ?? data.commit },
    lastChange: data.last,
    attachments: attachmentsOf(data.content),
    code: w.kind === "code" && w.repo ? { project: w.project, repo: w.repo, branch: w.gitBranch, filePath: data.gitItemPath, baseCommit: data.commit ?? "" } : null,
    webUrl: webPageUrl(b, w, path),
  };
}

// ---- history and the diff between two versions -----------------------------------------------------------------------

export interface HistoryResult extends ReadMeta {
  wiki: ReturnType<typeof wikiRef>;
  path: string;
  versions: (LastChange & { parent: string | null })[];
  more: boolean;
}

export async function wikiHistory(b: Browse, o: { project: string; wiki: string; path: string; top?: number }): Promise<HistoryResult> {
  const w = await wikiOf(b, o.project, o.wiki);
  const path = pagePath(o.path);
  const top = Math.min(Math.max(o.top ?? 50, 1), 500);
  const me = await meOf(b);
  const { data, meta } = await guarded(b, scope(w), () => cached(b, wkey(b, w, `history|${path.toLowerCase()}|${top}`), TTL.short, () => commitsOf(b, w, fileOfPage(w, path), w.gitBranch, top + 1)));
  const list = data.slice(0, top);
  return {
    ...meta,
    wiki: wikiRef(w),
    path,
    versions: list.map((c, i) => ({ ...changeOf(c, me), parent: data[i + 1]?.commitId ?? null })),
    more: data.length > top,
  };
}

export interface RevisionDiff extends ReadMeta {
  path: string;
  from: string | null;
  to: string;
  hunks: Hunk[];
  added: number;
  removed: number;
  fromContent: string;
  toContent: string;
}

export const countOf = (hs: Hunk[]) => ({
  added: hs.reduce((n, h) => n + h.lines.filter((l) => l.kind === "add").length, 0),
  removed: hs.reduce((n, h) => n + h.lines.filter((l) => l.kind === "del").length, 0),
});

export async function wikiRevisionDiff(b: Browse, o: { project: string; wiki: string; path: string; from?: string; to: string }): Promise<RevisionDiff> {
  for (const [k, v] of [["--to", o.to], ["--from", o.from]] as const) if (v && !/^[0-9a-f]{40}$/i.test(v)) throw new BrowseError("badInput", `${k} must be a full commit id`);
  const w = await wikiOf(b, o.project, o.wiki);
  const path = pagePath(o.path);
  const file = fileOfPage(w, path);
  const textAt = async (commit: string) =>
    (
      await cached(b, `wikifile|${b.org}|${w.repoId}|${file.toLowerCase()}|${commit}`, TTL.forever, async () => {
        try {
          return (await readFileAt(b, w.project, w.repoId, file, { name: commit, kind: "commit" }, 4 * 1024 * 1024)).content ?? "";
        } catch (e) {
          if (kindOf(e) === "notFound") return ""; // the page did not exist yet (or no longer)
          throw e;
        }
      })
    ).data;
  return guarded(b, scope(w), async () => {
    let from = o.from ?? null;
    if (!from) {
      const two = await commitsOf(b, w, file, o.to, 2);
      from = two.find((c) => c.commitId.toLowerCase() !== o.to.toLowerCase())?.commitId ?? null;
    }
    const [a, c] = await Promise.all([from ? textAt(from) : Promise.resolve(""), textAt(o.to)]);
    const hs = hunks(a, c);
    return { readAt: new Date(b.now()).toISOString(), cached: false, path, from, to: o.to, hunks: hs, ...countOf(hs), fromContent: a, toContent: c };
  });
}

// ---- attachments -----------------------------------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
};
export const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";

/** Where an attachment of a page lives in the wiki's repository. */
export function attachmentFile(w: Pick<WikiInfo, "kind" | "mappedPath">, ref: string, pageFile?: string): string {
  let r = ref.split(/[?#]/)[0];
  try {
    r = decodeURIComponent(r);
  } catch {
    /* keep */
  }
  if (r.startsWith("/")) return fileInRepo(w, r);
  const dir = pageFile ? posix.dirname(pageFile) : fileInRepo(w, "/");
  return posix.normalize(posix.join(dir, r));
}

export async function wikiAttachment(b: Browse, o: { project: string; wiki: string; ref: string; pagePath?: string }): Promise<{ name: string; mime: string; bytes: number; file: string; cached: boolean }> {
  const w = await wikiOf(b, o.project, o.wiki);
  if (!o.ref?.trim() || /^[a-z][a-z0-9+.-]*:/i.test(o.ref)) throw new BrowseError("badInput", "--ref must be a path in the wiki, such as /.attachments/image.png");
  const file = attachmentFile(w, o.ref, o.pagePath ? fileOfPage(w, pagePath(o.pagePath)) : undefined);
  const name = posix.basename(file);
  const dir = join(configHome(b.env), "cache", "wiki-attachments");
  const out = join(dir, `${createHash("sha1").update(`${b.org}|${w.repoId}|${w.gitBranch}|${file}`.toLowerCase()).digest("hex")}${extname(name).toLowerCase()}`);
  const memo = `wikiattach|${out}`;
  if (!b.refresh && cacheRead<number>(b.env, memo, TTL.lists, b.now())) {
    try {
      return { name, mime: mimeOf(name), bytes: statSync(out).size, file: out, cached: true };
    } catch {
      /* the file was cleaned up: download again */
    }
  }
  return guarded(b, scope(w), async () => {
    const url =
      `${b.client.remote.orgUrl}/${encodeURIComponent(w.project)}/_apis/git/repositories/${encodeURIComponent(w.repoId)}/items` +
      `?path=${encodeURIComponent(file)}&versionDescriptor.version=${encodeURIComponent(w.gitBranch)}&versionDescriptor.versionType=branch&$format=octetStream&download=true&api-version=7.1`;
    let bytes: Uint8Array;
    try {
      bytes = await b.client.fetchBytes(url, 19 * 1024 * 1024);
    } catch (e) {
      if (/\(404\)|failed \(404\)/.test((e as Error).message)) throw new BrowseError("notFound", `attachment ${o.ref} not found in ${w.name}`);
      if (/failed \((401|203)\)/.test((e as Error).message)) throw new BrowseError("signedOut", "not signed in to Azure DevOps: run 'az login' or set AIHUB_ADO_PAT");
      if (/failed \(403\)/.test((e as Error).message)) throw new BrowseError("noAccess", `no access to ${w.name}`);
      throw e;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(out, bytes);
    cacheWrite(b.env, memo, bytes.length, b.now());
    return { name, mime: mimeOf(name), bytes: bytes.length, file: out, cached: false };
  });
}

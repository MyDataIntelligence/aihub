import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Common } from "./browse";
import type { ChangeWhere } from "./change";

/**
 * The wiki browser: the aihub.bar.wiki* commands. Each one is one `aihub wiki browse ...` process and answers with the
 * CLI's JSON, or with `{ error: { kind, message } }` (the same kinds and the same 5-minute memory as the repository
 * browser). A code wiki is edited with aihub.bar.browsePush (the page answer carries `code`). The agent actions only put
 * text in the chat. Nothing runs at activation, nothing polls. The JSON shapes are in docs/cli-json.md ("Wiki browser").
 */

export interface WikiArg extends Common {
  project: string;
  wiki: string;
}
export interface TreeArg extends WikiArg {
  path?: string;
}
export interface PageArg extends WikiArg {
  path: string;
  /** a full commit id from wikiHistory: the page as it was */
  version?: string;
}
export interface PublishArg extends WikiArg {
  path: string;
  content: string;
  /** page.etag of the wikiPage answer the edit started from */
  etag?: string;
  comment?: string;
  /** Overwrite after a conflict */
  force?: boolean;
}
export interface CreateArg extends WikiArg {
  parent?: string;
  name: string;
  template?: "empty" | "runbook" | "decision";
  content?: string;
  comment?: string;
}
export interface MoveArg extends WikiArg {
  path: string;
  to: string;
  updateLinks?: boolean;
  order?: number;
  comment?: string;
}
export interface HistoryArg extends WikiArg {
  path: string;
  top?: number;
}
export interface RevisionDiffArg extends WikiArg {
  path: string;
  to: string;
  from?: string;
}
export interface WikiSearchArg extends Common {
  text: string;
  project?: string;
  wiki?: string;
  top?: number;
  skip?: number;
}
export interface AttachmentArg extends WikiArg {
  ref: string;
  pagePath?: string;
}
export interface UploadArg extends WikiArg {
  file: string;
  name?: string;
}
export interface AskArg {
  project: string;
  wiki: string;
  path: string;
  question?: string;
}
export interface UpdateFromBranchArg {
  project: string;
  wiki: string;
  path?: string;
  branch?: string;
  base?: string;
}

const s = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const posInt = (n: unknown): number | undefined => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined);

function common(a: Common | undefined, out: string[]): string[] {
  if (s(a?.org)) out.push("--org", a!.org!);
  if (a?.refresh) out.push("--refresh");
  return out;
}
const opt = (out: string[], flag: string, v: unknown) => {
  if (s(v)) out.push(flag, v);
  else if (posInt(v) !== undefined) out.push(flag, String(v));
  return out;
};
function wikiFlags(sub: string, a: WikiArg): string[] {
  if (!s(a?.project) || !s(a?.wiki)) throw new Error("a project and a wiki are needed ({ project, wiki })");
  return ["wiki", "browse", sub, "--project", a.project, "--wiki", a.wiki];
}
const needPath = (a: { path?: string }) => {
  if (!s(a?.path)) throw new Error("a page path is needed ({ path })");
  return a.path!;
};

/** The `aihub wiki browse ...` arguments of each read; throws on a missing required argument (the caller turns it into badInput). */
export const wikiArgs = {
  list: (a: Common = {}) => common(a, ["wiki", "browse", "wikis"]),
  tree: (a: TreeArg) => common(a, opt(wikiFlags("tree", a), "--path", a.path)),
  page: (a: PageArg) => common(a, opt(wikiFlags("page", a).concat("--path", needPath(a)), "--version", a.version)),
  templates: () => ["wiki", "browse", "templates"],
  movePlan: (a: MoveArg) => {
    if (!s(a?.to)) throw new Error("the new path is needed ({ to })");
    return common({ org: a.org }, wikiFlags("move-plan", a).concat("--path", needPath(a), "--to", a.to));
  },
  history: (a: HistoryArg) => common(a, opt(wikiFlags("history", a).concat("--path", needPath(a)), "--top", a.top)),
  revisionDiff: (a: RevisionDiffArg) => {
    if (!s(a?.to)) throw new Error("the version to show is needed ({ to })");
    return common(a, opt(wikiFlags("diff", a).concat("--path", needPath(a), "--to", a.to), "--from", a.from));
  },
  search: (a: WikiSearchArg) => {
    if (!s(a?.text)) throw new Error("a search text is needed ({ text })");
    return common(a, opt(opt(opt(opt(["wiki", "browse", "search", "--text", a.text], "--project", a.project), "--wiki", a.wiki), "--top", a.top), "--skip", a.skip));
  },
  attachment: (a: AttachmentArg) => {
    if (!s(a?.ref)) throw new Error("the attachment is needed ({ ref })");
    return common(a, opt(wikiFlags("attachment", a).concat("--ref", a.ref), "--page", a.pagePath));
  },
  /** asks nothing: the extension confirms first */
  delete: (a: PageArg) => common({ org: a.org }, wikiFlags("delete", a).concat("--path", needPath(a))),
  upload: (a: UploadArg) => {
    if (!s(a?.file)) throw new Error("a file is needed ({ file })");
    return common({ org: a.org }, opt(wikiFlags("upload", a).concat("--file", a.file), "--name", a.name));
  },
};

/** The writes whose text goes in private files (a page can be long, and never shows in the process list); removed after. */
export function wikiWriteFiles(kind: "publish" | "create" | "move", a: PublishArg | CreateArg | MoveArg): { args: string[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "aihub-wiki-"));
  const put = (name: string, text: string) => {
    const f = join(dir, name);
    writeFileSync(f, text, { encoding: "utf8", mode: 0o600 });
    return f;
  };
  let args: string[];
  if (kind === "publish") {
    const p = a as PublishArg;
    if (typeof p.content !== "string") throw new Error("wikiPublish needs content");
    if (!s(p.etag) && !p.force) throw new Error("wikiPublish needs the etag of the page it started from (or force: true)");
    args = wikiFlags("publish", p).concat("--path", needPath(p), "--content-file", put("page.md", p.content));
    opt(args, "--etag", p.etag);
    if (p.force) args.push("--force");
  } else if (kind === "create") {
    const c = a as CreateArg;
    if (!s(c.name)) throw new Error("wikiCreate needs a name");
    args = opt(opt(wikiFlags("create", c), "--parent", c.parent).concat("--name", c.name), "--template", c.template);
    if (typeof c.content === "string") args.push("--content-file", put("page.md", c.content));
  } else {
    const m = a as MoveArg;
    if (!s(m.to)) throw new Error("wikiMove needs the new path ({ to })");
    args = wikiFlags("move", m).concat("--path", needPath(m), "--to", m.to);
    if (m.updateLinks === false) args.push("--no-links");
    opt(args, "--order", m.order);
  }
  const comment = (a as { comment?: string }).comment;
  if (s(comment)) args.push("--comment-file", put("comment.txt", comment));
  return { args: common({ org: a.org }, args), dir };
}

// ---- the agent actions (text in the chat; the user presses Enter; nothing is published by the agent) ------------------

const q = (v: string) => `"${v.replace(/"/g, '\\"')}"`;

/** "Ask the agent about this page". */
export function askText(a: AskArg): string {
  const read = `aihub wiki browse page --project ${q(a.project)} --wiki ${q(a.wiki)} --path ${q(a.path)}`;
  const ask = s(a.question) ? a.question.trim() : "Explain what this page says and point out what looks out of date compared with the code in this workspace.";
  return `About the wiki page ${a.path} (${a.wiki}, project ${a.project}): ${ask} Read it first with: ${read}. Answer in the chat; do not change or publish the page.`;
}

/** "Update from this branch": drafts of wiki changes from the branch diff, written as files the user reviews and publishes. */
export function updateFromBranchText(a: UpdateFromBranchArg): string {
  const branch = s(a.branch) ? a.branch : "the current branch";
  const base = s(a.base) ? a.base : "its base branch";
  const start = s(a.path) ? ` Start with the page ${a.path}.` : "";
  return (
    `Update the wiki ${a.wiki} (project ${a.project}) from ${branch}: read the diff of ${branch} against ${base}, then the pages it touches ` +
    `(aihub wiki browse tree --project ${q(a.project)} --wiki ${q(a.wiki)} and aihub wiki browse page ... --path <page>).${start} ` +
    `For each page that should change, write the full new markdown as a draft file .aihub/wiki-drafts/${a.wiki}/<page path>.md and list the pages with one line on why. ` +
    `Only drafts: do not run aihub wiki browse publish, create or move; I review and publish each page myself.`
  );
}

// ---- Update Wiki with Context from… (aihub wiki update; the agent window is chosen like Change with Agent) ----------------

export interface WikiUpdateSource {
  project: string;
  repo: string;
  /** a folder or file of the repository; empty: the whole repository */
  path?: string;
  ref?: string;
  /** a clone on this PC (read only) */
  local?: string;
}
export interface WikiUpdateStartArg {
  project: string;
  wiki: string;
  /** the chosen pages; none: the whole wiki (the agent may propose new pages) */
  pages?: string[];
  /** from the repository selector: repositories, folders, files, with a clone or remote */
  sources: WikiUpdateSource[];
  prompt?: string;
  /** This window | New VS Code window | Terminal only */
  where?: ChangeWhere;
  org?: string;
}
export interface WikiUpdateStartJson {
  id: string;
  dir: string;
  pagesDir: string;
  project: string;
  wiki: string;
  chosen: string[];
  allowNew: boolean;
  pages: { path: string; file: string; exists: boolean }[];
  language: string | null;
  taskFile: string;
  agentPrompt: string;
}

/** Checks the start of a wiki update and builds `aihub wiki update start` (the sources and the prompt go in files). */
export function wikiUpdateStartArgs(a: WikiUpdateStartArg | undefined): { args: string[]; sources: WikiUpdateSource[]; prompt?: string; where: ChangeWhere; wiki: string } {
  if (!s(a?.project) || !s(a?.wiki)) throw new Error("a project and a wiki are needed ({ project, wiki })");
  const sources = (a!.sources ?? []).filter((x) => s(x?.project) && s(x?.repo));
  if (!sources.length) throw new Error("which repositories, folders or files hold the context? ({ sources: [{ project, repo, path? }] })");
  const pages = (a!.pages ?? []).filter(s);
  const args = ["wiki", "update", "start", "--project", a!.project, "--wiki", a!.wiki, ...pages.flatMap((p) => ["--path", p])];
  if (s(a!.org)) args.push("--org", a!.org!);
  const where: ChangeWhere = a!.where === "newWindow" || a!.where === "terminal" ? a!.where : "panel";
  return { args, sources, prompt: s(a!.prompt) ? a!.prompt : undefined, where, wiki: a!.wiki };
}
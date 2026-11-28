import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { configHome } from "../configHome.js";
import { BrowseError, normPath, type Browse } from "./core.js";
import { changeStart, changeWrite, forbiddenFile, secretIn, type StartResult } from "./change.js";
import { hunks, type Hunk } from "./lineDiff.js";
import { headOf } from "./push.js";
import { readFileAt, repoRowOf } from "./read.js";

/**
 * Ask Agent about Selected: a read-only question over several repositories and projects. The agent searches (Code Search),
 * reads remote files through `ask read` (counted: past 200 files it stops and the user must allow more), and answers with a
 * report per repository; a fix is a PROPOSAL (`ask propose`: the whole new file), never a change. Afterwards, per repository,
 * "Apply in Feature Branch" makes an `aihub browse change` with the proposals (the same branch name for every repository of the
 * question). Nothing is changed or pushed by the question itself.
 */

export const READ_LIMIT = 200;

export interface ScopeItem {
  project: string;
  repo?: string;
}

export interface AskMeta {
  id: string;
  org: string;
  prompt: string;
  scope: ScopeItem[];
  createdAt: string;
  /** the files read, `project/repo/path` */
  reads: string[];
  limit: number;
  /** the base commit of each repository the agent read or proposed in (`project/repo` -> {branch, commit}) */
  bases: Record<string, { branch: string; commit: string }>;
  /** one branch name for every Apply of this question */
  branch?: string;
  story?: number;
  /** `project/repo` -> change id */
  applied: Record<string, string>;
}

export interface AskReport {
  summary: string;
  repos: { project: string; repo: string; finding: string; refs?: { path: string; line?: number; note?: string }[] }[];
}

export const asksRoot = (env: NodeJS.ProcessEnv) => join(configHome(env), "asks");
const dirOf = (env: NodeJS.ProcessEnv, id: string) => {
  if (!/^[\w.-]+$/.test(id)) throw new BrowseError("badInput", `'${id}' is not a question id`);
  return join(asksRoot(env), id);
};
const metaFile = (dir: string) => join(dir, "ask.json");
const keyOf = (project: string, repo: string) => `${project}/${repo}`;
const propDir = (dir: string, project: string, repo: string) => join(dir, "proposals", project, repo);

/**
 * The reads and the bases are one small file each (an agent reads several files at once: one shared JSON would lose some).
 * `meta.reads` and `meta.bases` are filled from them on every read of the question.
 */
const readsDir = (dir: string) => join(dir, "reads");
const basesDir = (dir: string) => join(dir, "bases");
const fileKey = (k: string) => createHash("sha1").update(k.toLowerCase()).digest("hex");

function recordRead(dir: string, key: string): void {
  mkdirSync(readsDir(dir), { recursive: true });
  writeFileSync(join(readsDir(dir), fileKey(key)), key, "utf8");
}

function recordBase(dir: string, key: string, base: { branch: string; commit: string }): void {
  mkdirSync(basesDir(dir), { recursive: true });
  writeFileSync(join(basesDir(dir), `${fileKey(key)}.json`), JSON.stringify({ key, ...base }), "utf8");
}

function filled(dir: string, meta: AskMeta): AskMeta {
  const list = (d: string) => (existsSync(d) ? readdirSync(d) : []);
  const reads = list(readsDir(dir)).map((f) => readFileSync(join(readsDir(dir), f), "utf8"));
  const bases: AskMeta["bases"] = {};
  for (const f of list(basesDir(dir))) {
    const x = JSON.parse(readFileSync(join(basesDir(dir), f), "utf8")) as { key: string; branch: string; commit: string };
    bases[x.key] = { branch: x.branch, commit: x.commit };
  }
  return { ...meta, reads: reads.sort(), bases };
}

export function readAsk(env: NodeJS.ProcessEnv, id: string): { dir: string; meta: AskMeta } {
  const dir = dirOf(env, id);
  try {
    return { dir, meta: filled(dir, JSON.parse(readFileSync(metaFile(dir), "utf8")) as AskMeta) };
  } catch {
    throw new BrowseError("notFound", `there is no question '${id}' on this PC (aihub browse ask list)`);
  }
}

const save = (dir: string, meta: AskMeta) => {
  mkdirSync(dir, { recursive: true });
  const { reads: _r, bases: _b, ...rest } = meta;
  writeFileSync(metaFile(dir), JSON.stringify({ ...rest, reads: [], bases: {} }, null, 2), "utf8");
};

const inScope = (scope: ScopeItem[], project: string, repo: string) => scope.some((x) => x.project.toLowerCase() === project.toLowerCase() && (!x.repo || x.repo.toLowerCase() === repo.toLowerCase()));

export function askTask(meta: AskMeta): string {
  const scope = meta.scope.map((x) => (x.repo ? `${x.project}/${x.repo}` : `${x.project} (all repositories)`));
  const s = meta.scope.map((x) => (x.repo ? `${x.project}/${x.repo}` : x.project)).join(",");
  const id = meta.id;
  return [
    `# Question ${id}`,
    "",
    "## The question",
    "",
    meta.prompt.trim(),
    "",
    "## Scope",
    "",
    ...scope.map((x) => `- ${x}`),
    "",
    "## How (read only)",
    "",
    `- Search: \`aihub browse search --text "<text>" --scope ${s}\` (one call covers the whole scope).`,
    `- A folder: \`aihub browse items --project P --repo R --path /folder\`.`,
    `- A file: \`aihub browse ask read --id ${id} --project P --repo R --path /file\` (counted: after ${meta.limit} files it stops; then ask the user before reading more).`,
    `- A fix you propose: write the WHOLE new file with your normal edit tool under ./drafts/<repo>/<path> in this folder (not with shell here-strings or echo), then run \`aihub browse ask propose --id ${id} --project P --repo R --path /file --content-file ./drafts/<repo>/<path>\`. It changes nothing; the user decides per repository.`,
    `- The report: a JSON file \`{"summary": "...", "repos": [{"project": "P", "repo": "R", "finding": "...", "refs": [{"path": "/file", "line": 12, "note": "..."}]}]}\`, then \`aihub browse ask report --id ${id} --file <file>\`. One entry per repository you looked at, also "nothing found".`,
    "",
    "## Finish (required: the user sees only what these commands store)",
    "",
    "1. For every fix you suggest: `aihub browse ask propose ...` with the whole new file (printing a diff is not enough).",
    "2. The report: `aihub browse ask report ...` with the JSON above (printing it is not enough).",
    "3. Then say in one line that the report is stored.",
    "",
    "## Fixed limits",
    "",
    "- Read only: never change, commit, push or clone anything; no git.",
    `- At most ${meta.limit} files read without asking the user.`,
    "- Only the repositories of the scope; no secrets in proposals; no pipeline, variable-group or .env files.",
    "",
  ].join("\n");
}

function newId(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `ask-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(16).slice(2, 6)}`;
}

export function askStart(b: Browse, o: { scope: ScopeItem[]; prompt: string; story?: number; limit?: number }) {
  if (!o.scope.length) throw new BrowseError("badInput", "which repositories or projects? (--scope P,P/R,...)");
  if (!o.prompt.trim()) throw new BrowseError("badInput", "what is the question? (--prompt-file)");
  const id = newId(b.now());
  const dir = dirOf(b.env, id);
  const meta: AskMeta = { id, org: b.org, prompt: o.prompt.trim(), scope: o.scope, createdAt: new Date(b.now()).toISOString(), reads: [], limit: o.limit ?? READ_LIMIT, bases: {}, ...(o.story ? { story: o.story } : {}), applied: {} };
  save(dir, meta);
  const taskFile = join(dir, "TASK.md");
  writeFileSync(taskFile, askTask(meta), "utf8");
  return { id, dir, scope: meta.scope, limit: meta.limit, taskFile, agentPrompt: "Read TASK.md and answer the question. Store every proposed fix with aihub browse ask propose and the report with aihub browse ask report. Read only: do not change, commit or push anything." };
}

/** The base of a repository for this question: its default branch's head, the first time it is used (kept, so reads and proposals agree). */
async function baseOf(b: Browse, dir: string, meta: AskMeta, project: string, repo: string): Promise<{ branch: string; commit: string }> {
  const k = keyOf(project, repo);
  if (meta.bases[k]) return meta.bases[k];
  const row = await repoRowOf(b, project, repo);
  const head = await headOf(b, row.project, row.repo, row.defaultBranch);
  if (!head) throw new BrowseError("notFound", `${repo} has no default branch`);
  meta.bases[k] = { branch: row.defaultBranch, commit: head };
  recordBase(dir, k, meta.bases[k]);
  return meta.bases[k];
}

export async function askRead(b: Browse, id: string, o: { project: string; repo: string; path: string }) {
  const { dir, meta } = readAsk(b.env, id);
  if (!inScope(meta.scope, o.project, o.repo)) throw new BrowseError("badInput", `${o.project}/${o.repo} is not in the scope of this question`);
  const p = normPath(o.path);
  const k = `${keyOf(o.project, o.repo)}${p}`;
  if (!meta.reads.includes(k) && meta.reads.length >= meta.limit) throw new BrowseError("readLimit", `${meta.reads.length} files read: the limit of ${meta.limit} is reached. Ask the user; they allow more with aihub browse ask allow --id ${id}`);
  const base = await baseOf(b, dir, meta, o.project, o.repo);
  const f = await readFileAt(b, o.project, o.repo, p, { name: base.commit, kind: "commit" });
  recordRead(dir, k);
  const read = readAsk(b.env, id).meta.reads.length;
  return { id, project: o.project, repo: o.repo, path: p, commit: base.commit, read, limit: meta.limit, binary: f.binary, tooLarge: f.tooLarge, content: f.content };
}

export function askAllow(env: NodeJS.ProcessEnv, id: string, more = READ_LIMIT) {
  const { dir, meta } = readAsk(env, id);
  meta.limit = Math.max(meta.limit, meta.reads.length) + more;
  save(dir, meta);
  return { id, read: meta.reads.length, limit: meta.limit };
}

export async function askPropose(b: Browse, id: string, o: { project: string; repo: string; path: string; content: string }) {
  const { dir, meta } = readAsk(b.env, id);
  if (!inScope(meta.scope, o.project, o.repo)) throw new BrowseError("badInput", `${o.project}/${o.repo} is not in the scope of this question`);
  const p = normPath(o.path);
  const why = forbiddenFile(p);
  if (why) throw new BrowseError("forbiddenFile", `${p} is ${why}: never proposed`);
  const s = secretIn(o.content);
  if (s) throw new BrowseError("secret", `the proposal for ${p} would contain ${s}`);
  await baseOf(b, dir, meta, o.project, o.repo);
  const file = join(propDir(dir, o.project, o.repo), p.slice(1));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, o.content, "utf8");
  return { id, project: o.project, repo: o.repo, path: p, proposed: true };
}

export function parseReport(text: string, scope: ScopeItem[]): AskReport {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new BrowseError("badInput", `the report is not JSON: ${(e as Error).message}`);
  }
  const r = j as Partial<AskReport>;
  if (typeof r.summary !== "string" || !Array.isArray(r.repos)) throw new BrowseError("badInput", 'the report needs {"summary": "...", "repos": [{"project", "repo", "finding", "refs"?}]}');
  const repos = r.repos.map((x, i) => {
    if (!x || typeof x.project !== "string" || typeof x.repo !== "string" || typeof x.finding !== "string") throw new BrowseError("badInput", `repos[${i}] needs project, repo and finding`);
    if (!inScope(scope, x.project, x.repo)) throw new BrowseError("badInput", `repos[${i}] ${x.project}/${x.repo} is not in the scope`);
    const refs = Array.isArray(x.refs) ? x.refs.filter((y) => y && typeof y.path === "string").map((y) => ({ path: normPath(y.path), ...(typeof y.line === "number" ? { line: y.line } : {}), ...(typeof y.note === "string" ? { note: y.note } : {}) })) : [];
    return { project: x.project, repo: x.repo, finding: x.finding, refs };
  });
  return { summary: r.summary, repos };
}

export function askReport(env: NodeJS.ProcessEnv, id: string, text: string) {
  const { dir, meta } = readAsk(env, id);
  const report = parseReport(text, meta.scope);
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  return { id, repos: report.repos.length };
}

function walk(root: string, at = root, out: string[] = []): string[] {
  if (!existsSync(at)) return out;
  for (const e of readdirSync(at, { withFileTypes: true })) {
    const p = join(at, e.name);
    if (e.isDirectory()) walk(root, p, out);
    else if (e.isFile()) out.push(normPath(p.slice(root.length).replace(/\\/g, "/")));
  }
  return out;
}

export interface Proposal {
  path: string;
  status: "modified" | "added";
  additions: number;
  deletions: number;
  hunks: Hunk[];
}

/** The proposals of one repository as diffs against its base. */
async function proposalsOf(b: Browse, dir: string, meta: AskMeta, project: string, repo: string): Promise<{ list: Proposal[]; contents: Map<string, string> }> {
  const root = propDir(dir, project, repo);
  const list: Proposal[] = [];
  const contents = new Map<string, string>();
  const base = meta.bases[keyOf(project, repo)];
  for (const p of walk(root)) {
    const mine = readFileSync(join(root, p.slice(1)), "utf8");
    contents.set(p, mine);
    let before: string | null = null;
    try {
      before = base ? (await readFileAt(b, project, repo, p, { name: base.commit, kind: "commit" })).content : null;
    } catch {
      before = null;
    }
    const h = hunks(before ?? "", mine);
    const count = (k: "add" | "del") => h.reduce((n, x) => n + x.lines.filter((l) => l.kind === k).length, 0);
    list.push({ path: p, status: before === null ? "added" : "modified", additions: count("add"), deletions: count("del"), hunks: h });
  }
  return { list, contents };
}

export async function askState(b: Browse, id: string) {
  const { dir, meta } = readAsk(b.env, id);
  let report: AskReport | null = null;
  try {
    report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as AskReport;
  } catch {
    report = null;
  }
  const keys = new Set([...(report?.repos ?? []).map((r) => keyOf(r.project, r.repo)), ...Object.keys(meta.bases).filter((k) => existsSync(propDir(dir, ...(k.split("/") as [string, string]))))]);
  const repos = [];
  for (const k of [...keys].sort((x, y) => x.localeCompare(y))) {
    const [project, repo] = k.split("/");
    const r = report?.repos.find((x) => keyOf(x.project, x.repo) === k);
    repos.push({ project, repo, base: meta.bases[k] ?? null, finding: r?.finding ?? null, refs: r?.refs ?? [], proposals: (await proposalsOf(b, dir, meta, project, repo)).list, change: meta.applied[k] ?? null });
  }
  return { id, prompt: meta.prompt, scope: meta.scope, status: report ? "answered" : "open", reads: { count: meta.reads.length, limit: meta.limit }, needsApproval: meta.reads.length >= meta.limit, summary: report?.summary ?? null, branch: meta.branch ?? null, repos };
}

/**
 * Apply in Feature Branch, for one repository: an `aihub browse change` on the question's branch (one name for every repository)
 * with the proposals written into it. Nothing is pushed: the change is reviewed and pushed like any other.
 */
export async function askApply(b: Browse, id: string, o: { project: string; repo: string; branch?: string; story?: number }): Promise<StartResult & { applied: string[] }> {
  const { dir, meta } = readAsk(b.env, id);
  const k = keyOf(o.project, o.repo);
  if (meta.applied[k]) throw new BrowseError("badInput", `${k} has its change already: ${meta.applied[k]}`);
  const { contents } = await proposalsOf(b, dir, meta, o.project, o.repo);
  if (!contents.size) throw new BrowseError("badInput", `the question proposes nothing for ${k}`);
  const story = o.story ?? meta.story;
  const s = await changeStart(b, { project: o.project, repo: o.repo, ref: meta.bases[k]?.branch, branch: o.branch ?? meta.branch, story, prompt: meta.prompt });
  for (const [p, c] of contents) await changeWrite(b, s.id, p, { content: c });
  meta.branch = s.branch;
  meta.applied[k] = s.id;
  save(dir, meta);
  return { ...s, applied: [...contents.keys()] };
}

export function askDiscard(env: NodeJS.ProcessEnv, id: string) {
  const dir = dirOf(env, id);
  if (!existsSync(dir)) throw new BrowseError("notFound", `there is no question '${id}' on this PC`);
  rmSync(dir, { recursive: true, force: true });
  return { id, discarded: true };
}

export function askList(env: NodeJS.ProcessEnv) {
  const root = asksRoot(env);
  if (!existsSync(root)) return { asks: [] };
  const asks = readdirSync(root)
    .map((id) => {
      try {
        const m = JSON.parse(readFileSync(metaFile(join(root, id)), "utf8")) as AskMeta;
        return { id: m.id, prompt: m.prompt, scope: m.scope, createdAt: m.createdAt, reads: m.reads.length, answered: existsSync(join(root, id, "report.json")) };
      } catch {
        return undefined;
      }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  return { asks };
}

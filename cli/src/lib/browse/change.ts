import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { configHome } from "../configHome.js";
import { BrowseError, normPath, repoClientOf, shortSha, webCommitUrl, webRepoUrl, type Browse } from "./core.js";
import { hunks, merge3, splitLines, type Hunk } from "./lineDiff.js";
import { contentAt, createRemotePr, headOf, isProtected, teamOf } from "./push.js";
import { browseHistory, readFileAt, repoRowOf } from "./read.js";

/**
 * Change with Agent, remote: a workspace per change in the user's config folder (never in a repository). `files/` holds the
 * files the agent read or changed, at the same paths as the repository; `.base/` the version of each one at the base commit.
 * A file counts as changed when `files/` differs from `.base/`. Nothing is pushed until `push`, which makes ONE commit on a NEW
 * branch through the Pushes API. Never to main/master/staging/develop or a protected branch, at most 20 files, no secrets, no
 * pipeline, variable-group or .env files.
 */

export const MAX_CHANGED_FILES = 20;
const ZERO = "0".repeat(40);

export interface ChangeMeta {
  id: string;
  org: string;
  project: string;
  repo: string;
  base: { branch: string; commit: string };
  branch: string;
  story?: number;
  prompt?: string;
  createdAt: string;
  status: "open" | "pushed" | "discarded";
  deleted: string[];
  pushed?: { branch: string; commit: string; pr: { id: number; title: string; webUrl: string } | null; at: string };
}

export const changesRoot = (env: NodeJS.ProcessEnv) => join(configHome(env), "changes");
const dirOf = (env: NodeJS.ProcessEnv, id: string) => {
  if (!/^[\w.-]+$/.test(id)) throw new BrowseError("badInput", `'${id}' is not a change id`);
  return join(changesRoot(env), id);
};
const metaFile = (dir: string) => join(dir, "change.json");
const filesDir = (dir: string) => join(dir, "files");
const baseDir = (dir: string) => join(dir, ".base");
const rel = (p: string) => normPath(p).slice(1);
const ABSENT = ".absent";

export function readMeta(env: NodeJS.ProcessEnv, id: string): { dir: string; meta: ChangeMeta } {
  const dir = dirOf(env, id);
  try {
    return { dir, meta: JSON.parse(readFileSync(metaFile(dir), "utf8")) as ChangeMeta };
  } catch {
    throw new BrowseError("notFound", `there is no change '${id}' on this PC (aihub browse change list)`);
  }
}

function writeMeta(dir: string, meta: ChangeMeta): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(metaFile(dir), JSON.stringify(meta, null, 2), "utf8");
}

const openOnly = (meta: ChangeMeta) => {
  if (meta.status !== "open") throw new BrowseError("badInput", `change ${meta.id} is ${meta.status}; start a new one`);
};

// ---- names and limits ------------------------------------------------------------------------------------------------

/** A few words of the prompt for a branch name: lower case ascii, at most 5 words. */
export function slugOf(text: string): string {
  return (
    text
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter((w) => w.length > 1 && !STOP.has(w))
      .slice(0, 5)
      .join("-") || "change"
  );
}
const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "be", "it", "de", "het", "een", "van", "in", "op", "en", "te", "dat", "die", "met", "voor", "must", "should", "not", "niet", "moet", "add", "make"]);

/** The team's branch template (team.yaml `branches.feature`, e.g. `feature/<story>-<slug>`), else `feature/<story>-<slug>`. */
export function branchFromTemplate(template: string | undefined, story: number | undefined, slug: string): string {
  const t = template?.trim() || "feature/<story>-<slug>";
  let out = t.replace(/[<{]slug[>}]/gi, slug);
  out = story ? out.replace(/[<{](story|id)[>}]/gi, String(story)) : out.replace(/[<{](story|id)[>}][-_/]?/gi, "");
  return out.replace(/\/{2,}/g, "/");
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, "a private key"],
  [/\b(?:AccountKey|SharedAccessKey|AccessKey)=[A-Za-z0-9+/=]{20,}/, "a storage or service bus key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "a GitHub token"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\s$]{8,}["']/i, "a password or key in quotes"],
];

/** The kind of secret in a text, if any (the value is never repeated). */
export function secretIn(text: string): string | undefined {
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what;
  return undefined;
}

/** Files a change never touches: secrets, pipelines and variable groups. */
export function forbiddenFile(path: string): string | undefined {
  const p = normPath(path).toLowerCase();
  const name = p.split("/").pop() ?? "";
  if (/^\.env(\..*)?$/.test(name) || /\.(pfx|p12|pem|key|jks|keystore)$/.test(name)) return "a secrets file";
  if (/^azure-pipelines.*\.ya?ml$/.test(name) || /\.pipeline\.ya?ml$/.test(name) || (/\/(\.?pipelines?)\//.test(p) && /\.ya?ml$/.test(name))) return "a pipeline definition";
  if (/variable[-_]?groups?/.test(p) || /^variables.*\.ya?ml$/.test(name)) return "a variable group";
  return undefined;
}

// ---- start ----------------------------------------------------------------------------------------------------------

export interface StartResult {
  id: string;
  dir: string;
  filesDir: string;
  project: string;
  repo: string;
  base: { branch: string; commit: string };
  branch: string;
  story: number | null;
  materialized: string[];
  limits: { maxFiles: number; never: string[] };
  /** the full task for the agent (TASK.md in dir) and the one line that starts it */
  taskFile: string;
  agentPrompt: string;
}

export interface Selection {
  path: string;
  startLine: number;
  endLine: number;
}

/** TASK.md: what to change, where the files are, the commands, and the fixed limits. One place for every agent. */
export function taskText(meta: ChangeMeta, o: { selection?: Selection; materialized: string[]; selectedText?: string }): string {
  const id = meta.id;
  const repoArgs = `--project "${meta.project}" --repo "${meta.repo}"`;
  return [
    `# Change ${id}`,
    "",
    "## What should change",
    "",
    meta.prompt?.trim() || "(no description given: ask the user)",
    "",
    "## Where",
    "",
    `Repository ${meta.repo} (project ${meta.project}), branch ${meta.base.branch} at commit ${meta.base.commit}. The change will become branch ${meta.branch} when the user pushes it.`,
    "",
    ...(o.selection ? [`The user selected ${o.selection.path} lines ${o.selection.startLine}-${o.selection.endLine}${o.selectedText ? ":" : "."}`, ...(o.selectedText ? ["", "```", o.selectedText, "```"] : []), ""] : []),
    "The files of the repository are under ./files, at their paths in the repository" + (o.materialized.length ? ` (already there: ${o.materialized.join(", ")}).` : "."),
    "",
    "## How",
    "",
    `- Another file: \`aihub browse change read --id ${id} --path /path/in/repo\` puts it under ./files.`,
    `- A folder: \`aihub browse items ${repoArgs} --ref commit:${meta.base.commit} --path /folder\`.`,
    `- Search the repository: \`aihub browse search --text "<text>" ${repoArgs}\`.`,
    "- Change and add files under ./files with your normal edit tools.",
    `- Remove a file: \`aihub browse change rm --id ${id} --path /path/in/repo\`.`,
    `- See your change: \`aihub browse change diff --id ${id}\`.`,
    `- When done: write a short summary for the reviewer in a file and run \`aihub browse change summary --id ${id} --file <file>\`. Say that tests were not run.`,
    "",
    "## Fixed limits",
    "",
    "- Do not push, commit, merge or run git: the user pushes from the review.",
    `- Never ${["main", "master", "staging", "develop"].join(", ")}; only this repository; at most ${MAX_CHANGED_FILES} files.`,
    "- No secrets (keys, passwords, tokens), no pipeline definitions, variable groups or .env files.",
    "- Tests cannot run here (no clone).",
    "",
  ].join("\n");
}

function newId(repo: string, now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const r = Math.random().toString(16).slice(2, 6);
  return `${repo.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}-${stamp}-${r}`;
}

export async function changeStart(b: Browse, o: { project: string; repo: string; ref?: string; branch?: string; story?: number; paths?: string[]; prompt?: string; selection?: Selection }): Promise<StartResult> {
  const row = await repoRowOf(b, o.project, o.repo);
  const baseBranch = (o.ref ?? row.defaultBranch).replace(/^refs\/heads\//, "");
  if (!baseBranch) throw new BrowseError("notFound", `repository '${o.repo}' is empty (no default branch)`);
  const head = await headOf(b, row.project, row.repo, baseBranch);
  if (!head) throw new BrowseError("notFound", `branch '${baseBranch}' not found in ${row.repo}`);
  const team = await teamOf(b, row.project, row.repo, baseBranch);
  const branch = (o.branch?.trim() || branchFromTemplate(team.branches?.feature, o.story, slugOf(o.prompt ?? o.paths?.[0] ?? "change"))).replace(/^refs\/heads\//, "");
  if (isProtected(branch, team, [row.defaultBranch, baseBranch])) throw new BrowseError("protectedBranch", `a change never goes to '${branch}': name a new feature branch`);
  const id = newId(row.repo, b.now());
  const dir = dirOf(b.env, id);
  const meta: ChangeMeta = { id, org: b.org, project: row.project, repo: row.repo, base: { branch: baseBranch, commit: head }, branch, ...(o.story ? { story: o.story } : {}), ...(o.prompt ? { prompt: o.prompt } : {}), createdAt: new Date(b.now()).toISOString(), status: "open", deleted: [] };
  mkdirSync(filesDir(dir), { recursive: true });
  mkdirSync(baseDir(dir), { recursive: true });
  writeMeta(dir, meta);
  const materialized: string[] = [];
  const wanted = [...(o.paths ?? []), ...(o.selection ? [o.selection.path] : [])].map((p) => normPath(p)).filter((p, i, a) => a.indexOf(p) === i);
  let selectedText: string | undefined;
  for (const p of wanted) {
    const r = await materialize(b, dir, meta, p).catch(() => undefined);
    if (r?.content !== undefined && r.content !== null) {
      materialized.push(p);
      if (o.selection && normPath(o.selection.path) === p) selectedText = splitLines(r.content).slice(Math.max(0, o.selection.startLine - 1), o.selection.endLine).join("\n");
    }
  }
  const taskFile = join(dir, "TASK.md");
  writeFileSync(taskFile, taskText(meta, { selection: o.selection, materialized, selectedText }), "utf8");
  const agentPrompt = `Read ${taskFile} and make the change it describes, in the files under ${filesDir(dir)}. Do not push or commit.`;
  return { id, dir, filesDir: filesDir(dir), project: row.project, repo: row.repo, base: meta.base, branch, story: o.story ?? null, materialized, limits: { maxFiles: MAX_CHANGED_FILES, never: ["main", "master", "staging", "develop", row.defaultBranch].filter((x, i, a) => x && a.indexOf(x) === i) }, taskFile, agentPrompt };
}

// ---- read / write ---------------------------------------------------------------------------------------------------

/** The base version of a file: kept in .base/ (an `.absent` marker when the file is new). */
async function baseOf(b: Browse, dir: string, meta: ChangeMeta, path: string): Promise<{ exists: boolean; content: string | null; binary: boolean }> {
  const file = join(baseDir(dir), rel(path));
  if (existsSync(file)) return { exists: true, content: readFileSync(file, "utf8"), binary: false };
  if (existsSync(file + ABSENT)) return { exists: false, content: null, binary: false };
  try {
    const f = await readFileAt(b, meta.project, meta.repo, normPath(path), { name: meta.base.commit, kind: "commit" });
    if (f.content === null) return { exists: true, content: null, binary: f.binary || f.tooLarge };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, f.content, "utf8");
    return { exists: true, content: f.content, binary: false };
  } catch (e) {
    if ((e as { kind?: string }).kind === "notFound" || /\(404\)|could not be found/i.test((e as Error).message)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + ABSENT, "", "utf8");
      return { exists: false, content: null, binary: false };
    }
    throw e;
  }
}

/** Puts a file in files/ (the base version) unless it is there already. */
async function materialize(b: Browse, dir: string, meta: ChangeMeta, path: string): Promise<{ content: string | null; modified: boolean; binary: boolean; exists: boolean }> {
  const target = join(filesDir(dir), rel(path));
  const base = await baseOf(b, dir, meta, path);
  if (existsSync(target)) {
    const content = readFileSync(target, "utf8");
    return { content, modified: !base.exists || base.content !== content, binary: false, exists: true };
  }
  if (meta.deleted.includes(normPath(path))) return { content: null, modified: true, binary: false, exists: false };
  if (!base.exists) return { content: null, modified: false, binary: false, exists: false };
  if (base.content === null) return { content: null, modified: false, binary: base.binary, exists: true };
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, base.content, "utf8");
  return { content: base.content, modified: false, binary: false, exists: true };
}

export async function changeRead(b: Browse, id: string, path: string) {
  const { dir, meta } = readMeta(b.env, id);
  const r = await materialize(b, dir, meta, path);
  if (!r.exists && r.content === null) throw new BrowseError("notFound", `${normPath(path)} is not in ${meta.repo} at ${meta.base.branch} (write it to add it)`);
  return { id, path: normPath(path), file: join(filesDir(dir), rel(path)), modified: r.modified, binary: r.binary, content: r.content };
}

export async function changeWrite(b: Browse, id: string, path: string, o: { content?: string; delete?: boolean }) {
  const { dir, meta } = readMeta(b.env, id);
  openOnly(meta);
  const p = normPath(path);
  if (p === "/") throw new BrowseError("badInput", "a file path is needed (--path)");
  const why = forbiddenFile(p);
  if (why) throw new BrowseError("forbiddenFile", `${p} is ${why}: a change never touches it`);
  if (o.content !== undefined) {
    const s = secretIn(o.content);
    if (s) throw new BrowseError("secret", `${p} would contain ${s}: secrets never go into a change`);
  }
  await baseOf(b, dir, meta, p);
  const target = join(filesDir(dir), rel(p));
  if (o.delete) {
    rmSync(target, { force: true });
    if (!meta.deleted.includes(p)) meta.deleted.push(p);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, o.content ?? "", "utf8");
    meta.deleted = meta.deleted.filter((x) => x !== p);
  }
  writeMeta(dir, meta);
  const d = await changeDiff(b, id);
  return { id, path: p, deleted: !!o.delete, changedFiles: d.totals.files, problems: d.problems };
}

export function changeSummary(env: NodeJS.ProcessEnv, id: string, text: string) {
  const { dir } = readMeta(env, id);
  writeFileSync(join(dir, "summary.md"), text, "utf8");
  return { id, summary: text.trim() };
}

// ---- diff -----------------------------------------------------------------------------------------------------------

export interface ChangedFile {
  path: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
  hunks: Hunk[];
  /** the new content (null for deleted) */
  content: string | null;
}

export interface Problem {
  path?: string;
  kind: "tooManyFiles" | "secret" | "forbiddenFile";
  message: string;
}

function walk(root: string, at = root, out: string[] = []): string[] {
  if (!existsSync(at)) return out;
  for (const e of readdirSync(at, { withFileTypes: true })) {
    const p = join(at, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git") continue;
      walk(root, p, out);
    } else if (e.isFile()) out.push(normPath(relative(root, p).split(sep).join("/")));
  }
  return out;
}

export async function changeDiff(b: Browse, id: string) {
  const { dir, meta } = readMeta(b.env, id);
  const files: ChangedFile[] = [];
  for (const p of walk(filesDir(dir))) {
    const content = readFileSync(join(filesDir(dir), rel(p)), "utf8");
    const base = await baseOf(b, dir, meta, p);
    if (base.exists && base.content === content) continue;
    if (base.exists && base.content === null) {
      files.push({ path: p, status: "modified", additions: 0, deletions: 0, hunks: [], content });
      continue;
    }
    const h = hunks(base.content ?? "", content);
    const count = (k: "add" | "del") => h.reduce((n, x) => n + x.lines.filter((l) => l.kind === k).length, 0);
    files.push({ path: p, status: base.exists ? "modified" : "added", additions: count("add"), deletions: count("del"), hunks: h, content });
  }
  for (const p of meta.deleted) {
    const base = await baseOf(b, dir, meta, p);
    if (!base.exists || existsSync(join(filesDir(dir), rel(p)))) continue;
    files.push({ path: p, status: "deleted", additions: 0, deletions: splitLines(base.content ?? "").length, hunks: hunks(base.content ?? "", ""), content: null });
  }
  files.sort((x, y) => x.path.localeCompare(y.path));
  const problems: Problem[] = [];
  if (files.length > MAX_CHANGED_FILES) problems.push({ kind: "tooManyFiles", message: `${files.length} files changed; a change has at most ${MAX_CHANGED_FILES}` });
  for (const f of files) {
    const why = forbiddenFile(f.path);
    if (why) problems.push({ path: f.path, kind: "forbiddenFile", message: `${f.path} is ${why}: a change never touches it` });
    const s = f.content !== null ? secretIn(f.content) : undefined;
    if (s) problems.push({ path: f.path, kind: "secret", message: `${f.path} contains ${s}` });
  }
  let summary: string | null = null;
  try {
    summary = readFileSync(join(dir, "summary.md"), "utf8").trim() || null;
  } catch {
    summary = null;
  }
  return {
    id,
    status: meta.status,
    project: meta.project,
    repo: meta.repo,
    branch: meta.branch,
    base: meta.base,
    dir,
    filesDir: filesDir(dir),
    files: files.map(({ content: _c, ...f }) => f),
    totals: { files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) },
    summary,
    problems,
    ...(meta.pushed ? { pushed: meta.pushed } : {}),
    contents: Object.fromEntries(files.map((f) => [f.path, f.content])),
  };
}

// ---- push -----------------------------------------------------------------------------------------------------------

export type ChangePushResult =
  | { status: "pushed"; branch: string; commit: { id: string; short: string; webUrl: string }; startedFrom: string; rebased: boolean; files: string[]; pr: { id: number; title: string; webUrl: string } | null; prError: string | null; webUrl: string }
  | { status: "conflict"; files: { path: string; latest: { id: string; short: string; message: string; at: string | null; by: { name: string; email: string; isMe: boolean } } | null; overlap: boolean }[] };

export async function changePush(b: Browse, id: string, o: { message?: string; pr?: boolean; target?: string; story?: number; prTitle?: string; draft?: boolean; rebase?: boolean; branch?: string }): Promise<ChangePushResult> {
  const { dir, meta } = readMeta(b.env, id);
  openOnly(meta);
  const d = await changeDiff(b, id);
  if (!d.files.length) throw new BrowseError("badInput", "nothing changed in this change; there is nothing to push");
  const first = d.problems[0];
  if (first) throw new BrowseError(first.kind as never, first.message);
  const branch = (o.branch?.trim() || meta.branch).replace(/^refs\/heads\//, "");
  const rc = repoClientOf(b, meta.project, meta.repo);
  const repoInfo = await rc.get<{ defaultBranch?: string }>(rc.repoPath());
  const def = (repoInfo.defaultBranch ?? "").replace(/^refs\/heads\//, "");
  const team = await teamOf(b, meta.project, meta.repo, def || meta.base.branch);
  if (isProtected(branch, team, [def, meta.base.branch])) throw new BrowseError("protectedBranch", `pushing to '${branch}' is refused: a change goes to a new feature branch`);
  if (await headOf(b, meta.project, meta.repo, branch)) throw new BrowseError("branchExists", `branch '${branch}' already exists in ${meta.repo}: choose another name`);
  const head = await headOf(b, meta.project, meta.repo, meta.base.branch);
  if (!head) throw new BrowseError("notFound", `branch '${meta.base.branch}' not found in ${meta.repo}`);
  // per file: did it change on the base branch since the base commit?
  let startFrom = meta.base.commit;
  let rebased = false;
  const contents = new Map(Object.entries(d.contents));
  if (head.toLowerCase() !== meta.base.commit.toLowerCase()) {
    const conflicts: Extract<ChangePushResult, { status: "conflict" }>["files"] = [];
    const merged = new Map<string, string | null>();
    for (const f of d.files) {
      const then = await contentAt(b, meta.project, meta.repo, f.path, meta.base.commit);
      const now = await contentAt(b, meta.project, meta.repo, f.path, head);
      if ((then?.objectId ?? null) === (now?.objectId ?? null)) continue;
      const mine = contents.get(f.path) ?? null;
      const m = then?.content != null && now?.content != null && mine !== null ? merge3(then.content, mine, now.content) : { overlap: true as const, merged: undefined };
      if (o.rebase && !m.overlap && m.merged !== undefined) merged.set(f.path, m.merged);
      else {
        const hist = await browseHistory({ ...b, refresh: true }, { project: meta.project, repo: meta.repo, path: f.path, ref: meta.base.branch, top: 1 }).catch(() => undefined);
        const c = hist?.commits[0];
        conflicts.push({ path: f.path, latest: c ? { id: c.id, short: c.short, message: c.message, at: c.at, by: c.by } : null, overlap: m.overlap });
      }
    }
    if (conflicts.length) return { status: "conflict", files: conflicts };
    // nothing overlaps (or nothing changed there): the change goes on top of the newest version
    for (const [p, c] of merged) contents.set(p, c);
    startFrom = head;
    rebased = merged.size > 0 || !!o.rebase;
  }
  const exists = async (p: string) => (await contentAt(b, meta.project, meta.repo, p, startFrom)) !== null;
  const changes = [];
  for (const f of d.files) {
    if (f.status === "deleted") changes.push({ changeType: "delete", item: { path: f.path } });
    else changes.push({ changeType: (await exists(f.path)) ? "edit" : "add", item: { path: f.path }, newContent: { content: contents.get(f.path) ?? "", contentType: "rawtext" } });
  }
  const message = (o.message?.trim() || defaultMessage(meta, d.summary)).trim();
  const pushed = await rc.post<{ commits?: { commitId: string }[]; refUpdates?: { newObjectId: string }[] }>(`${rc.repoPath()}/pushes`, {
    refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId: ZERO }],
    commits: [{ comment: message, parents: [startFrom], changes }],
  });
  const commitId = pushed.commits?.[0]?.commitId ?? pushed.refUpdates?.[0]?.newObjectId ?? "";
  const out: Extract<ChangePushResult, { status: "pushed" }> = {
    status: "pushed",
    branch,
    commit: { id: commitId, short: shortSha(commitId), webUrl: webCommitUrl(b, meta.project, meta.repo, commitId) },
    startedFrom: startFrom,
    rebased,
    files: d.files.map((f) => f.path),
    pr: null,
    prError: null,
    webUrl: `${webRepoUrl(b, meta.project, meta.repo)}?version=GB${encodeURIComponent(branch)}`,
  };
  if (o.pr) {
    try {
      out.pr = await createRemotePr(b, { project: meta.project, repo: meta.repo, branch, target: o.target || def || meta.base.branch, path: d.files[0].path, message, story: o.story ?? meta.story, prTitle: o.prTitle, draft: o.draft, commitId, team });
    } catch (e) {
      out.prError = (e as Error).message;
    }
  }
  meta.status = "pushed";
  meta.branch = branch;
  meta.pushed = { branch, commit: commitId, pr: out.pr, at: new Date(b.now()).toISOString() };
  writeMeta(dir, meta);
  return out;
}

function defaultMessage(meta: ChangeMeta, summary: string | null): string {
  const first = (summary ?? meta.prompt ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const line = first.length > 72 ? `${first.slice(0, 69)}...` : first;
  return `${meta.story ? `#${meta.story} ` : ""}${line || "Change with Agent"}`;
}

// ---- apply, discard, list -------------------------------------------------------------------------------------------

/**
 * Open as Working Copy: the changed files written into a working copy (a clone or worktree on the change's branch). A file that
 * differs there from the base version (local work) is skipped and named; nothing else is touched.
 */
export async function changeApply(b: Browse, id: string, target: string) {
  const d = await changeDiff(b, id);
  const { dir, meta } = readMeta(b.env, id);
  if (!existsSync(target)) throw new BrowseError("notFound", `${target} does not exist`);
  const applied: string[] = [];
  const skipped: { path: string; why: string }[] = [];
  for (const f of d.files) {
    const file = join(target, rel(f.path));
    const base = await baseOf(b, dir, meta, f.path);
    const here = existsSync(file) ? readFileSync(file, "utf8") : null;
    const untouched = here === null ? !base.exists || f.status === "added" : base.content !== null && here.replace(/\r\n/g, "\n") === base.content.replace(/\r\n/g, "\n");
    if (!untouched && here !== d.contents[f.path]) {
      skipped.push({ path: f.path, why: "the working copy has its own change in this file" });
      continue;
    }
    if (f.status === "deleted") {
      if (existsSync(file)) unlinkSync(file);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, d.contents[f.path] ?? "", "utf8");
    }
    applied.push(f.path);
  }
  return { id, target, branch: meta.branch, applied, skipped };
}

export function changeDiscard(env: NodeJS.ProcessEnv, id: string) {
  const dir = dirOf(env, id);
  if (!existsSync(dir)) throw new BrowseError("notFound", `there is no change '${id}' on this PC`);
  rmSync(dir, { recursive: true, force: true });
  return { id, discarded: true };
}

export function changeList(env: NodeJS.ProcessEnv) {
  const root = changesRoot(env);
  if (!existsSync(root)) return { changes: [] };
  const changes = readdirSync(root)
    .map((id) => {
      try {
        const meta = JSON.parse(readFileSync(metaFile(join(root, id)), "utf8")) as ChangeMeta;
        return { id: meta.id, project: meta.project, repo: meta.repo, branch: meta.branch, base: meta.base, status: meta.status, createdAt: meta.createdAt, dir: join(root, id), updatedAt: statSync(join(root, id)).mtime.toISOString() };
      } catch {
        return undefined;
      }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  return { changes };
}


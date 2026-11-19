import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { findActivePr, getPr, shortBranch } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { defaultTargetFor, loadTeam } from "./team.js";
import { git, hasRef, originDefaultBranch, repoRoot, workItemFromBranch } from "./git.js";

/**
 * Facts for the learn skill. Everything here comes from git and the working files, in well under a second: the CLI
 * never writes the lesson, the skill does. Azure DevOps is asked only for `--pr`, to find the two branches.
 */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The enclosing function or class git reports, when it knows one. */
  header: string;
  added: string[];
  removed: string[];
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  additions: number;
  deletions: number;
  language: string;
  hunks: Hunk[];
}

export interface Symbol {
  name: string;
  kind: "function" | "class" | "model";
  file: string;
  line: number;
}

export interface Reference {
  symbol: string;
  file: string;
  line: number;
  text: string;
}

export interface DbtModel {
  name: string;
  file: string;
  /** Models that `ref()` this one. */
  downstream: string[];
  /** What this model refs. */
  upstream: string[];
  sources: string[];
}

export interface ChangeFacts {
  kind: "change-facts";
  schemaVersion: 1;
  source: { pr?: number; branch: string; base: string; head: string; range: string };
  story?: { id: number };
  commits: { sha: string; subject: string }[];
  stats: { files: number; additions: number; deletions: number };
  files: FileChange[];
  symbols: Symbol[];
  impact: { callers: Reference[]; tests: Reference[]; dbt: DbtModel[] };
  /** Honest limits: what the facts do not cover. */
  notes: string[];
}

const LANG: Record<string, string> = { ".py": "python", ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".kt": "kotlin", ".java": "java", ".cs": "csharp", ".sql": "sql", ".yml": "yaml", ".yaml": "yaml", ".md": "markdown", ".json": "json", ".ps1": "powershell", ".sh": "shell", ".tf": "terraform" };
export const languageOf = (p: string) => LANG[extname(p).toLowerCase()] ?? "other";

export const isTestPath = (p: string) => /(^|\/)(tests?|__tests__|spec)\/|(^|[._-])(test|tests|spec)\.[a-z]+$|^test_|_test\.[a-z]+$/i.test(p);

const MAX_HUNK_LINES = 40;
const MAX_FILES = 60;
const MAX_REFS = 8;

// ---- range ------------------------------------------------------------------------------------

export interface RangeInput {
  pr?: string;
  branch?: string;
  range?: string;
}

const tipRef = (root: string, b: string) => (hasRef(root, `origin/${b}`) ? `origin/${b}` : hasRef(root, b) ? b : "");

export async function resolveRange(ctx: Ctx, o: RangeInput): Promise<ChangeFacts["source"]> {
  const root = repoRoot(ctx.cwd);
  if (o.range) {
    const m = /^(.+?)\.\.\.?(.+)$/.exec(o.range.trim());
    if (!m) throw new AihubError("--range must be <base>..<head>, for example origin/main..HEAD");
    for (const r of [m[1], m[2]]) if (!hasRef(root, r)) throw new AihubError(`unknown revision '${r}'`);
    return { branch: m[2], base: git(root, ["merge-base", m[1], m[2]]).trim() || m[1], head: m[2], range: o.range };
  }
  if (o.pr) {
    const { client } = repoClient(ctx);
    const id = Number(String(o.pr).replace(/^.*\/pullrequest\//, "").replace(/\D/g, ""));
    if (!id) throw new AihubError(`--pr needs a number or a pull request link, got '${o.pr}'`);
    const pr = await getPr(client, id);
    const src = shortBranch(pr.sourceRefName);
    const tgt = shortBranch(pr.targetRefName);
    const head = tipRef(root, src);
    const base = tipRef(root, tgt);
    if (!head || !base) throw new AihubError(`the branches of PR !${id} (${src}, ${tgt}) are not in this clone; run git fetch origin first`);
    return { pr: id, branch: src, base: git(root, ["merge-base", base, head]).trim(), head, range: `${base}...${head}` };
  }
  const branch = o.branch ?? git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const head = tipRef(root, branch) || "HEAD";
  // the branch's real target: the target of its active PR, else the team's defaultTarget, else the repository default
  let target = "";
  let repoName = "";
  try {
    const { client } = repoClient(ctx);
    repoName = client.remote.repo;
    const pr = await findActivePr(client, branch);
    if (pr?.targetRefName && tipRef(root, shortBranch(pr.targetRefName))) target = shortBranch(pr.targetRefName);
  } catch {
    // no Azure DevOps remote or no network: the team file and the git facts below decide
  }
  if (!target) {
    const team = loadTeam(root);
    const t = (repoName ? defaultTargetFor(team, repoName) : undefined) ?? team.repositories?.[0]?.defaultTarget;
    if (t && t !== branch && tipRef(root, t)) target = t;
  }
  target ||= originDefaultBranch(root) || (hasRef(root, "origin/main") ? "main" : hasRef(root, "origin/staging") ? "staging" : "main");
  const baseRef = tipRef(root, target);
  if (!baseRef) throw new AihubError(`no target branch '${target}' found; pass --range <base>..<head>`);
  return { branch, base: git(root, ["merge-base", baseRef, head]).trim(), head, range: `${baseRef}...${head}` };
}

// ---- diff -------------------------------------------------------------------------------------

export function parseHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  let cur: Hunk | undefined;
  for (const line of diff.split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (m) {
      cur = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], header: m[5].trim(), added: [], removed: [] };
      out.push(cur);
    } else if (cur && line.startsWith("+") && !line.startsWith("+++")) {
      if (cur.added.length < MAX_HUNK_LINES) cur.added.push(line.slice(1));
    } else if (cur && line.startsWith("-") && !line.startsWith("---")) {
      if (cur.removed.length < MAX_HUNK_LINES) cur.removed.push(line.slice(1));
    }
  }
  return out;
}

function changedFiles(root: string, base: string, head: string): FileChange[] {
  const raw = git(root, ["diff", "--numstat", "--find-renames", "-z", `${base}`, head]);
  const files: FileChange[] = [];
  // -z: "adds\tdels\tpath\0" or for renames "adds\tdels\t\0old\0new\0"
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length && files.length < MAX_FILES; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]);
    if (!m) continue;
    let path = m[3];
    let oldPath: string | undefined;
    if (!path) {
      oldPath = parts[++i];
      path = parts[++i];
    }
    files.push({ path, oldPath, status: oldPath ? "renamed" : "modified", additions: m[1] === "-" ? 0 : +m[1], deletions: m[2] === "-" ? 0 : +m[2], language: languageOf(path), hunks: [] });
  }
  const names = git(root, ["diff", "--name-status", "--find-renames", base, head]).split("\n");
  for (const l of names) {
    const [s, a, b] = l.split("\t");
    const f = files.find((x) => x.path === (b ?? a));
    if (f) f.status = s.startsWith("A") ? "added" : s.startsWith("D") ? "deleted" : s.startsWith("R") ? "renamed" : "modified";
  }
  for (const f of files) {
    if (f.additions + f.deletions === 0 || f.language === "other" && f.additions + f.deletions > 400) continue;
    const d = git(root, ["diff", "-U0", "--no-color", "--find-renames", base, head, "--", f.path], { allowFail: true });
    f.hunks = parseHunks(d);
  }
  return files;
}

// ---- symbols ----------------------------------------------------------------------------------

const SYMBOL_RE: Record<string, RegExp[]> = {
  python: [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^\s*class\s+([A-Za-z_]\w*)/],
  typescript: [/\bfunction\s+([A-Za-z_$][\w$]*)/, /\bclass\s+([A-Za-z_$][\w$]*)/, /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/],
  javascript: [/\bfunction\s+([A-Za-z_$][\w$]*)/, /\bclass\s+([A-Za-z_$][\w$]*)/, /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/],
  kotlin: [/\bfun\s+(?:<[^>]*>\s*)?(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)/, /\b(?:class|object|interface)\s+([A-Za-z_]\w*)/],
  java: [/\b(?:class|interface|enum)\s+([A-Za-z_]\w*)/, /^\s*(?:public|private|protected|static|\s)+[\w<>\[\],\s]+\s+([A-Za-z_]\w*)\s*\([^;]*$/],
  csharp: [/\b(?:class|interface|struct)\s+([A-Za-z_]\w*)/],
  powershell: [/^\s*function\s+([A-Za-z_][\w-]*)/i],
};

const COMMON = new Set(["main", "init", "get", "set", "run", "test", "setup", "teardown", "constructor", "toString"]);

export function symbolsOf(files: FileChange[]): Symbol[] {
  const out: Symbol[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: Symbol["kind"], file: string, line: number) => {
    const key = `${file}:${name}`;
    if (!name || seen.has(key) || name.length < 3) return;
    seen.add(key);
    out.push({ name, kind, file, line });
  };
  for (const f of files) {
    if (f.language === "sql" && /(^|\/)models\//.test(f.path)) add(basename(f.path, ".sql"), "model", f.path, 1);
    const res = SYMBOL_RE[f.language] ?? [];
    for (const h of f.hunks) {
      const lines = [h.header, ...h.added];
      for (const [i, text] of lines.entries()) for (const re of res) {
        const m = re.exec(text);
        if (m) add(m[1], /class|object|interface|struct|enum/.test(text) ? "class" : "function", f.path, i === 0 ? h.newStart : h.newStart + i - 1);
      }
    }
  }
  return out;
}

// ---- impact -----------------------------------------------------------------------------------

function grepRefs(root: string, head: string, symbol: string, skip: string): Reference[] {
  const out = git(root, ["grep", "-n", "-w", "-I", "-F", symbol, head, "--", ":!" + skip, ":!*.lock", ":!*.min.js", ":!node_modules"], { allowFail: true });
  const refs: Reference[] = [];
  const prefix = `${head}:`;
  for (const l of out.split("\n")) {
    if (!l) continue;
    const m = /^(.*?):(\d+):(.*)$/.exec(l.startsWith(prefix) ? l.slice(prefix.length) : l);
    if (m) refs.push({ symbol, file: m[1], line: +m[2], text: m[3].trim().slice(0, 160) });
    if (refs.length >= MAX_REFS * 3) break;
  }
  return refs;
}

export function dbtImpact(root: string, head: string, files: FileChange[]): DbtModel[] {
  const models = files.filter((f) => f.language === "sql" && /(^|\/)models\//.test(f.path) && f.status !== "deleted");
  const out: DbtModel[] = [];
  for (const f of models) {
    const name = basename(f.path, ".sql");
    const body = git(root, ["show", `${head}:${f.path}`], { allowFail: true });
    const refs = [...body.matchAll(/ref\(\s*['"]([\w.-]+)['"]\s*\)/g)].map((m) => m[1]);
    const sources = [...body.matchAll(/source\(\s*['"]([\w.-]+)['"]\s*,\s*['"]([\w.-]+)['"]\s*\)/g)].map((m) => `${m[1]}.${m[2]}`);
    const down = git(root, ["grep", "-l", "-I", "-E", `ref\\(\\s*['"]${name}['"]\\s*\\)`, head, "--", "*.sql"], { allowFail: true })
      .split("\n")
      .map((l) => l.replace(`${head}:`, ""))
      .filter((p) => p && p !== f.path)
      .map((p) => basename(p, ".sql"));
    out.push({ name, file: f.path, upstream: [...new Set(refs)], downstream: [...new Set(down)], sources: [...new Set(sources)] });
  }
  return out;
}

export function impactOf(root: string, head: string, files: FileChange[], symbols: Symbol[]): ChangeFacts["impact"] {
  const callers: Reference[] = [];
  const tests: Reference[] = [];
  // names defined in a test file are tests themselves: they are not searched for
  for (const s of symbols.filter((x) => x.kind !== "model" && !COMMON.has(x.name) && !isTestPath(x.file)).slice(0, 12)) {
    for (const r of grepRefs(root, head, s.name, s.file)) (isTestPath(r.file) ? tests : callers).push(r);
  }
  const cut = (l: Reference[]) => {
    const per = new Map<string, number>();
    return l.filter((r) => {
      const n = (per.get(r.symbol) ?? 0) + 1;
      per.set(r.symbol, n);
      return n <= MAX_REFS;
    });
  };
  return { callers: cut(callers), tests: cut(tests), dbt: dbtImpact(root, head, files) };
}

// ---- the facts ----------------------------------------------------------------------------------

export async function changeFacts(ctx: Ctx, o: RangeInput): Promise<ChangeFacts> {
  const root = repoRoot(ctx.cwd);
  const source = await resolveRange(ctx, o);
  const files = changedFiles(root, source.base, source.head);
  const symbols = symbolsOf(files);
  const commits = git(root, ["log", "--format=%h%x09%s", `${source.base}..${source.head}`, "-n", "30"], { allowFail: true })
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ sha: l.split("\t")[0], subject: l.split("\t").slice(1).join("\t") }));
  const story = workItemFromBranch(source.branch);
  const notes = ["impact is a text search for the changed names (git grep), not a call graph: a hit can be a different thing with the same name, and dynamic calls are missed"];
  if (files.length >= MAX_FILES) notes.push(`only the first ${MAX_FILES} files are listed`);
  return {
    kind: "change-facts",
    schemaVersion: 1,
    source,
    ...(story ? { story: { id: story } } : {}),
    commits,
    stats: { files: files.length, additions: files.reduce((a, f) => a + f.additions, 0), deletions: files.reduce((a, f) => a + f.deletions, 0) },
    files,
    symbols,
    impact: impactOf(root, source.head, files, symbols),
    notes,
  };
}

export function formatChange(f: ChangeFacts): string {
  const L = [`${f.source.pr ? `PR !${f.source.pr}, ` : ""}${f.source.branch}: ${f.stats.files} file(s), +${f.stats.additions} -${f.stats.deletions}  (${f.source.range})`];
  for (const c of f.commits.slice(0, 8)) L.push(`  ${c.sha} ${c.subject}`);
  for (const x of f.files.slice(0, 25)) L.push(`  ${x.status.padEnd(8)} ${x.path}  +${x.additions} -${x.deletions}`);
  if (f.symbols.length) L.push(`changed names: ${f.symbols.map((s) => s.name).join(", ")}`);
  L.push(`used by: ${f.impact.callers.length} place(s); tests that mention them: ${f.impact.tests.length}${f.impact.dbt.length ? `; dbt models: ${f.impact.dbt.map((m) => `${m.name} (${m.downstream.length} downstream)`).join(", ")}` : ""}`);
  L.push("use --json for the full facts");
  return L.join("\n");
}

// ---- the repository ---------------------------------------------------------------------------

export interface RepoFacts {
  kind: "repo-facts";
  schemaVersion: 1;
  name: string;
  languages: Record<string, number>;
  folders: { path: string; files: number; languages: string[] }[];
  entryPoints: string[];
  tests: { folders: string[]; files: number };
  pipelines: string[];
  dbt?: { project: string; models: number; edges: { from: string; to: string }[]; sources: string[] };
  teamFile: boolean;
  readmeHeadings: string[];
  notes: string[];
}

export function repoFacts(ctx: Ctx): RepoFacts {
  const root = repoRoot(ctx.cwd);
  const tracked = git(root, ["ls-files"]).split("\n").filter(Boolean);
  const languages: Record<string, number> = {};
  const byFolder = new Map<string, { files: number; langs: Set<string> }>();
  for (const p of tracked) {
    const lang = languageOf(p);
    if (lang !== "other") languages[lang] = (languages[lang] ?? 0) + 1;
    const top = p.includes("/") ? p.split("/")[0] : ".";
    const e = byFolder.get(top) ?? { files: 0, langs: new Set<string>() };
    e.files++;
    if (lang !== "other") e.langs.add(lang);
    byFolder.set(top, e);
  }
  const folders = [...byFolder].filter(([k]) => k !== ".").map(([path, e]) => ({ path, files: e.files, languages: [...e.langs].slice(0, 4) })).sort((a, b) => b.files - a.files).slice(0, 25);
  const entry = tracked.filter((p) => /^(main\.py|app\.py|manage\.py|index\.(ts|js)|package\.json|pyproject\.toml|setup\.py|Makefile|Dockerfile|src\/main\.[a-z]+|src\/index\.[a-z]+|[^/]+\.sln)$/.test(p));
  const testFiles = tracked.filter(isTestPath);
  const pipelines = tracked.filter((p) => /(^|\/)(azure-pipelines[^/]*\.ya?ml|\.azuredevops\/.*\.ya?ml|\.github\/workflows\/.*\.ya?ml)$/.test(p));
  const dbtProject = tracked.find((p) => /(^|\/)dbt_project\.yml$/.test(p));
  let dbt: RepoFacts["dbt"];
  if (dbtProject) {
    const dir = dbtProject.includes("/") ? dbtProject.slice(0, dbtProject.lastIndexOf("/") + 1) : "";
    const sql = tracked.filter((p) => p.startsWith(`${dir}models/`) && p.endsWith(".sql"));
    const edges: { from: string; to: string }[] = [];
    const sources = new Set<string>();
    for (const p of sql.slice(0, 400)) {
      const full = join(root, p);
      if (!existsSync(full)) continue;
      const body = readFileSync(full, "utf8");
      const name = basename(p, ".sql");
      for (const m of body.matchAll(/ref\(\s*['"]([\w.-]+)['"]\s*\)/g)) edges.push({ from: m[1], to: name });
      for (const m of body.matchAll(/source\(\s*['"]([\w.-]+)['"]\s*,\s*['"]([\w.-]+)['"]\s*\)/g)) {
        sources.add(`${m[1]}.${m[2]}`);
        edges.push({ from: `${m[1]}.${m[2]}`, to: name });
      }
    }
    dbt = { project: dbtProject, models: sql.length, edges: edges.slice(0, 500), sources: [...sources] };
  }
  const readme = tracked.find((p) => /^readme(\.md)?$/i.test(p));
  const headings = readme && existsSync(join(root, readme)) ? [...readFileSync(join(root, readme), "utf8").matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 15) : [];
  return {
    kind: "repo-facts",
    schemaVersion: 1,
    name: basename(root),
    languages,
    folders,
    entryPoints: entry,
    tests: { folders: [...new Set(testFiles.filter((p) => p.includes("/")).map((p) => p.split("/")[0]))].slice(0, 8), files: testFiles.length },
    pipelines,
    ...(dbt ? { dbt } : {}),
    teamFile: tracked.includes(".agents/skills/_shared/references/team.yaml"),
    readmeHeadings: headings,
    notes: ["facts only; the architecture story is written by the learn skill", `${tracked.length} tracked files read from git, nothing else`],
  };
}

export function formatRepo(r: RepoFacts): string {
  const L = [`${r.name}: ${Object.entries(r.languages).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v}`).join(", ")}`];
  for (const f of r.folders.slice(0, 12)) L.push(`  ${f.path}/  ${f.files} file(s) ${f.languages.join(", ")}`);
  if (r.entryPoints.length) L.push(`entry points: ${r.entryPoints.join(", ")}`);
  L.push(`tests: ${r.tests.files} file(s) in ${r.tests.folders.join(", ") || "-"}`);
  if (r.pipelines.length) L.push(`pipelines: ${r.pipelines.join(", ")}`);
  if (r.dbt) L.push(`dbt: ${r.dbt.models} model(s), ${r.dbt.edges.length} edge(s), ${r.dbt.sources.length} source(s)`);
  L.push("use --json for the full facts");
  return L.join("\n");
}


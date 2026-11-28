import { spawnSync } from "./proc.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { chooseTarget } from "./branch.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { currentBranch, git, hasRef, repoRoot } from "./git.js";
import { globToRegExp, loadTeam, type TeamConfig } from "./team.js";

/**
 * The rules that apply to a set of files, collected from the places agents and editors already read:
 * AGENTS.md in the folder of the file and every folder above it (the nearest wins on a conflict, the higher ones add),
 * CLAUDE.md, .github/copilot-instructions.md, .github/instructions/*.instructions.md whose `applyTo` globs match, and the
 * files team.yaml lists under `guidelines:`. Only the rules (list items), de-duplicated, each with its source, so it costs
 * few tokens.
 */
export interface GuidelineSource {
  /** repository-relative path */
  path: string;
  kind: "AGENTS.md" | "CLAUDE.md" | "copilot-instructions" | "instructions" | "team.yaml";
  /** the files of the request this source applies to */
  appliesTo: string[];
}
export interface GuidelineRule {
  text: string;
  /** "path:line" */
  source: string;
}
export interface GuidelinesResult {
  paths: string[];
  sources: GuidelineSource[];
  rules: GuidelineRule[];
}

export interface GuidelinesSettings {
  files: string[];
  linters: LinterSpec[];
}
export interface LinterSpec {
  name: string;
  /** shell command; {files} becomes the changed files it applies to, quoted */
  command: string;
  /** globs of the files it applies to */
  files: string[];
}

/** Built-in linters by name: the command and the files they lint. */
const PRESETS: Record<string, Omit<LinterSpec, "name">> = {
  ruff: { command: "ruff check --output-format=concise --no-cache {files}", files: ["**/*.py"] },
  sqlfluff: { command: "sqlfluff lint --nofail {files}", files: ["**/*.sql"] },
};

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" && v ? [v] : []);

/**
 * `guidelines:` in team.yaml: a list of files (the old form), or `{ files: [...], linters: [...] }`. A linter is a preset name
 * (ruff, sqlfluff) or `{ name, command, files }`.
 */
export function guidelinesSettings(team: TeamConfig): GuidelinesSettings {
  const g = (team as Record<string, unknown>).guidelines;
  if (Array.isArray(g)) return { files: asList(g), linters: [] };
  if (!g || typeof g !== "object") return { files: [], linters: [] };
  const o = g as Record<string, unknown>;
  const linters: LinterSpec[] = [];
  for (const l of Array.isArray(o.linters) ? o.linters : []) {
    if (typeof l === "string") {
      const p = PRESETS[l.toLowerCase()];
      if (p) linters.push({ name: l, ...p });
      else throw new AihubError(`guidelines.linters: '${l}' is not a known linter; give it as { name, command, files }`);
    } else if (l && typeof l === "object") {
      const x = l as Record<string, unknown>;
      const name = String(x.name ?? "");
      const preset = PRESETS[name.toLowerCase()];
      const command = String(x.command ?? preset?.command ?? "");
      if (!name || !command) throw new AihubError("guidelines.linters: every linter needs a name and a command");
      linters.push({ name, command, files: asList(x.files).length ? asList(x.files) : preset?.files ?? ["**/*"] });
    }
  }
  return { files: asList(o.files), linters };
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** A repository path matches a glob; "**\/x" also matches "x" at the root. */
export function globMatches(glob: string, path: string): boolean {
  const g = norm(glob.trim());
  if (!g) return false;
  if (globToRegExp(g).test(path)) return true;
  return g.startsWith("**/") && globToRegExp(g.slice(3)).test(path);
}

/** The `applyTo` globs of an .instructions.md file (front matter), comma separated; none means every file. */
export function applyToOf(text: string): string[] {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const line = m ? /^applyTo:\s*(.+)$/m.exec(m[1]) : null;
  if (!line) return [];
  return line[1]
    .trim()
    .replace(/^["']|["']$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** One rule on one line, at most 200 characters (the source line has the rest). */
const short = (s: string): string => {
  const one = s.replace(/\s+/g, " ");
  return one.length > 200 ? `${one.slice(0, 199).trimEnd()}…` : one;
};

/**
 * The rules of a guideline file: its list items (`-`, `*`, `1.`), outside code blocks and front matter. A file without
 * list items gives its first plain lines (at most 12). Each rule with its line.
 */
export function rulesOf(text: string, path: string): GuidelineRule[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: GuidelineRule[] = [];
  const plain: GuidelineRule[] = [];
  let fence = false;
  let front = lines[0] === "---";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (front) {
      if (i > 0 && l === "---") front = false;
      continue;
    }
    if (/^\s*(```|~~~)/.test(l)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(l);
    if (item) {
      // a continuation line of the same item is not read: one line per rule keeps it short
      out.push({ text: short(item[1]), source: `${path}:${i + 1}` });
      continue;
    }
    const t = l.trim();
    if (t && !/^#/.test(t) && !/^[|>]/.test(t) && plain.length < 12) plain.push({ text: short(t), source: `${path}:${i + 1}` });
  }
  return out.length ? out : plain;
}

const read = (abs: string): string | undefined => {
  try {
    return statSync(abs).isFile() ? readFileSync(abs, "utf8") : undefined;
  } catch {
    return undefined;
  }
};

/** AGENTS.md files from the folder of `rel` up to the root, nearest first. */
function agentsChain(root: string, rel: string): string[] {
  const out: string[] = [];
  let dir = dirname(rel) === "." ? "" : norm(dirname(rel));
  for (;;) {
    const p = dir ? `${dir}/AGENTS.md` : "AGENTS.md";
    if (existsSync(join(root, p))) out.push(p);
    if (!dir) break;
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
  return out;
}

/** The repository-relative form of a path given on the command line (absolute or relative to cwd). */
function toRepoPath(root: string, cwd: string, p: string): string {
  const abs = resolve(cwd, p);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || rel === "") throw new AihubError(`'${p}' is not inside the repository ${root}`);
  return norm(rel.split(sep).join("/"));
}

/** Collects the sources and rules for `paths` (repository-relative), nearest AGENTS.md first, de-duplicated. */
export function collectGuidelines(root: string, paths: string[], team: TeamConfig = loadTeam(root)): GuidelinesResult {
  const sources = new Map<string, GuidelineSource>();
  const add = (path: string, kind: GuidelineSource["kind"], file: string) => {
    const s = sources.get(path) ?? { path, kind, appliesTo: [] };
    if (!s.appliesTo.includes(file)) s.appliesTo.push(file);
    sources.set(path, s);
  };
  // the nearest AGENTS.md of every file first (by depth, deepest first), then the higher ones
  const chains = paths.map((p) => ({ p, chain: agentsChain(root, p) }));
  const depth = (s: string) => s.split("/").length;
  const agents = [...new Set(chains.flatMap((c) => c.chain))].sort((a, b) => depth(b) - depth(a));
  for (const a of agents) for (const c of chains) if (c.chain.includes(a)) add(a, "AGENTS.md", c.p);
  for (const [p, kind] of [["CLAUDE.md", "CLAUDE.md"], [".github/copilot-instructions.md", "copilot-instructions"]] as const) {
    if (existsSync(join(root, p))) for (const f of paths) add(p, kind, f);
  }
  const instDir = join(root, ".github", "instructions");
  if (existsSync(instDir)) {
    for (const n of readdirSync(instDir).filter((n) => n.endsWith(".instructions.md")).sort()) {
      const p = `.github/instructions/${n}`;
      const globs = applyToOf(read(join(root, p)) ?? "");
      for (const f of paths) if (!globs.length || globs.some((g) => globMatches(g, f))) add(p, "instructions", f);
    }
  }
  for (const g of guidelinesSettings(team).files) {
    const p = norm(g);
    if (existsSync(join(root, p))) for (const f of paths) add(p, "team.yaml", f);
  }
  const seen = new Set<string>();
  const rules: GuidelineRule[] = [];
  for (const s of sources.values()) {
    for (const r of rulesOf(read(join(root, s.path)) ?? "", s.path)) {
      const key = r.text.toLowerCase().replace(/[`*_]/g, "").replace(/[\s.;:]+$/g, "").replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push(r);
    }
  }
  return { paths, sources: [...sources.values()], rules };
}

/** The compact text: per source the files it applies to (when not all) and its rules. */
export function formatGuidelines(r: GuidelinesResult): string {
  if (!r.sources.length) return `No guidelines found for ${r.paths.join(", ")}.`;
  const lines = [`Guidelines for ${r.paths.length} file(s); on a conflict the nearest AGENTS.md wins.`];
  for (const s of r.sources) {
    const own = r.rules.filter((x) => x.source.startsWith(`${s.path}:`));
    if (!own.length) continue;
    const scope = s.appliesTo.length === r.paths.length ? "" : ` (for ${s.appliesTo.join(", ")})`;
    lines.push(`[${s.path}]${scope}`);
    for (const x of own) lines.push(`- ${x.text} (${x.source.slice(s.path.length + 1)})`);
  }
  return lines.join("\n");
}

export function guidelinesShow(ctx: Ctx, o: { paths: string[]; json?: boolean }): string {
  if (!o.paths.length) throw new AihubError("usage: aihub guidelines show --paths <file>[,<file>...] [--json]");
  const root = repoRoot(ctx.cwd);
  const paths = [...new Set(o.paths.map((p) => toRepoPath(root, ctx.cwd, p)))];
  const r = collectGuidelines(root, paths);
  return o.json ? JSON.stringify(r) : formatGuidelines(r);
}

// ---- check: the changed files and lines of the branch, the rules for them, and the team's linters ----

export interface Finding {
  source: string;
  file: string;
  line?: number;
  message: string;
}

/** Added line numbers per file from `git diff -U0` output. */
export function addedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file = "";
  for (const l of diff.split("\n")) {
    const f = /^\+\+\+ b\/(.+)$/.exec(l);
    if (f) {
      file = f[1];
      if (!out.has(file)) out.set(file, new Set());
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h && file) {
      const start = Number(h[1]);
      const n = h[2] === undefined ? 1 : Number(h[2]);
      for (let i = 0; i < n; i++) out.get(file)!.add(start + i);
    }
  }
  return out;
}

/** Findings from linter output: "file:line[:col]: message", and sqlfluff's "== [file] FAIL" + "L:  3 | P:  1 | CODE | message". */
export function parseLinterOutput(name: string, out: string, root: string): Finding[] {
  const found: Finding[] = [];
  let current = "";
  for (const raw of out.replace(/\r\n/g, "\n").split("\n")) {
    const l = raw.trimEnd();
    const head = /^== \[(.+?)\] (?:FAIL|PASS)/.exec(l);
    if (head) {
      current = head[1];
      continue;
    }
    const sq = /^L:\s*(\d+)\s*\|\s*P:\s*\d+\s*\|\s*(\S+)\s*\|\s*(.*)$/.exec(l.trim());
    if (sq && current) {
      found.push({ source: name, file: current, line: Number(sq[1]), message: `${sq[2]} ${sq[3]}`.trim() });
      continue;
    }
    const m = /^(.+?):(\d+)(?::\d+)?:\s*(.+)$/.exec(l);
    if (m && !/^\s/.test(l)) found.push({ source: name, file: m[1], line: Number(m[2]), message: m[3] });
  }
  return found.map((f) => {
    const rel = relative(root, resolve(root, f.file)).split(sep).join("/");
    return { ...f, file: rel.startsWith("..") ? norm(f.file) : rel };
  });
}

const quote = (s: string) => (/^[\w./:@-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

export interface CheckResult {
  base: string;
  baseReason: string;
  files: string[];
  findings: Finding[];
  /** linters that could not run (not installed, failed to start) */
  skipped: { name: string; why: string }[];
  rules: GuidelineRule[];
}

export async function guidelinesCheck(ctx: Ctx, o: { base?: string; json?: boolean }): Promise<{ text: string; code: number }> {
  const root = repoRoot(ctx.cwd);
  const branch = (() => {
    try {
      return currentBranch(root);
    } catch {
      return "";
    }
  })();
  const { target, reason } = o.base ? { target: o.base, reason: "given with --base" } : await chooseTarget(ctx, root, branch);
  const ref = hasRef(root, `origin/${target}`) ? `origin/${target}` : hasRef(root, target) ? target : "";
  if (!ref) throw new AihubError(`base '${target}' not found (fetch it, or pass --base <branch>)`);
  const mb = git(root, ["merge-base", ref, "HEAD"], { allowFail: true }).trim() || ref;
  // committed and uncommitted changes against the branch point, plus new files git does not track yet
  const changed = git(root, ["diff", "--name-only", "--diff-filter=ACMR", mb], { allowFail: true }).split("\n").map((s) => s.trim()).filter(Boolean);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"], { allowFail: true }).split("\n").map((s) => s.trim()).filter(Boolean);
  const files = [...new Set([...changed, ...untracked])].sort();
  const lines = addedLines(git(root, ["diff", "-U0", "--diff-filter=ACMR", mb], { allowFail: true }));
  const isNew = new Set(untracked);
  const onChanged = (f: Finding) => !f.line || isNew.has(f.file) || lines.get(f.file)?.has(f.line) === true;
  const team = loadTeam(root);
  const findings: Finding[] = [];
  const skipped: CheckResult["skipped"] = [];
  for (const l of guidelinesSettings(team).linters) {
    const mine = files.filter((f) => l.files.some((g) => globMatches(g, f)) && existsSync(join(root, f)));
    if (!mine.length) continue;
    const cmd = l.command.includes("{files}") ? l.command.replace("{files}", mine.map(quote).join(" ")) : `${l.command} ${mine.map(quote).join(" ")}`;
    const r = spawnSync(cmd, { cwd: root, shell: true, encoding: "utf8", timeout: 120_000, windowsHide: true });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    // 127: the shell did not find the command; Windows says it in words; a Python linter that is missing says No module named
    if (r.error || r.status === 127 || /not recognized as an internal or external command|command not found|No module named/i.test(out)) {
      skipped.push({ name: l.name, why: r.error ? r.error.message : "not installed" });
      continue;
    }
    findings.push(...parseLinterOutput(l.name, out, root).filter((f) => mine.includes(f.file)).filter(onChanged));
  }
  const rules = files.length ? collectGuidelines(root, files, team).rules : [];
  const res: CheckResult = { base: target, baseReason: reason, files, findings, skipped, rules };
  const code = findings.length ? 1 : 0;
  if (o.json) return { text: JSON.stringify(res), code };
  const out: string[] = [`${files.length} changed file(s) against ${target} (${reason}).`];
  if (findings.length) {
    out.push(`${findings.length} violation(s) on changed lines:`);
    for (const f of findings) out.push(`- ${f.source}: ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`);
  } else out.push("No linter violations on the changed lines.");
  for (const s of skipped) out.push(`skipped ${s.name}: ${s.why}`);
  if (rules.length) {
    out.push("Check the changed lines against these rules yourself:");
    for (const r of rules) out.push(`- ${r.text} (${r.source})`);
  }
  return { text: out.join("\n"), code };
}

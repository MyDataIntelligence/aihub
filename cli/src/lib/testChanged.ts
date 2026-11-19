import { spawnSync } from "./proc.js";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { git, mergeBase, originDefaultBranch, repoRoot } from "./git.js";
import { anyGlob } from "./glob.js";
import { dbtPlans, type DbtPlan, type DbtTestsConfig } from "./dbt-changed.js";
import { defaultTargetFor, loadTeam } from "./team.js";

/**
 * `aihub test changed`: the tests that belong to what this branch changed, so the agent never runs the whole suite
 * locally (the pipeline does that). The team decides in team.yaml (`tests.command`, `tests.map`); without it the
 * defaults know Python (`test_<module>.py`, `<module>_test.py`, tests that import the module) and JS/TS
 * (`<name>.test.ts`, `<name>.spec.ts`, tests that import the file).
 */
export interface TestsConfig {
  /** command template; {tests} becomes the quoted test files, e.g. "pytest {tests}" */
  command?: string;
  /** explicit rules: changed files matching `source` run the tests matching `tests` */
  map?: { source: string | string[]; tests: string | string[] }[];
  /** dbt projects: how the changed models are tested (see DbtTestsConfig) */
  dbt?: DbtTestsConfig;
}

export interface TestPlan {
  base: string;
  baseRef: string;
  changed: string[];
  tests: { file: string; for: string[] }[];
  /** changed code files that no test maps to */
  unmapped: string[];
  commands: string[];
  /** dbt projects this branch changes: the models to build and test */
  dbt: DbtPlan[];
}

const PY_TEST = /(^|\/)(test_[^/]+|[^/]+_test)\.py$/i;
const JS_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const isTest = (p: string): boolean => PY_TEST.test(p) || JS_TEST.test(p) || /(^|\/)__tests__\//.test(p);
const CODE = /\.(py|[cm]?[jt]sx?)$/i;
const arr = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);

const stem = (p: string): string => {
  const b = basename(p, extname(p));
  return /^__init__$|^index$/i.test(b) ? basename(join(p, "..")) : b;
};

function readSome(root: string, rel: string): string {
  try {
    return readFileSync(join(root, rel), "utf8").slice(0, 200_000);
  } catch {
    return "";
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does this test file import the changed module? (`import a.b.mod`, `from a.b import mod`, `from "./mod"`.) */
function importsModule(text: string, changed: string): boolean {
  const m = esc(stem(changed));
  if (/\.py$/i.test(changed)) return new RegExp(`(^|\\n)\\s*(from\\s+[\\w.]*\\b${m}\\b[\\w.]*\\s+import|import\\s+[\\w.]*\\b${m}\\b|from\\s+[\\w.]+\\s+import\\s+[^\\n]*\\b${m}\\b)`).test(text);
  return new RegExp(`(from|require\\(|import\\()\\s*['"][^'"]*[/.]${m}(\\.[cm]?[jt]sx?)?['"]`).test(text);
}

export function planTests(
  root: string,
  changedFiles: string[],
  allFiles: string[],
  cfg: TestsConfig,
  read: (rel: string) => string = (rel) => readSome(root, rel),
): { tests: TestPlan["tests"]; unmapped: string[]; commands: string[] } {
  const testFiles = allFiles.filter(isTest);
  const found = new Map<string, Set<string>>();
  const add = (t: string, forFile: string) => found.set(t, (found.get(t) ?? new Set()).add(forFile));
  const unmapped: string[] = [];
  for (const f of changedFiles) {
    let any = false;
    for (const rule of cfg.map ?? []) {
      if (!anyGlob(arr(rule.source), f)) continue;
      for (const t of allFiles.filter((x) => anyGlob(arr(rule.tests), x))) (add(t, f), (any = true));
    }
    if (isTest(f)) (add(f, f), (any = true));
    else if (CODE.test(f)) {
      const s = stem(f);
      const isPy = /\.py$/i.test(f);
      const names = isPy ? [`test_${s}.py`, `${s}_test.py`] : [`${s}.test`, `${s}.spec`];
      for (const t of testFiles) {
        if (/\.py$/i.test(t) !== isPy) continue; // Python code is tested by Python tests, JS/TS by JS/TS tests
        const bn = basename(t).toLowerCase();
        const byName = isPy ? names.some((n) => bn === n.toLowerCase()) : names.some((n) => bn.startsWith(n.toLowerCase() + "."));
        if (byName || importsModule(read(t), f)) (add(t, f), (any = true));
      }
    } else continue; // docs, config: no test belongs to them
    if (!any) unmapped.push(f);
  }
  const tests = [...found].map(([file, forSet]) => ({ file, for: [...forSet].sort() })).sort((a, b) => a.file.localeCompare(b.file));
  return { tests, unmapped, commands: commandsFor(tests.map((t) => t.file), cfg.command) };
}

const q = (p: string) => (/[\s"']/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);

export function commandsFor(files: string[], template?: string): string[] {
  if (!files.length) return [];
  if (template) return [template.replace(/\{tests\}/g, files.map(q).join(" "))];
  const py = files.filter((f) => /\.py$/i.test(f));
  const js = files.filter((f) => !/\.py$/i.test(f));
  return [...(py.length ? [`python -m pytest ${py.map(q).join(" ")}`] : []), ...(js.length ? [`npx vitest run ${js.map(q).join(" ")}`] : [])];
}

/** Committed since the merge base, plus uncommitted and untracked, minus deleted files. */
export function changedFiles(root: string, base: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => s.split("\n").filter(Boolean).forEach((f) => out.add(f.replace(/\\/g, "/")));
  if (base) add(git(root, ["diff", "--name-only", base], { allowFail: true }));
  add(git(root, ["ls-files", "--others", "--exclude-standard"], { allowFail: true }));
  return [...out].filter((f) => existsSync(join(root, f))).sort();
}

export interface TestChangedOpts {
  base?: string;
  run?: boolean;
  json?: boolean;
}

/** The branch this work targets and its merge base: --base, the team's default target for the repository, origin's default branch. */
export function resolveBase(ctx: Ctx, root: string, baseArg?: string): { target: string; base: string; team: ReturnType<typeof loadTeam> } {
  const team = loadTeam(root);
  let repoName = "";
  try {
    repoName = repoClient(ctx).client.remote.repo;
  } catch {
    /* no Azure DevOps remote: the target comes from origin's default branch */
  }
  const target = baseArg ?? (repoName ? defaultTargetFor(team, repoName) : undefined) ?? (originDefaultBranch(root) || "main");
  const base = mergeBase(root, target);
  if (!base) throw new AihubError(`no merge base with '${target}' (git fetch, or pass --base <branch>)`);
  return { target, base, team };
}

export function testChanged(ctx: Ctx, o: TestChangedOpts, runner: (cmd: string, cwd: string) => number = defaultRunner): string {
  const root = repoRoot(ctx.cwd);
  const { target, base, team } = resolveBase(ctx, root, o.base);
  const cfg = ((team as { tests?: TestsConfig }).tests ?? {}) as TestsConfig;
  const changed = changedFiles(root, base);
  const all = git(root, ["ls-files", "--cached", "--others", "--exclude-standard"], { allowFail: true })
    .split("\n")
    .filter(Boolean)
    .map((f) => f.replace(/\\/g, "/"));
  const plan = planTests(root, changed, all, cfg);
  const dbt = dbtPlans(ctx, root, changed, base, target, cfg.dbt ?? {});
  const result: TestPlan = { base: base.slice(0, 7), baseRef: target, changed, ...plan, dbt };

  const lines: string[] = [];
  if (!o.json) {
    lines.push(`changed vs ${target} (merge base ${result.base}): ${changed.length} file(s)`);
    if (plan.tests.length) {
      lines.push(`tests to run (${plan.tests.length}):`, ...plan.tests.map((t) => `  ${t.file}  (for ${t.for.join(", ")})`));
      lines.push(...plan.commands.map((c) => `command: ${c}`));
    } else if (!dbt.length) lines.push("no tests map to the changed files: run nothing locally, the pipeline runs the full suite");
    for (const d of dbt) {
      lines.push(`dbt project ${d.project} (${d.route === "other" ? "local adapter" : `Fabric ${d.route}`}): ${d.changed.length} changed node(s), ${d.downstream} downstream model(s)`);
      if (d.command) lines.push(`command: ${d.command}`);
      lines.push(...d.notes.map((n) => `  note: ${n}`));
    }
    if (plan.unmapped.length) lines.push(`no test found for: ${plan.unmapped.join(", ")} (add tests.map in team.yaml, or write the test)`);
  }
  const runnable = [...plan.commands, ...dbt.filter((d) => d.command && !d.needsWorkspace).map((d) => d.command!)];
  if (o.run && runnable.length) {
    for (const c of runnable) {
      if (!o.json) lines.push(`running: ${c}`);
      const code = runner(c, root);
      if (code !== 0) {
        if (!o.json) for (const l of lines) ctx.out(l);
        throw new AihubError(`tests failed (exit ${code}): ${c}`);
      }
    }
    if (!o.json) lines.push("changed tests passed");
  }
  return o.json ? JSON.stringify({ ...result, ran: !!o.run && runnable.length > 0 }) : lines.join("\n");
}

function defaultRunner(cmd: string, cwd: string): number {
  return spawnSync(cmd, { cwd, shell: true, stdio: "inherit" }).status ?? 1;
}

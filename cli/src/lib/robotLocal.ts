import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { AihubError } from "./errors.js";
import type { TeamConfig } from "./team.js";

/**
 * A local Robot Framework run (the "Run Robot Test" button): the team's runner script (team.yaml `robot.runner`, else
 * an `rf-run.py` in the repository; it handles sign-in, environment and the results folder itself) run from its own
 * folder with the repository's virtual environment, or `python -m robot` with an own output folder. Environments are
 * only those team.yaml names under `robot.environments` (environment variables per test environment); nothing else.
 */

export interface RobotTestCase {
  name: string;
  /** 1-based line of the test case name */
  line: number;
}

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "test_results", "results", "__pycache__", ".tox", "dist", "build"]);

/** The test cases of a .robot file (the `*** Test Cases ***` section): name and line; keywords and comments are not tests. */
export function parseRobotTests(text: string): RobotTestCase[] {
  const out: RobotTestCase[] = [];
  let inTests = false;
  text.split(/\r?\n/).forEach((l, i) => {
    const section = /^\*{3}\s*(.+?)\s*\*{3}/.exec(l);
    if (section) {
      inTests = /^(test cases?|tasks?)$/i.test(section[1]);
      return;
    }
    if (!inTests || !l.trim() || /^\s/.test(l) || l.startsWith("#") || l.startsWith("...")) return;
    out.push({ name: l.split(/\s{2,}|\t/)[0].trim(), line: i + 1 });
  });
  return out;
}

type RobotTeam = { runner?: string; environments?: Record<string, Record<string, string>> };
const robotOf = (team: TeamConfig) => ((team as { robot?: RobotTeam }).robot ?? {}) as RobotTeam;

function walk(dir: string, depth: number, match: (name: string) => boolean, out: string[] = []): string[] {
  if (depth < 0) return out;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), depth - 1, match, out);
    } else if (e.isFile() && match(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

/** The team's runner script: team.yaml robot.runner, else the first rf-run.py in the repository (5 levels deep). */
export function findRunner(root: string, team: TeamConfig): { script: string; cwd: string } | undefined {
  const configured = robotOf(team).runner;
  if (configured) {
    const p = resolve(root, configured);
    if (!existsSync(p)) throw new AihubError(`team.yaml robot.runner ${configured} does not exist`);
    return { script: p, cwd: dirname(p) };
  }
  const found = walk(root, 5, (n) => n === "rf-run.py").sort((a, b) => a.length - b.length)[0];
  return found ? { script: found, cwd: dirname(found) } : undefined;
}

/** The .robot suites with their test cases. */
export function findSuites(root: string): { file: string; rel: string; tests: RobotTestCase[] }[] {
  return walk(root, 7, (n) => n.endsWith(".robot"))
    .sort()
    .map((file) => ({ file, rel: relative(root, file).replace(/\\/g, "/"), tests: parseRobotTests(readFileSync(file, "utf8")) }));
}

/** The repository's Python: a .venv/venv interpreter when there is one, else python (python3 outside Windows). */
export function pythonOf(root: string, platform: NodeJS.Platform = process.platform): string {
  for (const v of [".venv", "venv", "env"]) {
    const p = platform === "win32" ? join(root, v, "Scripts", "python.exe") : join(root, v, "bin", "python");
    if (existsSync(p)) return p;
  }
  return platform === "win32" ? "python" : "python3";
}

export interface LocalCommand {
  cwd: string;
  exe: string;
  args: string[];
  /** extra environment variables (the chosen test environment) */
  env: Record<string, string>;
  /** set when aihub chose the output folder (python -m robot) */
  outputDir?: string;
  runner?: string;
}

export function environmentsOf(team: TeamConfig): string[] {
  return Object.keys(robotOf(team).environments ?? {});
}

/** The command for one suite, one test or everything; `env` must be one of team.yaml robot.environments. */
export function localCommand(root: string, team: TeamConfig, o: { file?: string; test?: string; env?: string }, platform: NodeJS.Platform = process.platform, now = Date.now()): LocalCommand {
  const envs = robotOf(team).environments ?? {};
  const names = Object.keys(envs);
  if (o.env && !envs[o.env]) throw new AihubError(`${o.env} is not a test environment of this repository; team.yaml robot.environments: ${names.join(", ") || "none"}`);
  const env = { ...(o.env ? envs[o.env] : names.length ? envs[names[0]] : {}) };
  const runner = findRunner(root, team);
  const python = pythonOf(root, platform);
  const cwd = runner?.cwd ?? root;
  const select = [...(o.test ? ["--test", o.test] : []), ...(o.file ? [relative(cwd, resolve(o.file))] : runner ? [] : ["."])];
  if (runner) return { cwd, exe: python, args: [relative(cwd, runner.script), ...select], env, runner: runner.script };
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const outputDir = join(root, "test_results", stamp);
  return { cwd, exe: python, args: ["-m", "robot", "--outputdir", outputDir, ...select], env, outputDir };
}

export interface RobotResult {
  status: "PASS" | "FAIL";
  pass: number;
  fail: number;
  skip: number;
  failed: { name: string; message: string }[];
  output: string;
  log?: string;
  report?: string;
}

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The newest output.xml below `dir` written after `since` (epoch ms): counts, the failing tests, log.html and report.html next to it. */
export function readResult(dir: string, since: number): RobotResult | undefined {
  const outputs = walkResults(dir).filter((f) => statSync(f).mtimeMs >= since);
  const output = outputs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!output) return undefined;
  const xml = readFileSync(output, "utf8");
  const total = /<total>\s*<stat\s+pass="(\d+)"\s+fail="(\d+)"(?:\s+skip="(\d+)")?[^>]*>/.exec(xml);
  const failed: RobotResult["failed"] = [];
  for (const m of xml.matchAll(/<test\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/test>/g)) {
    const statuses = [...m[2].matchAll(/<status\s+status="(\w+)"[^>]*?(?:\/>|>([\s\S]*?)<\/status>)/g)];
    const last = statuses[statuses.length - 1];
    if (last?.[1] === "FAIL") failed.push({ name: unxml(m[1]), message: unxml((last[2] ?? "").trim()).slice(0, 300) });
  }
  const pass = Number(total?.[1] ?? 0);
  const fail = Number(total?.[2] ?? failed.length);
  const near = (n: string) => (existsSync(join(dirname(output), n)) ? join(dirname(output), n) : undefined);
  return { status: fail ? "FAIL" : "PASS", pass, fail, skip: Number(total?.[3] ?? 0), failed, output, log: near("log.html"), report: near("report.html") };
}

function walkResults(dir: string, depth = 7, out: string[] = []): string[] {
  if (depth < 0) return out;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== ".git" && e.name !== "node_modules" && e.name !== ".venv") walkResults(join(dir, e.name), depth - 1, out);
    else if (e.isFile() && e.name === "output.xml") out.push(join(dir, e.name));
  }
  return out;
}

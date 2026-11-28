import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { Ctx } from "../context.js";
import { guidelinesCheck, type CheckResult } from "../guidelines.js";
import { spawnSync } from "../proc.js";
import { testChanged } from "../testChanged.js";
import { loadTeam, TEAM_FILE } from "../team.js";
import { BrowseError, type Browse } from "./core.js";
import { changeApply, changeDiff, readMeta } from "./change.js";
import { repoRowOf } from "./read.js";

/**
 * Change with Agent: lint and test a remote change in a temporary copy. A shallow, blob-less copy of the base commit in the
 * temp folder (never inside a repository); for lint only the folders of the changed files are checked out (sparse, with the
 * root files, team.yaml and the instruction files), for tests the whole tree. The overlay of the change goes on top, then
 * `aihub guidelines check` (the team's linters, on the changed lines) and with --tests the tests of the changed files
 * (`aihub test changed --run`, the test command of team.yaml). The copy is always removed; nothing is pushed. Git signs in
 * as usual (Git Credential Manager, never a prompt).
 */

export interface VerifyError {
  path: string;
  line?: number;
  message: string;
}

export interface VerifyCheck {
  name: string;
  kind: "lint" | "test";
  /** couldNotRun: the tests could not even start in the copy (a module or package that is not there): not a failure of the change */
  status: "passed" | "failed" | "skipped" | "couldNotRun";
  /** couldNotRun: the modules that were missing */
  missing?: string[];
  errors: VerifyError[];
  tookMs: number;
  command?: string;
  reason?: string;
}

export interface VerifyResult {
  id: string;
  ok: boolean;
  base: { branch: string; commit: string };
  files: string[];
  checks: VerifyCheck[];
  tookMs: number;
  copyRemoved: boolean;
  at: string;
  /** what the result cannot say (the base branch moved on, ...) */
  notes: string[];
}

export type VerifyStep = "clone" | "checkout" | "apply" | "lint" | "test" | "cleanup";
export type Progress = (e: { id: string; step: VerifyStep; n: number; total: number; message: string }) => void;

const MAX_ERRORS = 20;
const QUIET = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...env, ...QUIET }, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    const why = (r.stderr ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => /^(fatal|error):/i.test(l)) ?? (r.stderr ?? "").trim().split(/\r?\n/)[0] ?? "";
    throw new BrowseError(/Authentication|could not read Username|terminal prompts disabled|credential/i.test(r.stderr ?? "") ? "signedOut" : "failed", `git ${args[0]} failed: ${why.replace(/^fatal:\s*/i, "")}`);
  }
  return r.stdout ?? "";
}

/** The folders the lint copy needs: those of the changed files, plus where team.yaml and the instructions live (root files come with cone mode). */
export function sparseFolders(files: string[]): string[] {
  const dirs = new Set<string>([dirname(TEAM_FILE).replace(/\\/g, "/"), ".github/instructions"]);
  for (const f of files) {
    const d = dirname(f.replace(/^\//, ""));
    if (d && d !== ".") dirs.add(d);
  }
  return [...dirs].sort();
}

/** Removes a folder that git wrote (read-only packs on Windows), a few times while something still holds a file. */
export function removeCopy(dir: string): boolean {
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* a file still in use: try again */
    }
    if (!existsSync(dir)) return true;
    const until = Date.now() + 300;
    while (Date.now() < until) {
      /* a short wait without a timer: the CLI is about to end */
    }
  }
  return !existsSync(dir);
}

/** Lint findings as errors per file (at most 20). */
export function lintChecks(r: CheckResult, tookMs: number, command: string): VerifyCheck[] {
  const out: VerifyCheck[] = r.skipped.map((s) => ({ name: s.name, kind: "lint" as const, status: "skipped" as const, errors: [], tookMs: 0, reason: s.why }));
  const by = new Map<string, VerifyError[]>();
  for (const f of r.findings) by.set(f.source, [...(by.get(f.source) ?? []), { path: `/${f.file.replace(/^\//, "")}`, ...(f.line ? { line: f.line } : {}), message: f.message }]);
  for (const [name, errors] of by) out.push({ name, kind: "lint", status: "failed", errors: errors.slice(0, MAX_ERRORS), tookMs, command });
  if (!by.size && !out.length) out.push({ name: "guidelines", kind: "lint", status: r.files.length ? "passed" : "skipped", errors: [], tookMs, command, ...(r.files.length ? {} : { reason: "no changed files to lint" }) });
  else if (!by.size) out.push({ name: "guidelines", kind: "lint", status: "passed", errors: [], tookMs, command });
  return out;
}

/**
 * Tests that could not start: an import that fails while the tests are collected (pytest "error during collection", "No module
 * named X", exit 4 or 5), a Robot library or resource that cannot be imported, or a missing tool. Returns the missing modules (may
 * be empty) and the reason, or undefined when the tests did run (a real assertion failure always stays a failure).
 */
export function couldNotRun(output: string, exitCode: number, command = ""): { missing: string[]; reason: string } | undefined {
  if (/^FAILED |AssertionError|\b\d+ failed\b/m.test(output)) return undefined;
  const missing = [
    ...new Set(
      [
        ...output.matchAll(/(?:No module named|Cannot find module) ['"]?([\w.@/-]+)['"]?/g),
        ...output.matchAll(/Importing (?:test )?library '([^']+)' failed/g),
        ...output.matchAll(/Resource file '([^']+)' does not exist/g),
      ].map((m) => m[1]),
    ),
  ];
  const pytest = /pytest/.test(command) || /test session starts/.test(output);
  if (missing.length) return { missing, reason: `missing dependency ${missing.join(", ")}` };
  if (/errors? during collection|ImportError while importing test module|Error in file .* Importing/i.test(output) || (pytest && exitCode === 4)) return { missing, reason: "the tests could not be collected (see the first lines)" };
  if (pytest && exitCode === 5) return { missing, reason: "no tests were collected" };
  if (/is not recognized as an internal or external command|command not found/i.test(output)) return { missing, reason: "the test tool is not installed" };
  return undefined;
}

/** The first failure lines of a test run: `path:line: message` where there is one, else the last lines. */
export function testErrors(output: string): VerifyError[] {
  const lines = output.replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const at = lines
    .map((l) => /^(?:FAILED |ERROR )?([\w./\\-]+\.\w+)(?::(\d+))?(?:::[\w:[\]-]+)?[: ]+(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && /fail|error|assert/i.test(m[0]))
    .map((m) => ({ path: `/${m[1].replace(/\\/g, "/").replace(/^\.?\//, "")}`, ...(m[2] ? { line: Number(m[2]) } : {}), message: m[3].replace(/^-\s*/, "").slice(0, 300) }));
  if (at.length) return at.slice(0, MAX_ERRORS);
  return lines.slice(-5).map((l) => ({ path: "", message: l.slice(0, 300) }));
}

export async function changeVerify(b: Browse, id: string, o: { lint?: boolean; tests?: boolean; progress?: Progress } = {}): Promise<VerifyResult> {
  const lint = o.lint !== false;
  const tests = !!o.tests;
  if (!lint && !tests) throw new BrowseError("badInput", "nothing to check: --lint and/or --tests");
  const { dir, meta } = readMeta(b.env, id);
  const d = await changeDiff(b, id);
  if (!d.files.length) throw new BrowseError("badInput", "nothing changed in this change; there is nothing to check");
  const row = await repoRowOf(b, meta.project, meta.repo);
  if (!row.remoteUrl) throw new BrowseError("notFound", `no clone url for ${meta.repo}`);
  const steps: VerifyStep[] = ["clone", "checkout", "apply", ...(lint ? (["lint"] as const) : []), ...(tests ? (["test"] as const) : []), "cleanup"];
  let n = 0;
  const say = (step: VerifyStep, message: string) => o.progress?.({ id, step, n: ++n, total: steps.length, message });
  const t0 = Date.now();
  const copy = mkdtempSync(join(tmpdir(), "aihub-verify-"));
  const checks: VerifyCheck[] = [];
  const notes: string[] = [];
  const files = d.files.map((f) => f.path);
  let removed = false;
  try {
    const env = b.env;
    // a copy of the base commit only: no history, no file contents until they are checked out
    say("clone", `copying ${meta.repo} at ${meta.base.commit.slice(0, 7)} (shallow, without file contents)`);
    rmSync(copy, { recursive: true, force: true }); // git clone wants to make the folder itself
    git(tmpdir(), ["clone", "-q", "--depth", "1", "--filter=blob:none", "--no-checkout", "--branch", meta.base.branch, row.remoteUrl, copy], env);
    // the branch may have moved on since the change started: then the base commit itself (one more shallow fetch)
    let at = "HEAD";
    let baseNote = "";
    if (git(copy, ["rev-parse", "HEAD"], env).trim() !== meta.base.commit) {
      try {
        git(copy, ["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", meta.base.commit], env);
        at = meta.base.commit;
      } catch {
        baseNote = `${meta.base.branch} has moved on and the server does not hand out ${meta.base.commit.slice(0, 7)}: checked on the newest ${meta.base.branch}`;
      }
    }
    say("checkout", tests ? "checking out the whole tree (tests)" : "checking out the folders of the changed files");
    if (!tests) git(copy, ["sparse-checkout", "set", "--cone", ...sparseFolders(files)], env);
    git(copy, ["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", at], env);
    // guidelines check and test changed compare with origin/<base branch>: it points at the commit the change starts from
    git(copy, ["update-ref", `refs/remotes/origin/${meta.base.branch}`, git(copy, ["rev-parse", "HEAD"], env).trim()], env);
    if (baseNote) notes.push(baseNote);
    say("apply", `applying ${files.length} changed file(s)`);
    const applied = await changeApply(b, id, copy);
    if (applied.skipped.length) throw new BrowseError("failed", `the change could not be applied to the copy: ${applied.skipped.map((s) => s.path).join(", ")}`);
    const ctx: Ctx = { ...b.ctx, cwd: copy, out: () => undefined, err: () => undefined };
    if (lint) {
      say("lint", "the team's linters on the changed lines");
      const t = Date.now();
      const r = JSON.parse((await guidelinesCheck(ctx, { base: meta.base.branch, json: true })).text) as CheckResult;
      checks.push(...lintChecks(r, Date.now() - t, "aihub guidelines check"));
    }
    if (tests) {
      say("test", "the tests of the changed files");
      const t = Date.now();
      const outputs: string[] = [];
      const commands: string[] = [];
      // modules of the repository itself are found from the root (and src/) of the copy; nothing is installed for the user
      const pyPath = [copy, ...(existsSync(join(copy, "src")) ? [join(copy, "src")] : []), ...(b.env.PYTHONPATH ? [b.env.PYTHONPATH] : [])].join(delimiter);
      const testEnv = { ...b.env, PYTHONPATH: pyPath, PYTHONDONTWRITEBYTECODE: "1" };
      const codes: number[] = [];
      const runner = (cmd: string, cwd: string) => {
        commands.push(cmd);
        const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024, env: testEnv });
        outputs.push(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
        codes.push(r.status ?? 1);
        return r.status ?? 1;
      };
      // team.yaml tests.setup: what the team says the tests need, run in the copy first (a venv, pip install -r requirements.txt)
      const setup = String((loadTeam(copy).tests ?? {}).setup ?? "").trim();
      if (setup) {
        const s = spawnSync(setup, { cwd: copy, shell: true, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024, env: testEnv });
        if (s.status !== 0) notes.push(`tests.setup failed (exit ${s.status ?? "?"}): ${`${s.stderr ?? ""}${s.stdout ?? ""}`.trim().split(/\r?\n/).pop() ?? ""}`);
      }
      try {
        const plan = JSON.parse(testChanged(ctx, { base: meta.base.branch, run: true, json: true }, runner)) as { ran?: boolean; tests?: unknown[] };
        checks.push(plan.ran ? { name: "tests", kind: "test", status: "passed", errors: [], tookMs: Date.now() - t, command: commands.join(" && ") } : { name: "tests", kind: "test", status: "skipped", errors: [], tookMs: Date.now() - t, reason: "no tests belong to the changed files (tests.map / tests.command in team.yaml)" });
      } catch (e) {
        const failedRun = /tests failed/.test((e as Error).message);
        const out = outputs.join("\n");
        const cnr = failedRun ? couldNotRun(out, codes[codes.length - 1] ?? 1, commands.join(" && ")) : undefined;
        if (cnr) {
          // no setup and a requirements file: say how the team makes the copy ready
          const hint = !setup && ["requirements.txt", "pyproject.toml"].some((f) => existsSync(join(copy, f))) ? " (tests.setup in team.yaml can install it, e.g. pip install -r requirements.txt)" : "";
          checks.push({ name: "tests", kind: "test", status: "couldNotRun", errors: testErrors(out).slice(0, 5), tookMs: Date.now() - t, command: commands.join(" && "), reason: cnr.reason + hint, ...(cnr.missing.length ? { missing: cnr.missing } : {}) });
        } else checks.push(failedRun ? { name: "tests", kind: "test", status: "failed", errors: testErrors(out), tookMs: Date.now() - t, command: commands.join(" && ") } : { name: "tests", kind: "test", status: "skipped", errors: [], tookMs: Date.now() - t, reason: (e as Error).message });
      }
    }
  } finally {
    say("cleanup", "removing the temporary copy");
    removed = removeCopy(copy);
  }
  const res: VerifyResult = { id, ok: checks.every((c) => c.status !== "failed"), base: meta.base, files, checks, tookMs: Date.now() - t0, copyRemoved: removed, at: new Date(b.now()).toISOString(), notes };
  writeFileSync(join(dir, "verify.json"), JSON.stringify(res, null, 2), "utf8");
  return res;
}

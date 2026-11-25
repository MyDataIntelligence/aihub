/**
 * A failed git hook in words a person can act on. Git only passes the hook's raw output through (a pre-commit framework table,
 * a linter dump, a test run); this picks out which check failed, its first lines, and which files the hook changed itself.
 * No team knowledge: the patterns are those of the tools (pre-commit, husky, lint-staged) and of ordinary error lines.
 */
export interface HookCheck {
  /** The check as the hook names it (pre-commit: the hook name; otherwise the stage, e.g. "pre-commit"). */
  name: string;
  /** pre-commit: the hook id, usable with `--skip-hooks`. */
  id?: string;
  exit?: number;
  /** The hook changed files itself (a formatter): a second attempt usually passes. */
  modifiedFiles: boolean;
  lines: string[];
}

export interface HookDigest {
  checks: HookCheck[];
  /** True when every failed check is a formatter that changed files and reported nothing else. */
  onlyFixers: boolean;
  /** The lines to show when no check table was recognised. */
  tail: string[];
}

const MAX_LINES_PER_CHECK = 6;
const MAX_TAIL = 12;
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
const ERROR_LINE = /(\berror\b|\bfailed\b|\bFAIL\b|✖|✗|\bE\d{3,4}\b|\b[A-Z]{1,4}\d{3,4}\b|^\S+?:\d+(:\d+)?[: ])/i;

/** Reads the output of a failed `git commit` or `git push` (stdout and stderr together). */
export function digestHookOutput(raw: string): HookDigest {
  const lines = stripAnsi(raw).replace(/\r/g, "").split("\n");
  const checks: HookCheck[] = [];
  let current: HookCheck | undefined;
  for (const line of lines) {
    // pre-commit framework: "ruff.....................................................Failed"
    const row = /^(.+?)\.{3,}\s*(?:\(.*?\)\s*)?(Failed|Passed|Skipped)\s*$/.exec(line);
    if (row) {
      current = undefined;
      if (row[2] === "Failed") {
        current = { name: row[1].trim(), modifiedFiles: false, lines: [] };
        checks.push(current);
      }
      continue;
    }
    if (!current) continue;
    const id = /^- hook id:\s*(\S+)/.exec(line);
    if (id) {
      current.id = id[1];
      continue;
    }
    const exit = /^- exit code:\s*(\d+)/.exec(line);
    if (exit) {
      current.exit = Number(exit[1]);
      continue;
    }
    if (/^- files were modified by this hook/.test(line)) {
      current.modifiedFiles = true;
      continue;
    }
    if (/^- duration:/.test(line)) continue;
    const text = line.trim();
    if (text && current.lines.length < MAX_LINES_PER_CHECK) current.lines.push(text);
  }
  // A formatter that only says "reformatted x" / "N files reformatted" / "Fixing x" reported no problem of its own.
  const noise = /^(reformatted\b|\d+ files? (reformatted|left unchanged|fixed)|fixing\b|fixed \d+|all done|oh no|would reformat\b|found \d+ errors? \(\d+ fixed, 0 remaining\))/i;
  const onlyFixers = checks.length > 0 && checks.every((c) => c.modifiedFiles && c.lines.every((l) => noise.test(l) || /^[✨🍰💥 ]+/u.test(l)));
  let tail: string[] = [];
  if (checks.length === 0) {
    const meaningful = lines.map((l) => l.trim()).filter((l) => l && !/^(husky - |hint: |error: failed to push some refs|To https?:|To git@)/i.test(l));
    const errors = meaningful.filter((l) => ERROR_LINE.test(l));
    tail = (errors.length ? errors : meaningful).slice(0, MAX_TAIL);
  }
  return { checks, onlyFixers, tail };
}

/** The readable message of a hook failure. `stage` is the hook that ran (pre-commit, commit-msg, pre-push). */
export function formatHookFailure(o: {
  what: "commit" | "push";
  stages: string[];
  digest: HookDigest;
  /** Files the hooks changed in the working tree during the attempt. */
  changedByHooks: string[];
  seconds: string;
  /** The command line to run again, without hook flags. */
  again: string;
  fullOutputFile?: string;
  /** Said first, e.g. "committed abc1234 on feature/x". */
  lead?: string;
}): string {
  const out: string[] = [];
  const stage = o.stages.length ? o.stages.join(", ") : o.what === "push" ? "pre-push" : "pre-commit";
  out.push(`${o.lead ? `${o.lead}; ` : ""}not ${o.what === "push" ? "pushed" : "committed"}: the ${stage} hook stopped it (${o.seconds})`);
  if (o.digest.checks.length) {
    out.push(`failed: ${o.digest.checks.map((c) => `${c.id ?? c.name}${c.exit !== undefined ? ` (exit ${c.exit})` : ""}${c.modifiedFiles ? " [changed files itself]" : ""}`).join(", ")}`);
    for (const c of o.digest.checks) for (const l of c.lines) out.push(`  ${c.id ?? c.name}: ${l}`);
  } else if (o.digest.tail.length) {
    out.push("what the hook said:");
    for (const l of o.digest.tail) out.push(`  ${l}`);
  } else out.push("the hook gave no output");
  if (o.changedByHooks.length) out.push(`changed by the hook itself: ${o.changedByHooks.slice(0, 8).join(", ")}${o.changedByHooks.length > 8 ? ` (+${o.changedByHooks.length - 8} more)` : ""}`);
  const ids = o.digest.checks.map((c) => c.id).filter(Boolean) as string[];
  out.push("choose:");
  out.push(`  fix the lines above, then run again: ${o.again}`);
  if (ids.length) out.push(`  skip only ${ids.length === 1 ? "this check" : "these checks"}: ${o.again} --skip-hooks ${ids.join(",")}`);
  out.push(`  skip all hooks this once: ${o.again} --no-verify`);
  if (o.fullOutputFile) out.push(`full output: ${o.fullOutputFile}`);
  return out.join("\n");
}

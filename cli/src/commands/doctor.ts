import { parseArgs } from "node:util";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { formatChecks, runChecks } from "../lib/doctor.js";
import { repoRoot } from "../lib/git.js";
import { decide, type Facts } from "../lib/perfAdvisor.js";
import { applyFinding, readApplied, undoApplied } from "../lib/perfApply.js";
import { gatherFacts } from "../lib/perfFacts.js";
import { findSet } from "../lib/setInfo.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  let v: { json?: boolean; perf?: boolean; paths?: string; apply?: string; undo?: string; elevate?: boolean; "dry-run"?: boolean };
  try {
    v = parseArgs({
      args: argv,
      options: { json: { type: "boolean" }, perf: { type: "boolean" }, paths: { type: "string" }, apply: { type: "string" }, undo: { type: "string" }, elevate: { type: "boolean" }, "dry-run": { type: "boolean" } },
    }).values;
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  if (v.perf || v.apply || v.undo) return perf(v, ctx);
  const checks = runChecks(ctx);
  if (v.json) {
    ctx.out(JSON.stringify({ ok: checks.every((c) => c.status === "OK"), checks }));
    return;
  }
  for (const l of formatChecks(checks)) ctx.out(l);
  const bad = checks.filter((c) => c.status === "FIX").length;
  ctx.out(bad ? `${bad} check(s) need a fix` : "all checks passed");
}

/** The repositories to check: --paths, else this repository and the other repositories of its worktree set. */
function roots(v: { paths?: string }, ctx: Ctx): string[] {
  if (v.paths) return v.paths.split(",").map((p) => p.trim()).filter(Boolean);
  try {
    const root = repoRoot(ctx.cwd);
    return [root, ...(findSet(root)?.repos.map((r) => r.path) ?? [])];
  } catch {
    return [];
  }
}

/**
 * aihub doctor --perf [--json] [--paths a,b]: what makes git, node and VS Code slow on this machine, with the evidence.
 * --apply <id> [--elevate] [--dry-run] applies one finding (administrator changes only with --elevate: one UAC prompt);
 * --undo <id> takes it back.
 */
async function perf(v: { json?: boolean; paths?: string; apply?: string; undo?: string; elevate?: boolean; "dry-run"?: boolean }, ctx: Ctx): Promise<void> {
  const opts = { elevate: !!v.elevate, dryRun: !!v["dry-run"] };
  if (v.undo) {
    for (const l of undoApplied(ctx.env, v.undo, opts)) ctx.out(l);
    return;
  }
  const measured: Facts = ctx.perfFacts ? ctx.perfFacts(roots(v, ctx)) : gatherFacts(ctx.env, roots(v, ctx));
  // live tests and demos only: AIHUB_TEST_PERF_FACTS='{"gitStartMs":240}' replaces measured numbers (never a path or a setting)
  const sim = ctx.env.AIHUB_TEST_PERF_FACTS ? (JSON.parse(ctx.env.AIHUB_TEST_PERF_FACTS) as Record<string, unknown>) : {};
  const facts: Facts = { ...measured, ...Object.fromEntries(Object.entries(sim).filter(([k, x]) => /^(nodeStartMs|gitStartMs|logGitMs|logCliStartMs)$/.test(k) && typeof x === "number")) };
  const findings = decide(facts);
  if (v.apply) {
    const f = findings.find((x) => x.id === v.apply);
    if (!f) throw new AihubError(`no finding ${v.apply} now; found: ${findings.map((x) => x.id).join(", ") || "none"}`);
    for (const l of applyFinding(ctx.env, f, opts)) ctx.out(l);
    return;
  }
  const applied = readApplied(ctx.env);
  if (v.json) {
    ctx.out(JSON.stringify({ facts: { ...facts, home: undefined }, findings, applied }));
    return;
  }
  const f = facts;
  ctx.out(`process starts: node ${f.nodeStartMs !== undefined ? Math.round(f.nodeStartMs) + " ms" : "?"}, git ${f.gitStartMs !== undefined ? Math.round(f.gitStartMs) + " ms" : "?"}${f.avProbe ? `; scan probe: 100 script files ${f.avProbe.scannedMs} ms, 100 data files ${f.avProbe.plainMs} ms` : ""}`);
  if (!findings.length) ctx.out("nothing found that slows git, node or VS Code down here");
  for (const x of findings) {
    ctx.out("");
    ctx.out(`${x.id} [${x.scope}]: ${x.title}`);
    for (const e of x.evidence) ctx.out(`  evidence: ${e}`);
    ctx.out(`  change: ${x.change}`);
    ctx.out(`  risk: ${x.risk}`);
    ctx.out(`  undo: ${x.undo}`);
    if (x.apply.length) ctx.out(`  apply: aihub doctor --perf --apply ${x.id}${x.scope === "admin" ? " --elevate" : ""}   (runs: ${x.apply.join("; ")})`);
    if (x.itRequest) ctx.out(`  managed by IT, request text:\n${x.itRequest.replace(/^/gm, "    ")}`);
  }
  if (applied.length) ctx.out(`\napplied before: ${applied.map((a) => `${a.id} (${a.at})`).join(", ")}; undo with aihub doctor --perf --undo <id>`);
}

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { impact, yamlCmd } from "./dbt-more.js";
import { SHOW_TARGET, failureReport, renderFailures } from "../lib/dbt-failures.js";
import { downstream, findNode, label, loadManifest, upstream, type Node } from "../lib/dbt-manifest.js";
import type { Version } from "../lib/dbt-run.js";
import { CAPACITY, CAPACITY_NOTE, VERBS, WRITE_VERBS, clean, dbtRunner, parseVersion, resolveProject, selectedTarget, selectorArgs } from "../lib/dbt-run.js";
import { findProfiles } from "../lib/fabric-dbt.js";
import { redact } from "../lib/fabric-redact.js";

export const DBT_USAGE =
  "aihub dbt detect|check [--project <dir>] [--json]\n" +
  "    Project, profile target and adapter, dbt and adapter versions, last run; check finds setup problems (literal secrets, missing adapter, Livy settings).\n" +
  "aihub dbt <build|run|test|compile|seed|snapshot|show|ls|deps|debug|parse|retry|freshness|docs> [--select <selector>] [--exclude <selector>] [--target <t>] [--state <dir>] [--defer] [--vars <yaml>] [--full-refresh] [--empty] [--threads <n>] [--fail-fast] [--limit <n>] [--inline <sql>] [--resource-type <t>] [--dry-run] [--json]\n" +
  "    Runs the local dbt CLI (project .venv first). Compact summary; failures listed. Writes to a Fabric adapter stay behind `aihub fabric dbt run --workspace`.\n" +
  "aihub dbt run-operation <macro> [--args <yaml>] [--dry-run]\n" +
  "aihub dbt failures [--rows <n>] [--max <n>] [--no-sample] [--json]\n" +
  "    The last run's failed tests and models: message, compiled SQL, first failing rows (via dbt show).\n" +
  "aihub dbt lineage <model|source|exposure> [--up] [--down] [--depth <n>] [--json]\n" +
  "    Upstream and downstream from target/manifest.json (parsed with dbt parse when it is stale).\n" +
  "";

const OPTS = {
  project: { type: "string" },
  target: { type: "string" },
  select: { type: "string", short: "s" },
  exclude: { type: "string" },
  state: { type: "string" },
  defer: { type: "boolean" },
  vars: { type: "string" },
  "full-refresh": { type: "boolean" },
  empty: { type: "boolean" },
  threads: { type: "string" },
  "fail-fast": { type: "boolean" },
  limit: { type: "string" },
  inline: { type: "string" },
  "resource-type": { type: "string" },
  args: { type: "string" },
  timeout: { type: "string" },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
  rows: { type: "string" },
  max: { type: "string" },
  "no-sample": { type: "boolean" },
  up: { type: "boolean" },
  down: { type: "boolean" },
  depth: { type: "string" },
  base: { type: "string" },
  write: { type: "boolean" },
  pr: { type: "string" },
  "unit-test": { type: "boolean" },
  columns: { type: "string" },
  strict: { type: "boolean" },
} as const;

type V = ReturnType<typeof parse<typeof OPTS>>["values"];

const int = (s: string | undefined, flag: string, def: number): number => {
  if (s === undefined) return def;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) throw new AihubError(`--${flag} must be a positive number`);
  return n;
};

const tail = (text: string, n: number): string => clean(text).split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-n).join("\n");

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "help") return void ctx.out(DBT_USAGE);
  const { values: v, positionals } = parse(rest, OPTS, true);
  const emit = (data: unknown, text: string) => ctx.out(v.json ? JSON.stringify(data) : text);
  if (sub === "detect") return detect(ctx, v, emit);
  if (sub === "check") return check(ctx, v, emit);
  if (sub === "failures") return failures(ctx, v, emit);
  if (sub === "lineage") return lineage(ctx, v, positionals[0], emit);
  if (sub === "impact") return impact(ctx, v, emit);
  if (sub === "yaml") return yamlCmd(ctx, v, positionals, emit);
  if (sub === "run-operation") {
    if (!positionals[0]) throw new AihubError("usage: aihub dbt run-operation <macro> [--args <yaml>]");
    return verb(ctx, "run-operation", v, emit, positionals[0]);
  }
  if (!VERBS.includes(sub)) throw new AihubError(`unknown dbt command '${sub}'.\n${DBT_USAGE}`);
  return verb(ctx, sub, v, emit);
}

type Emit = (data: unknown, text: string) => void;

// ---- the verbs ------------------------------------------------------------------------------------------------------

export function verbArgs(verb: string, v: V, macro?: string): string[] {
  const head = verb === "freshness" ? ["source", "freshness"] : verb === "docs" ? ["docs", "generate"] : [verb];
  const a = [...head];
  if (verb === "run-operation") a.push(macro!, ...(v.args ? ["--args", v.args] : []));
  const sel = selectorArgs(v.select, "select");
  const exc = selectorArgs(v.exclude, "exclude");
  const selectable = ["build", "run", "test", "compile", "seed", "snapshot", "show", "ls", "freshness"].includes(verb);
  if (selectable && sel.length) a.push("--select", ...sel);
  if (selectable && exc.length) a.push("--exclude", ...exc);
  for (const k of ["target", "state", "vars", "resource-type", "inline"] as const) {
    const val = v[k];
    if (val === undefined) continue;
    if (k === "inline" && !["show", "compile"].includes(verb)) throw new AihubError("--inline works with show and compile only");
    if (k === "resource-type" && verb !== "ls") throw new AihubError("--resource-type works with ls only");
    if (k !== "inline" && k !== "vars" && val.trim().startsWith("-")) throw new AihubError(`--${k} must not look like a flag`);
    a.push(`--${k}`, val);
  }
  if (v.defer) a.push("--defer");
  if (v["full-refresh"] && ["build", "run", "seed"].includes(verb)) a.push("--full-refresh");
  if (v.empty && ["build", "run", "compile"].includes(verb)) a.push("--empty");
  if (v["fail-fast"] && ["build", "run", "test", "seed"].includes(verb)) a.push("--fail-fast");
  if (v.threads) a.push("--threads", String(int(v.threads, "threads", 1)));
  if (v.limit && verb === "show") a.push("--limit", String(int(v.limit, "limit", 5)));
  if (verb === "show") a.push("--target-path", SHOW_TARGET);
  return a;
}

async function verb(ctx: Ctx, name: string, v: V, emit: Emit, macro?: string): Promise<void> {
  const p = resolveProject(ctx, v.project);
  const sel = selectedTarget(ctx, p, v.target);
  const args = verbArgs(name, v, macro);
  if ((WRITE_VERBS as readonly string[]).includes(name) && sel.route !== "other") {
    throw new AihubError(`dbt ${name} writes to a Fabric ${sel.route} (adapter ${sel.adapter}, target ${sel.target?.target}): use \`aihub fabric dbt run --workspace <workspace> --command ${name}\`, which checks the workspace first. Reads (test, show, compile, ls, parse, freshness) work here.`);
  }
  const runner = dbtRunner(ctx, p);
  if (v["dry-run"]) return emit({ dryRun: true, dir: p.info.path, command: `dbt ${args.join(" ")}` }, `would run in ${p.info.path}: dbt ${args.join(" ")}`);
  const resultsFile = join(p.dir, "target", "run_results.json");
  const before = existsSync(resultsFile) ? statSync(resultsFile).mtimeMs : 0;
  const r = runner.run(args, int(v.timeout, "timeout", 600) * 1000);
  const out = clean(r.stdout + (r.stderr ? `\n${r.stderr}` : ""));
  const fresh = existsSync(resultsFile) && statSync(resultsFile).mtimeMs > before;
  const rep = fresh && !["compile", "ls", "show", "parse", "debug", "deps", "docs"].includes(name) ? failureReport(p, undefined, { rows: 0, max: 0, sample: false }) : undefined;
  const ok = r.status === 0;
  const capacity = !ok && CAPACITY.test(out);
  if (v.json) {
    ctx.out(JSON.stringify({ command: `dbt ${args.join(" ")}`, ok, exit: r.status, counts: rep?.counts, failures: rep?.failures.map((f) => ({ name: f.name, kind: f.kind, status: f.status, file: f.file, message: f.message.split("\n")[0] })), ...(rep ? {} : { output: tail(out, 60) }), ...(capacity ? { capacityFull: true, hint: CAPACITY_NOTE } : {}) }));
  } else if (rep) {
    ctx.out(`dbt ${name} ${ok ? "succeeded" : `failed (exit ${r.status})`}: ${Object.entries(rep.counts).map(([k, n]) => `${n} ${k}`).join(", ")}`);
    for (const f of rep.failures.slice(0, 10)) ctx.out(`  ${f.status} ${f.kind} ${f.name}${f.file ? ` (${f.file})` : ""}: ${f.message.split("\n")[0].slice(0, 160)}`);
    if (rep.failures.length > 10) ctx.out(`  ... and ${rep.failures.length - 10} more`);
    if (rep.failures.length) ctx.out("details with compiled SQL and failing rows: aihub dbt failures");
  } else {
    const t = tail(out, name === "ls" ? 400 : name === "compile" || name === "show" ? 80 : 25);
    ctx.out(ok ? t || `dbt ${name} succeeded` : `dbt ${name} failed (exit ${r.status})\n${t}`);
  }
  if (capacity && !v.json) ctx.out(`note: ${CAPACITY_NOTE}`);
  if (!ok) throw new AihubError(`dbt ${name} failed (exit ${r.status})`);
}

// ---- detect and check -----------------------------------------------------------------------------------------------

function detect(ctx: Ctx, v: V, emit: Emit): void {
  const p = resolveProject(ctx, v.project);
  const runner = dbtRunner(ctx, p);
  const sel = selectedTarget(ctx, p, v.target);
  const prof = findProfiles(p.dir, ctx.env);
  let version: Version = { plugins: {}, raw: "dbt not found: install dbt in a project .venv (pip install dbt-core dbt-<adapter>)" };
  try {
    const r = runner.raw(["--version"]);
    if (r.status === 0) version = parseVersion(r.stdout + r.stderr);
  } catch {
    /* no dbt on PATH or in the venv */
  }
  let manifest: { dbtVersion: string; models: number; seeds: number; tests: number; sources: number; exposures: number; ageMinutes: number } | undefined;
  const mf = join(p.dir, "target", "manifest.json");
  if (existsSync(mf)) {
    try {
      const m = loadManifest(p, { ...runner, run: () => ({ status: 0, stdout: "", stderr: "" }) });
      const all = [...m.nodes.values()].filter((n) => n.package === p.info.name || n.kind === "source" || n.kind === "exposure");
      const n = (k: string) => all.filter((x) => x.kind === k).length;
      manifest = { dbtVersion: m.version, models: n("model"), seeds: n("seed"), tests: n("test"), sources: n("source"), exposures: n("exposure"), ageMinutes: Math.round((Date.now() - statSync(mf).mtimeMs) / 60000) };
    } catch {
      /* unreadable manifest: reported as absent */
    }
  }
  const results = failureReport(p, undefined, { rows: 0, max: 0, sample: false });
  const data = { project: p.info, dbt: { bin: runner.bin, core: version.core, plugins: version.plugins }, profiles: prof.file ?? null, target: sel.target ? { profile: sel.target.profile, target: sel.target.target, adapter: sel.target.adapter, route: sel.route, fields: sel.target.fields } : null, targets: prof.targets.map((t) => ({ profile: t.profile, target: t.target, adapter: t.adapter, isDefault: t.isDefault })), manifest: manifest ?? null, lastRun: results ? { command: results.command, counts: results.counts } : null };
  const plugins = Object.entries(version.plugins).map(([k, x]) => `${k} ${x}`).join(", ");
  emit(
    data,
    [
      `dbt project ${p.info.name} in ${p.info.path} (profile ${p.info.profile ?? "-"}, ${p.info.models} model file(s), ${p.info.dataTests} singular test file(s))`,
      `dbt: ${version.core ? `core ${version.core}${plugins ? `, ${plugins}` : ""}` : version.raw}${runner.bin !== "dbt" ? ` (${runner.bin})` : ""}`,
      `profiles: ${prof.file ?? "none found (project folder, DBT_PROFILES_DIR, ~/.dbt)"}`,
      ...prof.targets.filter((t) => t.profile === p.info.profile).map((t) => `  ${t.target}: ${t.adapter}${t.route !== "other" ? ` (Fabric ${t.route})` : ""}${t.isDefault ? " (default)" : ""}`),
      manifest ? `manifest: dbt ${manifest.dbtVersion}, ${manifest.models} model(s), ${manifest.seeds} seed(s), ${manifest.tests} test(s), ${manifest.sources} source(s), ${manifest.exposures} exposure(s), ${manifest.ageMinutes} min old` : "manifest: none (aihub dbt parse)",
      results ? `last run: dbt ${results.command ?? "?"}, ${Object.entries(results.counts).map(([k, n]) => `${n} ${k}`).join(", ")}` : "last run: none",
    ].join("\n"),
  );
}

interface Problem {
  level: "error" | "warn" | "info";
  where: string;
  what: string;
  fix: string;
}

const SECRET_KEY = /(password|secret|token|key|pwd|client_secret|credential)/i;
const SAFE_KEY = /^(authentication|key_file|keyfile)$/i;

/** Setup problems of one project, found without running dbt (the adapter check needs `dbt --version`). */
export function setupProblems(o: { projectDir: string; profile?: string; profilesFile?: string; plugins?: Record<string, string>; dbtFound: boolean; gitignore?: string }): Problem[] {
  const out: Problem[] = [];
  if (!o.dbtFound) out.push({ level: "error", where: "dbt", what: "no dbt CLI found (project .venv, venv, .venv-dbt or PATH)", fix: "python -m venv .venv && .venv/bin/pip install dbt-core dbt-<adapter>" });
  if (!o.profilesFile) out.push({ level: "error", where: "profiles.yml", what: "no profiles.yml (project folder, DBT_PROFILES_DIR, ~/.dbt)", fix: "aihub fabric dbt scaffold writes one for Fabric; otherwise create it from the adapter docs" });
  else {
    let doc: any = {};
    try {
      doc = parseYaml(readFileSync(o.profilesFile, "utf8")) ?? {};
    } catch {
      out.push({ level: "error", where: o.profilesFile, what: "profiles.yml does not parse", fix: "fix the YAML" });
    }
    if (o.profile && !doc[o.profile]) out.push({ level: "error", where: "profiles.yml", what: `no profile '${o.profile}' (dbt_project.yml names it)`, fix: `add a '${o.profile}:' profile or change profile: in dbt_project.yml` });
    for (const [pn, def] of Object.entries<any>(doc)) {
      if (o.profile && pn !== o.profile) continue;
      for (const [tn, t] of Object.entries<any>(def?.outputs ?? {})) {
        const where = `${pn}/${tn}`;
        for (const [k, val] of Object.entries<any>(t ?? {})) {
          if (SECRET_KEY.test(k) && !SAFE_KEY.test(k) && typeof val === "string" && val.trim() && !/^\{\{\s*env_var\(/.test(val.trim())) out.push({ level: "error", where: `${where}.${k}`, what: "a literal secret in profiles.yml", fix: `use "{{ env_var('NAME') }}" (or authentication: CLI)` });
        }
        const type = String(t?.type ?? "");
        if (o.plugins && type && !Object.keys(o.plugins).some((x) => x.replace(/-/g, "") === type.replace(/-/g, ""))) out.push({ level: "warn", where, what: `adapter '${type}' is not installed in this dbt`, fix: `pip install dbt-${type}` });
        if (type === "fabricspark") {
          if (!t.spark_config?.name) out.push({ level: "warn", where, what: "no spark_config.name (required since dbt-fabricspark 1.13: the session name in the Monitoring hub)", fix: "spark_config: {name: <project>_local}" });
          if (Number(t.threads ?? 1) > 2) out.push({ level: "warn", where, what: `threads ${t.threads}: every thread can need its own Livy statement slot`, fix: "threads: 1 (2 at most on a small capacity)" });
          if (!t.authentication) out.push({ level: "warn", where, what: "no authentication", fix: "authentication: CLI (your az login)" });
        }
        if (type === "fabric" && !t.authentication) out.push({ level: "warn", where, what: "no authentication", fix: "authentication: CLI (your az login) or ServicePrincipal with env_var()" });
      }
    }
  }
  const gi = o.gitignore ?? "";
  for (const need of ["target", "dbt_packages", "logs"]) if (!new RegExp(`^/?${need}/?\\s*$`, "m").test(gi)) out.push({ level: "info", where: ".gitignore", what: `${need}/ is not ignored`, fix: `add ${need}/ to .gitignore` });
  return out;
}

function check(ctx: Ctx, v: V, emit: Emit): void {
  const p = resolveProject(ctx, v.project);
  const runner = dbtRunner(ctx, p);
  let plugins: Record<string, string> | undefined;
  let dbtFound = true;
  try {
    const r = runner.raw(["--version"]);
    if (r.status === 0) plugins = parseVersion(r.stdout + r.stderr).plugins;
    else dbtFound = false;
  } catch {
    dbtFound = false;
  }
  const prof = findProfiles(p.dir, ctx.env);
  const gi = [join(p.dir, ".gitignore"), join(p.root, ".gitignore")].filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n");
  const problems = setupProblems({ projectDir: p.dir, profile: p.info.profile, profilesFile: prof.file, plugins, dbtFound, gitignore: gi });
  emit({ ok: !problems.some((x) => x.level === "error"), problems }, problems.length ? [`${problems.length} setup finding(s) for ${p.info.name}:`, ...problems.map((x) => `  ${x.level} ${x.where}: ${x.what}. Fix: ${x.fix}`)].join("\n") : `dbt setup of ${p.info.name} looks fine`);
}

// ---- failures and lineage ---------------------------------------------------------------------------------------------

function failures(ctx: Ctx, v: V, emit: Emit): void {
  const p = resolveProject(ctx, v.project);
  const rep = failureReport(p, dbtRunner(ctx, p), { rows: int(v.rows, "rows", 5), max: int(v.max, "max", 5), sample: !v["no-sample"] });
  if (!rep) throw new AihubError("no target/run_results.json in the project: run `aihub dbt build` (or test) first");
  emit(rep, renderFailures(rep));
}

function lineage(ctx: Ctx, v: V, name: string | undefined, emit: Emit): void {
  if (!name) throw new AihubError("usage: aihub dbt lineage <model|source|exposure> [--up] [--down] [--depth <n>]");
  const p = resolveProject(ctx, v.project);
  const m = loadManifest(p, dbtRunner(ctx, p));
  const n = findNode(m, name);
  const depth = v.depth ? int(v.depth, "depth", 1) : Infinity;
  const both = !v.up && !v.down;
  const show = (ids: string[]) => ids.map((id) => m.nodes.get(id)!).filter((x) => !["test", "unit_test", "macro"].includes(x.kind));
  const line = (x: Node) => `${label(x)} [${x.kind}${x.materialized ? `, ${x.materialized}` : ""}${x.expo ? `, ${x.expo.type ?? "exposure"}` : ""}]`;
  const up = both || v.up ? show(upstream(m, [n.id], depth)) : [];
  const downIds = both || v.down ? downstream(m, [n.id], depth) : [];
  const down = show(downIds);
  const tests = [...m.nodes.values()].filter((x) => (x.kind === "test" || x.kind === "unit_test") && (x.attached === n.id || x.parents.includes(n.id)));
  emit(
    { node: { name: label(n), kind: n.kind, file: n.file, relation: n.relation }, upstream: up.map(line), downstream: down.map(line), tests: tests.map((t) => t.name), exposures: down.filter((x) => x.kind === "exposure").map((x) => ({ name: x.name, ...x.expo })) },
    [`${line(n)} ${n.file}${n.relation ? ` -> ${n.relation}` : ""}`, ...(both || v.up ? [`upstream (${up.length}):`, ...up.map((x) => `  ${line(x)}`)] : []), ...(both || v.down ? [`downstream (${down.length}):`, ...down.map((x) => `  ${line(x)}`)] : []), `tests on it: ${tests.length}${tests.length ? ` (${tests.slice(0, 6).map((t) => t.name).join(", ")}${tests.length > 6 ? ", ..." : ""})` : ""}`].join("\n"),
  );
}

void redact;

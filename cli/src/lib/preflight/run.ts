import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Ctx } from "../context.js";
import { AihubError } from "../errors.js";
import type { Audience } from "../fabric-auth.js";
import { inferEnv, fabricWorkspaces, type Env } from "../fabric.js";
import { branchWorkspace, branchLabel } from "../fabric-diag.js";
import { gitRaw, mergeBase, originDefaultBranch, remoteUrl } from "../git.js";
import { globMatch } from "../glob.js";
import { spawnSync } from "../proc.js";
import { repoNameOfUrl } from "../repoName.js";
import { defaultTargetFor, loadTeam, type TeamConfig } from "../team.js";
import { trace } from "../trace.js";
import { hasPreflight, levelOf, norm, preflightConfig, TOKEN_AUDIENCES, type Level, type PreflightConfig } from "./config.js";
import { driftOf, fingerprint, isRunnable, readState, rememberSteps, writeCalls, writeState, type Drift, type Fingerprint, type State } from "./drift.js";
import { commandFor, pathShells, runCommand, type Shells } from "./exec.js";
import { evalCondition, expand, macroNames, type Lookup } from "./expr.js";
import { loadJob, paramIn, type JobDoc, type ParamScope, type PipelineStep } from "./pipelineYaml.js";
import { prepareSources, setupFingerprint, type Sources } from "./sources.js";
import { masker, maskCommandLine, readLine, type StepLog } from "./vso.js";

/**
 * `aihub preflight`: runs a chosen subset of the steps of the team's deploy job on this PC, from the pipeline YAML
 * itself, in a sources directory next to the repository (never the working tree). Levels stack: local (no network, no
 * token), plan (+ steps that only read the branch's feature workspace) and apply (+ steps that write there).
 */
export type Status = "passed" | "failed" | "blocked" | "notRun" | "unknown" | "skipped" | "cannotRun";

export interface StepResult {
  index: number;
  name: string;
  level: Level | "skip" | "unknown";
  kind: string;
  status: Status;
  reason?: string;
  seconds: number;
  issues: string[];
  afterFailure: boolean;
  uncertain: boolean;
  /** --dry-run: the fully expanded command (secrets masked) */
  command?: string;
  /** a failed step: the lines of its output that say why (secrets masked), and the file with all of it */
  excerpt?: string[];
  log?: string;
}

const WHY = /error|fout|ongeldig|invalid|fail|exception|traceback|denied|forbidden|unauthorized|not found|niet gevonden|mislukt/i;
const EXCERPT_LINES = 10;
const EXCERPT_WIDTH = 240;

/**
 * The lines of a failed step's output that say why: the ones that read like an error (a validator names the file and the
 * rule in the middle of its output, long before the last line), else the last lines. Capped and cut to width.
 */
export function excerptOf(output: string): string[] {
  const all = output.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() && !l.trim().startsWith("##vso["));
  const cut = (l: string) => (l.length > EXCERPT_WIDTH ? `${l.slice(0, EXCERPT_WIDTH)}…` : l);
  const hits = all.filter((l) => WHY.test(l));
  const pick = hits.length ? hits : all.slice(-EXCERPT_LINES);
  const out = pick.slice(0, EXCERPT_LINES).map(cut);
  if (pick.length > EXCERPT_LINES) out.push(`(${pick.length - EXCERPT_LINES} more line(s) in the log)`);
  return out;
}

export interface PreflightResult {
  source: { repository: string; ref: string; commit: string; fetched: string | null };
  job: string;
  workspace: { name: string; id: string; environment: string } | null;
  level: "local" | "plan" | "apply";
  dryRun: boolean;
  steps: StepResult[];
  drift: Drift;
  ok: boolean;
  /** one-line remarks: fetch problems, variable groups that are not read, write-call notes */
  notes: string[];
  verdict: string;
}

export interface PreflightOpts {
  level: "local" | "plan" | "apply";
  step?: string;
  workspace?: string;
  fetch: boolean;
  dryRun: boolean;
  yes: boolean;
  force: boolean;
}

export interface Workspace {
  id: string;
  displayName: string;
}

/** Everything that talks to the network or the machine, injectable for tests. */
export interface PreflightDeps {
  shells?: Shells;
  /** a raw access token (no "Bearer ") for one audience, from the same identities as `aihub fabric` */
  token?: (aud: Audience) => Promise<string>;
  workspaces?: () => Promise<Workspace[]>;
  /** runs of the CD pipeline on the branch that are queued or in progress */
  cdRuns?: (pipeline: string, branch: string) => Promise<{ id: number; status: string }[]>;
  now?: () => number;
}

const LEVEL_OF_FLAG: Record<PreflightOpts["level"], Level[]> = { local: ["local"], plan: ["local", "read"], apply: ["local", "read", "apply"] };
const NEED_FLAG: Record<Level, string> = { local: "", read: "--plan", apply: "--apply" };

/** Azure's environment-variable form: upper case, dots become underscores. */
export const envName = (n: string) => n.replace(/\./g, "_").toUpperCase();

/** Variables that hold a credential of the user: never handed to a step through the inherited environment. */
const CREDENTIAL_ENV = /^(AIHUB_.*(TOKEN|PAT|SECRET).*|AZURE_CLIENT_SECRET|AZURE_DEVOPS_EXT_PAT|SYSTEM_ACCESSTOKEN|ACCESS_TOKEN)$/i;

export function currentRepoName(root: string): string {
  try {
    return repoNameOfUrl(remoteUrl(root)) ?? basename(root);
  } catch {
    return basename(root);
  }
}

interface Prepared {
  root: string;
  team: TeamConfig;
  cfg: PreflightConfig;
  repoName: string;
  branch: string;
  sources: Sources;
  doc: JobDoc;
  state: State;
}

/** Sources and the job, shared by the run, `steps` and `accept`. The scratch checkouts are made also with --dry-run. */
export function prepare(ctx: Ctx, over: { job?: string; source?: string; ref?: string; fetch: boolean }, now: () => number, needBlock: boolean): Prepared {
  const root = gitRaw(ctx.cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
  if (!root) throw new AihubError("not in a git repository: run aihub preflight inside the clone of your repository");
  const team = loadTeam(root);
  if (needBlock && !hasPreflight(team))
    throw new AihubError("team.yaml has no preflight block yet: list the steps of the deploy job with `aihub preflight steps --job <path> [--source <repo>]`, then add `preflight:` with the step names per level (docs/preflight.md)");
  const cfg = preflightConfig(hasPreflight(team) ? team : { preflight: {} }, over);
  const repoName = currentRepoName(root);
  const branch = gitRaw(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const saved = trace.dryRun;
  trace.dryRun = false; // the scratch area is preflight's own: it is made also on a dry run
  let sources: Sources;
  try {
    sources = prepareSources({ root, repoName, team, source: cfg.source.repository, ref: cfg.source.ref, fetch: over.fetch, env: ctx.env, now });
  } finally {
    trace.dryRun = saved;
  }
  const doc = loadJob(sources.source.dir, cfg.job);
  return { root, team, cfg, repoName, branch, sources, doc, state: readState(sources.base) };
}

/** {name} placeholders of team.yaml values; `{workspace}` and `{workspaceId}` only once the workspace is known. */
function placeholders(p: Prepared, ws: () => Workspace | undefined): (text: string) => { text: string; missing: string[] } {
  let lastPushed: string | undefined;
  const fixed: Record<string, () => string | undefined> = {
    repo: () => p.repoName,
    branch: () => p.branch,
    branchName: () => p.branch.split("/").pop(),
    head: () => p.sources.work.commit,
    lastPushed: () => {
      if (lastPushed === undefined) {
        lastPushed = gitRaw(p.root, ["rev-parse", "--verify", "--quiet", "@{u}"]).stdout.trim();
        if (!lastPushed) lastPushed = mergeBase(p.root, defaultTargetFor(p.team, p.repoName) ?? (originDefaultBranch(p.root) || "main"));
      }
      return lastPushed || undefined;
    },
    workspace: () => ws()?.displayName,
    workspaceId: () => ws()?.id,
    sources: () => p.sources.sourcesDir,
    work: () => p.sources.work.dir,
    source: () => p.sources.source.dir,
  };
  return (text: string) => {
    const missing: string[] = [];
    const out = text.replace(/\{([A-Za-z]+)\}/g, (whole, k: string) => {
      const f = fixed[k];
      if (!f) return whole;
      const v = f();
      if (v === undefined) {
        missing.push(`{${k}}`);
        return whole;
      }
      return v;
    });
    return { text: out, missing };
  };
}

function builtins(p: Prepared, now: () => number): Record<string, string> {
  return {
    "Build.SourcesDirectory": p.sources.sourcesDir,
    "Build.Repository.Name": p.repoName,
    "Build.SourceBranch": `refs/heads/${p.branch}`,
    "Build.SourceBranchName": p.branch.split("/").pop() ?? p.branch,
    "Build.SourceVersion": p.sources.work.commit,
    "Build.BuildId": String(Math.floor(now() / 1000)),
    "Pipeline.Workspace": p.sources.base,
    "System.StageName": "preflight",
    "System.StageAttempt": "1",
    "System.Debug": "false",
    "System.DefaultWorkingDirectory": p.sources.sourcesDir,
    "Agent.TempDirectory": join(p.sources.base, "_temp"),
  };
}

/** The variables of one run: step outputs, team.yaml, the YAML's own variables, built-ins, then token variables. */
class Vars {
  readonly outputs = new Map<string, { value: string; secret: boolean }>();
  readonly secrets = new Set<string>();
  readonly tokens = new Map<string, string>();
  private readonly team: Map<string, string>;
  private readonly yaml: Map<string, string>;
  private readonly builtin: Map<string, string>;
  readonly tokenNames: Map<string, string>;
  constructor(
    cfg: PreflightConfig,
    doc: JobDoc,
    b: Record<string, string>,
    readonly ph: (t: string) => { text: string; missing: string[] },
  ) {
    const low = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
    this.team = low(cfg.variables);
    this.yaml = low(doc.variables);
    this.builtin = low(b);
    this.tokenNames = new Map(Object.entries(cfg.tokens).map(([k, v]) => [k.toLowerCase(), v]));
  }
  isToken = (n: string) => this.tokenNames.has(n.toLowerCase());

  /** A lookup that records what it used; `allowTokens` false: a token name is reported, never filled. */
  lookup(rec: { missing: Set<string>; tokens: Set<string> }, allowTokens: boolean, depth = 0): Lookup {
    const self: Lookup = (name) => {
      const k = name.toLowerCase();
      const out = this.outputs.get(k);
      if (out) return out.value;
      const t = this.team.get(k);
      if (t !== undefined) {
        const r = this.ph(t);
        r.missing.forEach((m) => rec.missing.add(m));
        return r.missing.length ? undefined : this.inner(r.text, rec, allowTokens, depth);
      }
      const y = this.yaml.get(k);
      if (y !== undefined) return this.inner(y, rec, allowTokens, depth);
      const bi = this.builtin.get(k);
      if (bi !== undefined) return bi;
      if (this.tokenNames.has(k)) {
        rec.tokens.add(name);
        if (!allowTokens) return "";
        const v = this.tokens.get(k);
        return v ?? "";
      }
      return undefined;
    };
    return self;
  }
  private inner(text: string, rec: { missing: Set<string>; tokens: Set<string> }, allowTokens: boolean, depth: number): string | undefined {
    if (depth > 8) return text;
    const sub = { missing: new Set<string>(), tokens: rec.tokens };
    const r = expand(text, { variable: this.lookup(sub, allowTokens, depth + 1), parameter: () => undefined });
    sub.missing.forEach((m) => rec.missing.add(m));
    r.missing.forEach((m) => rec.missing.add(m));
    return r.missing.length || sub.missing.size ? undefined : r.text;
  }

  /** The variables the agent exposes as environment variables (non-secret, no token): Azure's upper-case form. */
  environment(): Record<string, string> {
    const out: Record<string, string> = {};
    const put = (name: string, v: string | undefined) => {
      if (v !== undefined) out[envName(name)] = v;
    };
    for (const [k, v] of this.builtin) put(k, v);
    for (const k of this.yaml.keys()) if (!this.isToken(k)) put(k, this.safe(k));
    for (const k of this.team.keys()) if (!this.isToken(k)) put(k, this.safe(k));
    for (const [k, v] of this.outputs) if (!v.secret && !this.isToken(k.split(".").pop()!)) put(k, v.value);
    return out;
  }
  private safe(k: string): string | undefined {
    const rec = { missing: new Set<string>(), tokens: new Set<string>() };
    const v = this.lookup(rec, false)(k);
    return rec.tokens.size || rec.missing.size ? undefined : v;
  }
}

export async function runPreflight(ctx: Ctx, o: PreflightOpts, deps: PreflightDeps = {}): Promise<PreflightResult> {
  const now = deps.now ?? ctx.now ?? Date.now;
  const p = prepare(ctx, { fetch: o.fetch }, now, true);
  const { cfg, doc, sources } = p;
  const sh = deps.shells ?? pathShells({ ...process.env, ...ctx.env });
  const selected = LEVEL_OF_FLAG[o.level];
  const notes: string[] = [...doc.notes];
  if (sources.source.warning) notes.push(sources.source.warning);
  if (trace.verbose) ctx.err(`preflight: scratch ${sources.base}`);
  if (!o.dryRun) runSetup(p, (l) => ctx.err(l));

  // ---- the workspace (plan/apply), before anything runs --------------------------------------------------------------
  let ws: (Workspace & { environment: Env }) | undefined;
  if (o.level !== "local") ws = await resolveWorkspace(ctx, p, o, deps);

  // ---- CD in progress (apply) ---------------------------------------------------------------------------------------
  if (o.level === "apply" && cfg.cd?.pipeline && !o.force && !o.dryRun) {
    try {
      const runs = await (deps.cdRuns ?? defaultCdRuns(ctx))(cfg.cd.pipeline, p.branch);
      if (runs.length) throw new AihubError(`a run of ${cfg.cd.pipeline} is ${runs[0].status === "inProgress" ? "in progress" : "queued"} on ${p.branch} (run ${runs[0].id}): wait until it is done, or pass --force`);
    } catch (e) {
      if (e instanceof AihubError && /^a run of /.test(e.message)) throw e;
      notes.push(`could not check whether ${cfg.cd.pipeline} is running on ${p.branch} (${(e as Error).message.split("\n")[0]}); continuing`);
    }
  }

  const ph = placeholders(p, () => ws);
  const vars = new Vars(cfg, doc, builtins(p, now), ph);
  const mask = masker(() => [...vars.secrets, ...vars.tokens.values()]);
  const tokenFor = deps.token ?? defaultToken(ctx);

  // ---- parameters: team.yaml at the root, else the declared default -----------------------------------------------
  const paramRec = { missing: new Set<string>() };
  const rootParam = (name: string): string | undefined => {
    const k = Object.keys(cfg.parameters).find((x) => x.toLowerCase() === name.toLowerCase());
    if (k === undefined) return undefined;
    const r = ph(cfg.parameters[k]);
    r.missing.forEach((m) => paramRec.missing.add(m));
    return r.missing.length ? undefined : r.text;
  };
  const expandStep = (step: PipelineStep, text: string, rec: { missing: Set<string>; tokens: Set<string> }, allowTokens: boolean, keepShell = false) => {
    const variable = vars.lookup(rec, allowTokens);
    const param = (scope: ParamScope) => (name: string) => paramIn(scope, name, rootParam, (t, sc) => {
      const r = expand(t, { variable, parameter: param(sc) });
      r.missing.forEach((m) => rec.missing.add(m));
      return r.missing.length ? undefined : r.text;
    });
    paramRec.missing.clear();
    const r = expand(text, { variable, parameter: param(step.scope), keepShell });
    paramRec.missing.forEach((m) => rec.missing.add(m));
    r.missing.forEach((m) => rec.missing.add(m));
    return r;
  };

  // ---- fingerprints and drift --------------------------------------------------------------------------------------
  const scriptFile = (step: PipelineStep): string | undefined => {
    if (!step.scriptPath) return undefined;
    const r = expandStep(step, step.scriptPath, { missing: new Set(), tokens: new Set() }, false);
    if (r.missing.length || r.cannot.length) return undefined;
    return isAbsolute(r.text) ? r.text : resolve(sources.sourcesDir, r.text);
  };
  const prints = new Map<PipelineStep, Fingerprint>();
  for (const s of doc.steps) {
    if (!isRunnable(s)) continue;
    const f = scriptFile(s);
    let content: string | undefined;
    try {
      content = f && existsSync(f) && statSync(f).isFile() ? readFileSync(f, "utf8") : undefined;
    } catch {
      content = undefined;
    }
    prints.set(s, fingerprint(s, content));
  }
  const drift = driftOf(doc.steps, cfg, p.state, prints);

  // ---- --step ------------------------------------------------------------------------------------------------------
  let last = doc.steps.length;
  if (o.step) {
    const hit = doc.steps.find((s) => norm(s.name) === norm(o.step!));
    if (!hit) {
      const near = doc.steps.filter((s) => norm(s.name).includes(norm(o.step!).slice(0, 6))).map((s) => `"${s.name}"`);
      throw new AihubError(`no step named "${o.step}" in ${cfg.job}${near.length ? `; did you mean ${near.slice(0, 3).join(", ")}?` : " (aihub preflight steps lists them)"}`);
    }
    const l = levelOf(cfg, hit.name);
    if (l === "read" && o.level === "local") throw new AihubError(`"${hit.name}" is a read step: add --plan`);
    if (l === "apply" && o.level !== "apply") throw new AihubError(`"${hit.name}" is an apply step: add --apply`);
    last = hit.index;
  }

  // ---- the run -----------------------------------------------------------------------------------------------------
  const results: StepResult[] = [];
  let anyFailed = false;
  let anyBlocked = false;
  let held = false;
  let unknownBefore: string | undefined;
  let destructive: { step: string; line: string } | undefined;
  const tempDir = join(sources.base, "_temp");
  // empty per run, as on the agent: also removes scripts an older aihub left behind with secrets in them
  if (!o.dryRun) rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  const baseEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries({ ...process.env, ...ctx.env })) if (!CREDENTIAL_ENV.test(k)) baseEnv[k] = v;

  for (const step of doc.steps) {
    const lvl = levelOf(cfg, step.name);
    const r: StepResult = { index: step.index, name: step.name, level: lvl ?? "unknown", kind: step.task ?? step.kind, status: "skipped", seconds: 0, issues: [], afterFailure: false, uncertain: !!unknownBefore };
    results.push(r);
    const set = (status: Status, reason?: string) => {
      r.status = status;
      if (reason) r.reason = mask(reason);
    };
    if (step.index > last) {
      set("skipped", `after --step "${o.step}"`);
      continue;
    }
    if (!step.enabled) {
      set("skipped", "enabled: false in the YAML");
      continue;
    }
    if (step.expression) {
      set("notRun", `${step.cannot}: what it inserts is not known`);
      unknownBefore ??= step.name;
      continue;
    }
    if (!lvl) {
      if (isRunnable(step)) {
        set("unknown", "not in preflight.steps of team.yaml (add it under local, read, apply or skip)");
        unknownBefore ??= step.name;
      } else set("skipped", step.cannot);
      continue;
    }
    if (lvl === "skip") {
      set("skipped", "listed under skip");
      continue;
    }
    if (!isRunnable(step)) {
      set("cannotRun", `cannot run this kind of step (${step.cannot})`);
      continue;
    }
    if (!selected.includes(lvl)) {
      set("skipped", `needs ${NEED_FLAG[lvl]}`);
      continue;
    }
    if (r.uncertain) r.reason = `may depend on the unknown step "${unknownBefore}"`;
    if (lvl === "apply" && !o.dryRun) {
      if (anyFailed || anyBlocked) {
        set("notRun", "an earlier step failed or was blocked: apply steps never run then");
        held = true;
        continue;
      }
      if (r.uncertain) {
        set("notRun", `may depend on the unknown step "${unknownBefore}": list that step in team.yaml first`);
        held = true;
        continue;
      }
      if (destructive && !o.yes) {
        set("notRun", `"${destructive.step}" plans to remove something (${destructive.line}): run again with --yes to apply`);
        held = true;
        continue;
      }
    }

    // condition
    const condVars = vars.lookup({ missing: new Set(), tokens: new Set() }, false);
    const cond = step.condition ? expandStep(step, step.condition, { missing: new Set(), tokens: new Set() }, false).text : undefined;
    let c = evalCondition(cond, { succeeded: !anyFailed, variable: condVars });
    if (c.value === false && anyFailed && lvl !== "apply") {
      const again = evalCondition(cond, { succeeded: true, variable: condVars });
      if (again.value === true) {
        r.afterFailure = true;
        c = again;
      }
    }
    if (c.reason) {
      set("notRun", c.reason);
      continue;
    }
    if (c.value === false) {
      set("notRun", `condition is false: ${String(step.condition ?? "succeeded()").trim()}`);
      continue;
    }

    // which tokens does it ask for (directly or through a variable)?
    const probe = { missing: new Set<string>(), tokens: new Set<string>() };
    const fields = [step.inline ?? "", step.arguments ?? "", step.scriptPath ?? "", step.workingDirectory ?? "", ...Object.values(step.env)];
    for (const f of fields) expandStep(step, f, probe, false, true);
    if (probe.tokens.size && lvl === "local") {
      set("blocked", `listed as local but asks for token ${[...probe.tokens][0]}: local steps never get a token (move it to read or apply)`);
      anyBlocked = true;
      continue;
    }
    const direct = fields.flatMap(macroNames).filter((n) => vars.isToken(n));
    try {
      for (const t of new Set([...probe.tokens, ...direct])) {
        const k = t.toLowerCase();
        if (vars.tokens.has(k)) continue;
        const aud = TOKEN_AUDIENCES[(vars.tokenNames.get(k) ?? "").toLowerCase()];
        if (!aud) throw new AihubError(`preflight.tokens.${t} names "${vars.tokenNames.get(k)}": use fabric, onelake, sql, powerbi or kusto`);
        if (o.dryRun) vars.tokens.set(k, `<${t}>`);
        else vars.tokens.set(k, (await tokenFor(aud)).replace(/^Bearer\s+/i, ""));
      }
    } catch (e) {
      if (e instanceof AihubError && /not signed in|az login/i.test(e.message)) throw new AihubError(`not signed in: run 'az login' (step "${step.name}" needs a token)`);
      throw e;
    }

    // expand everything
    const rec = { missing: new Set<string>(), tokens: new Set<string>() };
    const cannot: string[] = [];
    const ex = (text: string | undefined, keepShell = false) => {
      if (text === undefined) return undefined;
      const x = expandStep(step, text, rec, lvl !== "local", keepShell);
      cannot.push(...x.cannot);
      return x.text;
    };
    const inline = ex(step.inline, true);
    const args = ex(step.arguments);
    const scriptPath = ex(step.scriptPath);
    const wdRaw = ex(step.workingDirectory);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(step.env)) env[k] = ex(v) ?? "";
    if (cannot.length) {
      set("notRun", `cannot evaluate ${cannot[0]}`);
      continue;
    }
    if (rec.missing.size && o.dryRun && ![...rec.missing].some((m) => m.startsWith("{") || m.startsWith("parameters."))) {
      set("notRun", `dry run; needs $(${[...rec.missing][0]}) at run time: set by an earlier step, or add it under preflight.variables`);
    } else if (rec.missing.size) {
      const m = [...rec.missing][0];
      set("blocked", m.startsWith("{workspace") ? `needs ${m}, which is only known with --plan or --apply` : m.startsWith("{") ? `needs ${m}, which preflight could not work out` : m.startsWith("parameters.") ? `needs ${m}: add it under preflight.parameters in team.yaml` : lvl === "local" ? `needs variable ${m}: when a read step sets it, list this step under preflight.steps.read so it runs with --plan; else add it under preflight.variables in team.yaml` : `needs variable ${m}: add it under preflight.variables in team.yaml`);
      anyBlocked = true;
      continue;
    }

    const cwd = wdRaw ? (isAbsolute(wdRaw) ? wdRaw : resolve(sources.sourcesDir, wdRaw)) : sources.sourcesDir;
    const file = scriptPath ? (isAbsolute(scriptPath) ? scriptPath : resolve(sources.sourcesDir, scriptPath)) : undefined;
    if (r.status === "notRun") {
      r.command = mask([scriptPath ?? "", args ?? "", inline ?? ""].filter(Boolean).join(" ").trim());
      continue;
    }
    const cmd = commandFor(step, { inline, scriptFile: file, arguments: args }, { sh, tempDir, python: cfg.python, shell: cfg.shell, id: `step-${step.index}` });
    if (cmd.missing) {
      set("cannotRun", `${cmd.missing} is not on this PC${step.kind === "python" ? " (set preflight.python in team.yaml)" : step.kind === "script" ? " (set preflight.shell in team.yaml)" : ""}`);
      continue;
    }
    if (o.dryRun) {
      set("notRun", "dry run");
      r.command = mask(`${cmd.display}${cmd.script ? `\n${cmd.script.content.trimEnd()}` : ""}${Object.keys(env).length ? `\nenv: ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""}${cwd !== sources.sourcesDir ? `\ncwd: ${cwd}` : ""}`);
      continue;
    }

    // a read step whose script gained write calls does not run until it is accepted again
    if (lvl === "read" && file) {
      const sites = writeCalls(file, file.startsWith(sources.source.dir) ? sources.source.dir : sources.sourcesDir);
      const known = p.state.writes[norm(step.name)];
      if (!known) p.state.writes[norm(step.name)] = sites;
      else {
        const added = sites.filter((s) => !known.includes(s));
        if (added.length) {
          set("notRun", `its script has a new write call (${added[0]}); check it, then: aihub preflight accept "${step.name}"`);
          held = true;
          continue;
        }
      }
    }
    if (file && !existsSync(file)) {
      set("failed", `script not found: ${file}`);
      r.issues.push(r.reason!);
      anyFailed = true;
      continue;
    }
    if (!existsSync(cwd)) {
      set("failed", `working directory does not exist: ${cwd}`);
      r.issues.push(r.reason!);
      anyFailed = true;
      continue;
    }

    const log: StepLog = { variables: [], issues: [] };
    const res = await runCommand(cmd, {
      cwd,
      env: { ...baseEnv, ...vars.environment(), ...env },
      now,
      onLine: (line) => {
        readLine(line, log);
        for (const v of log.variables) if (v.secret) vars.secrets.add(v.value);
        if (trace.verbose) ctx.err(`  | ${mask(maskCommandLine(line))}`);
      },
    });
    r.seconds = res.seconds;
    for (const v of log.variables) {
      const value = { value: v.value, secret: v.secret };
      vars.outputs.set(v.name.toLowerCase(), value);
      if (step.ref && v.output) vars.outputs.set(`${step.ref}.${v.name}`.toLowerCase(), value);
      if (v.secret) vars.secrets.add(v.value);
    }
    r.issues = log.issues.map((i) => mask(`${i.type}: ${i.text}`));
    const failed = res.code !== 0 || !!res.error || /^failed$/i.test(log.result ?? "");
    if (failed && !step.continueOnError) {
      set("failed", res.error ?? (res.code !== 0 ? `exit code ${res.code}` : "the step reported result=Failed"));
      if (!r.issues.length) {
        const tail = res.output.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("##vso[")).pop();
        if (tail) r.issues.push(mask(tail.slice(0, 300)));
      }
      // why it failed, and all of it in a file: the reader should not have to run it again to see the cause
      r.excerpt = excerptOf(res.output).map((l) => mask(l));
      try {
        const dir = join(sources.base, "logs");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${String(step.index).padStart(2, "0")}-${step.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "step"}.log`);
        writeFileSync(file, res.output.split("\n").map((l) => mask(maskCommandLine(l))).join("\n"), "utf8");
        r.log = file;
      } catch {
        /* the excerpt is enough when the log cannot be written */
      }
      anyFailed = true;
    } else {
      set("passed", failed ? `failed, but continueOnError is set (${res.error ?? `exit code ${res.code}`})` : r.reason);
    }
    const guard = cfg.apply.destructive.find((d) => norm(d.step) === norm(step.name));
    if (guard && lvl === "read" && !destructive) {
      const re = new RegExp(guard.pattern, "m");
      const line = res.output.split("\n").find((l) => re.test(l));
      if (line) destructive = { step: step.name, line: mask(line.trim().slice(0, 200)) };
    }
  }

  if (destructive && o.level === "plan") notes.push(`"${destructive.step}" plans to remove something (${destructive.line}): --apply will ask for --yes`);
  if (!o.dryRun) {
    rememberSteps(p.state, doc.steps, prints);
    writeState(sources.base, p.state);
  }
  const failedN = results.filter((r) => r.status === "failed").length;
  const blockedN = results.filter((r) => r.status === "blocked").length;
  const ok = !failedN && !blockedN && !held;
  const wrote = results.some((r) => r.level === "apply" && (r.status === "passed" || r.status === "failed"));
  const ran = results.filter((r) => r.status === "passed").length;
  const verdict = o.dryRun
    ? "dry run: nothing was run"
    : ok
      ? `preflight ok: ${ran} step(s) passed${o.level === "local" && cfg.steps.read.length ? "; next: aihub preflight --plan" : ""}`
      : `preflight ${failedN || blockedN ? "failed" : "stopped"}: ${[failedN && `${failedN} failed`, blockedN && `${blockedN} blocked`, held && "apply held back"].filter(Boolean).join(", ")}${wrote ? "; apply steps ran, check the workspace" : o.level === "local" ? "" : "; nothing was written"}`;
  return {
    source: { repository: sources.source.name, ref: sources.source.ref, commit: sources.source.commit, fetched: sources.source.fetchedAt ?? null },
    job: cfg.job,
    workspace: ws ? { name: ws.displayName, id: ws.id, environment: ws.environment } : null,
    level: o.level,
    dryRun: o.dryRun,
    steps: results,
    drift,
    ok,
    notes,
    verdict,
  };
}

// ---- workspace -----------------------------------------------------------------------------------------------------

function classify(team: TeamConfig, name: string): Env {
  const listed = fabricWorkspaces(team).find((w) => w.name.toLowerCase() === name.toLowerCase());
  return listed?.environment ?? inferEnv(name);
}

async function resolveWorkspace(ctx: Ctx, p: Prepared, o: PreflightOpts, deps: PreflightDeps): Promise<Workspace & { environment: Env }> {
  if (!p.branch || p.branch === "HEAD") throw new AihubError("detached HEAD: check out your branch first; --plan and --apply use the workspace of the current branch");
  const team = p.team;
  const prefixes = [...(((team as { fabric?: { branchWorkspacePrefixes?: string[] } }).fabric?.branchWorkspacePrefixes) ?? []), ...((team.repositories ?? []).map((x) => x.name ?? "").filter(Boolean)), p.repoName];
  let list: Workspace[];
  try {
    list = await (deps.workspaces ?? defaultWorkspaces(ctx))();
  } catch (e) {
    if (/not signed in|az login|401/i.test((e as Error).message)) throw new AihubError("not signed in to Fabric: run 'az login' (--plan and --apply read your feature workspace with your own sign-in)");
    throw e;
  }
  const own = branchWorkspace(list, p.branch, [...new Set(prefixes)], (w) => w.displayName);
  let w: Workspace | undefined;
  if (o.workspace) {
    const want = o.workspace.toLowerCase();
    w = list.find((x) => x.displayName.toLowerCase() === want || x.id.toLowerCase() === want);
    if (!w) throw new AihubError(`no Fabric workspace '${o.workspace}' for your account`);
  } else w = own;
  if (!w)
    throw new AihubError(
      `branch ${p.branch} has no Fabric workspace yet (looked for '${prefixes[0]} ${branchLabel(p.branch)}'): the first one is made by the team's CD after the first push of this branch; then run aihub preflight --plan again, or pass --workspace <name>`,
    );
  const listedEnv = fabricWorkspaces(team).find((x) => x.name.toLowerCase() === w!.displayName.toLowerCase())?.environment;
  const env: Env = listedEnv ?? (own && own.id === w.id && inferEnv(w.displayName) === "dev" ? "feature" : classify(team, w.displayName));
  if (env === "acc" || env === "prd") throw new AihubError(`workspace '${w.displayName}' is ${env.toUpperCase()}: preflight never reads or writes ACC or PRD`);
  if (o.level === "apply") {
    if (env === "test") throw new AihubError(`workspace '${w.displayName}' is TEST: --apply only writes to the feature workspace of your branch; the CD deploys test`);
    const refused = p.cfg.apply.refuseWorkspaces.find((g) => globMatch(g.toLowerCase(), w!.displayName.toLowerCase()));
    if (refused) throw new AihubError(`workspace '${w.displayName}' matches preflight.apply.refuseWorkspaces '${refused}': --apply refuses it`);
    const listed = fabricWorkspaces(team).find((x) => x.name.toLowerCase() === w!.displayName.toLowerCase());
    const isOwn = own && own.id === w.id;
    const featureForBranch = listed?.environment === "feature" && (listed.branches ?? []).some((g) => globMatch(g, p.branch));
    if (!isOwn && !featureForBranch) throw new AihubError(`workspace '${w.displayName}' is not the feature workspace of ${p.branch}: --apply only writes there${own ? ` ('${own.displayName}')` : ""}`);
  }
  return { ...w, environment: env };
}

function defaultToken(ctx: Ctx): (aud: Audience) => Promise<string> {
  let identity: import("../fabric-auth.js").FabricIdentity | undefined;
  return async (aud) => {
    if (!identity) {
      const { FabricIdentity } = await import("../fabric-auth.js");
      identity = new FabricIdentity({ env: ctx.env, fetch: ctx.fetch, exec: ctx.exec, now: ctx.now, tokenCache: ctx.tokenCache });
    }
    return identity.token(aud);
  };
}

function defaultWorkspaces(ctx: Ctx): () => Promise<Workspace[]> {
  return async () => {
    const { FabricClient } = await import("../fabric.js");
    const token = defaultToken(ctx);
    const client = new FabricClient(() => token("fabric"), ctx.fetch, { sleep: ctx.sleep, waitScale: ctx.env.AIHUB_POLL_MS === "0" ? 0 : 1 });
    return client.workspaces();
  };
}

function defaultCdRuns(ctx: Ctx): (pipeline: string, branch: string) => Promise<{ id: number; status: string }[]> {
  return async (pipeline, branch) => {
    const { repoClient } = await import("../context.js");
    const c = repoClient(ctx).client;
    const defs = await c.list<{ id: number; name: string }>("build/definitions", { name: pipeline });
    const def = defs.find((d) => d.name.toLowerCase() === pipeline.toLowerCase()) ?? defs[0];
    if (!def) throw new Error(`no pipeline named '${pipeline}'`);
    const r = await c.get<{ value?: { id: number; status: string }[] }>("build/builds", { definitions: def.id, branchName: `refs/heads/${branch}`, queryOrder: "queueTimeDescending", $top: 10 });
    return (r.value ?? []).filter((b) => ["inProgress", "notStarted", "postponed"].includes(b.status));
  };
}

// ---- setup -------------------------------------------------------------------------------------------------------------

/**
 * preflight.setup in the source checkout, once per commit of the source repository and fingerprint of its dependency
 * files. Per commit, because a setup such as `pip install .` copies the scripts' own package: a copy of an older commit
 * would be imported by the steps of a newer one.
 */
export function runSetup(p: { cfg: PreflightConfig; sources: Sources; state: State }, say: (l: string) => void): void {
  if (!p.cfg.setup.length) return;
  const dir = p.sources.source.dir;
  const fp = `${p.sources.source.commit}:${setupFingerprint(dir, p.cfg.setup)}`;
  if (p.state.setup[p.sources.source.name] === fp) return;
  for (const c of p.cfg.setup) {
    say(`setup: ${c}`);
    const r = spawnSync(c, { cwd: dir, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) {
      const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" / ");
      throw new AihubError(`preflight.setup failed in ${p.sources.source.name}: ${c} (exit ${r.status ?? "?"})${tail ? `: ${tail}` : ""}`);
    }
  }
  p.state.setup[p.sources.source.name] = fp;
  writeState(p.sources.base, p.state);
}

export const _test = { Vars, placeholders, builtins };

// ---- output ------------------------------------------------------------------------------------------------------------

const LABEL: Record<Status, string> = { passed: "ok", failed: "FAILED", blocked: "BLOCKED", notRun: "not run", unknown: "unknown", skipped: "skipped", cannotRun: "cannot run" };
const GROUP: Record<string, string> = { local: "local", read: "read from the workspace", apply: "write to the workspace" };

/** The compact text: grouped per level, one line per step, then drift, notes and the verdict. */
export function formatResult(r: PreflightResult): string {
  const lines: string[] = [];
  const at = r.source.fetched ? `, fetched ${r.source.fetched.slice(0, 16).replace("T", " ")}` : "";
  lines.push(`preflight ${r.level}${r.dryRun ? " (dry run)" : ""}: ${r.job} from ${r.source.repository}@${r.source.ref} (${r.source.commit.slice(0, 7)}${at})`);
  if (r.workspace) lines.push(`workspace: ${r.workspace.name} (${r.workspace.environment}, with your sign-in)`);
  const selected = LEVEL_OF_FLAG[r.level];
  for (const l of ["local", "read", "apply"] as Level[]) {
    const steps = r.steps.filter((s) => s.level === l && s.status !== "cannotRun");
    if (!steps.length) continue;
    if (!selected.includes(l)) {
      lines.push(`${GROUP[l]} · ${steps.length} step(s): need ${NEED_FLAG[l]}`);
      continue;
    }
    lines.push(`${GROUP[l]} · ${steps.length} step(s)`);
    for (const s of steps) {
      const extra = [s.afterFailure && "after a failure", s.uncertain && "uncertain"].filter(Boolean).join(", ");
      const why = s.issues[0] ?? s.reason;
      lines.push(`  ${LABEL[s.status].padEnd(8)} ${s.name}${s.seconds ? `  ${s.seconds}s` : ""}${why ? `  ${why}` : ""}${extra ? `  (${extra})` : ""}`);
      if (s.command) lines.push(...s.command.split("\n").map((c) => `      ${c}`));
      // the lines that say why (the one above is only the first issue or the last line)
      for (const e of (s.excerpt ?? []).filter((x) => x.trim() !== (why ?? "").trim())) lines.push(`      | ${e}`);
      if (s.log) lines.push(`      log: ${s.log}`);
    }
  }
  for (const s of r.steps.filter((x) => x.status === "cannotRun")) lines.push(`cannot run: ${s.name} (${s.level}): ${s.reason}`);
  const skipped = r.steps.filter((s) => (s.status === "skipped" && s.level !== "local" && s.level !== "read" && s.level !== "apply") || (s.status === "notRun" && s.level === "unknown"));
  if (skipped.length) lines.push(`not run here · ${skipped.length} step(s): ${skipped.map((s) => s.name).join(", ")}`);
  const d = r.drift;
  for (const ren of d.renamed.filter((x) => d.unknown.includes(x.to))) lines.push(`drift: "${ren.to}" looks renamed from "${ren.from}" (same script and arguments): rename it in preflight.steps of team.yaml`);
  // one line for all the steps in no list: a first run names every step of the job
  const fresh = d.unknown.filter((u) => !d.renamed.some((x) => x.to === u));
  if (fresh.length === 1) lines.push(`drift: unknown step "${fresh[0]}": not run, and the steps after it are uncertain; add it to preflight.steps (local, read, apply or skip) in team.yaml`);
  else if (fresh.length) lines.push(`drift: ${fresh.length} steps are in no list (not run, and the steps after the first are uncertain): ${fresh.map((u) => `"${u}"`).join(", ")}; add each to preflight.steps (local, read, apply or skip) in team.yaml`);
  for (const m of d.missing.filter((x) => !d.renamed.some((y) => y.from === x))) lines.push(`drift: team.yaml lists "${m}", but ${r.job} has no such step: remove it or fix the name`);
  for (const c of d.changed) lines.push(`drift: the script of "${c}" changed since your last run here`);
  for (const n of r.notes) lines.push(`note: ${n}`);
  lines.push(r.verdict);
  return lines.join("\n");
}

/** The JSON object of docs/cli-json.md. */
export function resultJson(r: PreflightResult): unknown {
  return {
    source: r.source,
    job: r.job,
    workspace: r.workspace,
    level: r.level,
    dryRun: r.dryRun,
    steps: r.steps.map((s) => ({ name: s.name, level: s.level, kind: s.kind, status: s.status, reason: s.reason ?? null, seconds: s.seconds, issues: s.issues, afterFailure: s.afterFailure, uncertain: s.uncertain, ...(s.command !== undefined ? { command: s.command } : {}), ...(s.excerpt?.length ? { excerpt: s.excerpt } : {}), ...(s.log ? { log: s.log } : {}) })),
    drift: r.drift,
    ok: r.ok,
    notes: r.notes,
  };
}

// ---- steps and accept ------------------------------------------------------------------------------------------------

export interface StepsList {
  source: PreflightResult["source"];
  job: string;
  steps: { index: number; name: string; kind: string; level: Level | "skip" | "unknown"; script: string | null; condition: string | null; runnable: boolean; note: string | null }[];
  drift: Drift;
  notes: string[];
}

/** `aihub preflight steps`: every step of the job with its kind and level; no step runs. Works without a preflight block. */
export function listSteps(ctx: Ctx, over: { job?: string; source?: string; ref?: string; fetch: boolean }): StepsList {
  const now = ctx.now ?? Date.now;
  const p = prepare(ctx, over, now, false);
  const prints = new Map<PipelineStep, Fingerprint>();
  for (const s of p.doc.steps) if (isRunnable(s)) prints.set(s, fingerprint(s, undefined));
  const drift = driftOf(p.doc.steps, p.cfg, { ...p.state, steps: Object.fromEntries(Object.entries(p.state.steps).map(([k, v]) => [k, { ...v, content: "" }])) }, prints);
  drift.changed = [];
  return {
    source: { repository: p.sources.source.name, ref: p.sources.source.ref, commit: p.sources.source.commit, fetched: p.sources.source.fetchedAt ?? null },
    job: p.cfg.job,
    steps: p.doc.steps.map((s) => ({
      index: s.index,
      name: s.name,
      kind: s.task ?? s.kind,
      level: levelOf(p.cfg, s.name) ?? "unknown",
      script: s.scriptPath ?? (s.inline !== undefined ? `inline: ${s.inline.trim().split("\n")[0].slice(0, 80)}` : null),
      condition: s.condition?.trim() ?? null,
      runnable: isRunnable(s) && !s.expression,
      note: s.cannot ?? (s.enabled ? null : "enabled: false"),
    })),
    drift,
    notes: [...p.doc.notes, ...(p.sources.source.warning ? [p.sources.source.warning] : [])],
  };
}

export function formatSteps(l: StepsList): string {
  const lines = [`${l.job} from ${l.source.repository}@${l.source.ref} (${l.source.commit.slice(0, 7)}): ${l.steps.length} step(s)`];
  for (const s of l.steps) lines.push(`  ${String(s.index).padStart(2)}  ${s.level.padEnd(7)} ${s.kind.padEnd(16)} ${s.name}${s.runnable ? "" : `  (${s.note ?? "does not run on a PC"})`}`);
  const unknown = l.steps.filter((s) => s.runnable && s.level === "unknown");
  if (unknown.length) lines.push(`not in team.yaml yet: ${unknown.length} runnable step(s); list each under preflight.steps.local (no network, no token), read (only reads the workspace), apply (writes) or skip`);
  for (const r of l.drift.renamed) lines.push(`drift: "${r.to}" looks renamed from "${r.from}" (same script and arguments)`);
  for (const m of l.drift.missing.filter((x) => !l.drift.renamed.some((y) => y.from === x))) lines.push(`drift: team.yaml lists "${m}", but ${l.job} has no such step`);
  for (const n of l.notes) lines.push(`note: ${n}`);
  return lines.join("\n");
}

/** `aihub preflight accept "<step>"`: the write calls a read step's script has now are the known ones. */
export function acceptStep(ctx: Ctx, name: string, fetch: boolean): string {
  const p = prepare(ctx, { fetch }, ctx.now ?? Date.now, true);
  const step = p.doc.steps.find((s) => norm(s.name) === norm(name));
  if (!step) throw new AihubError(`no step named "${name}" in ${p.cfg.job} (aihub preflight steps lists them)`);
  if (levelOf(p.cfg, step.name) !== "read") throw new AihubError(`"${step.name}" is not a read step: only read steps are checked for write calls`);
  const ph = placeholders(p, () => undefined);
  const vars = new Vars(p.cfg, p.doc, builtins(p, ctx.now ?? Date.now), ph);
  const rec = { missing: new Set<string>(), tokens: new Set<string>() };
  const r = expand(step.scriptPath ?? "", { variable: vars.lookup(rec, false), parameter: (n) => paramIn(step.scope, n, (k) => p.cfg.parameters[k], () => undefined) });
  if (!step.scriptPath || r.missing.length) throw new AihubError(`the script of "${step.name}" is not a file preflight can find${r.missing.length ? ` (needs ${r.missing[0]})` : ""}`);
  const file = isAbsolute(r.text) ? r.text : resolve(p.sources.sourcesDir, r.text);
  const sites = writeCalls(file, file.startsWith(p.sources.source.dir) ? p.sources.source.dir : p.sources.sourcesDir);
  p.state.writes[norm(step.name)] = sites;
  writeState(p.sources.base, p.state);
  return `accepted "${step.name}": ${sites.length} write call site(s) in its script are now the known ones${sites.length ? `\n${sites.map((s) => `  ${s}`).join("\n")}` : ""}`;
}

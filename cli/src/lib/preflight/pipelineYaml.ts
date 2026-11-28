import { existsSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { parse } from "yaml";
import { AihubError } from "../errors.js";
import { readUtf8 } from "../team.js";

/**
 * The steps of a pipeline YAML in the order the agent runs them: `steps:` at the top, under `jobs[]`, under a
 * deployment job's strategy and under `stages[].jobs[]`, with `- template:` includes from the same repository.
 * Only reads; nothing is run here.
 */
export type StepKind = "script" | "bash" | "pwsh" | "powershell" | "python" | "other";

/** Values of `${{ parameters.x }}` for one file: what the include passed, else the file's declared defaults, else the parent. */
export interface ParamScope {
  file: string;
  /** passed by `- template: x` `parameters:` (raw text, expanded in the parent scope) */
  passed: Record<string, unknown>;
  defaults: Record<string, unknown>;
  parent?: ParamScope;
}

export interface PipelineStep {
  /** 1-based position in the job */
  index: number;
  /** displayName, else the name Azure shows for this kind */
  name: string;
  displayName?: string;
  /** `name:` (the reference name of output variables) */
  ref?: string;
  kind: StepKind;
  task?: string;
  /** a file script (python, bash or PowerShell) */
  scriptPath?: string;
  inline?: string;
  arguments?: string;
  workingDirectory?: string;
  env: Record<string, string>;
  condition?: string;
  enabled: boolean;
  continueOnError: boolean;
  /** the YAML file it comes from, relative to the source repository */
  file: string;
  scope: ParamScope;
  /** why this step cannot run on a PC (kind other) */
  cannot?: string;
  /** a `${{ if }}` / `${{ each }}` block: what it inserts is not known */
  expression?: boolean;
}

export interface JobDoc {
  steps: PipelineStep[];
  /** compile-time `variables:` of the file and its stages and jobs (a runtime `$[ ]` value is left out) */
  variables: Record<string, string>;
  notes: string[];
}

const asStr = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : typeof v === "object" ? JSON.stringify(v) : String(v));
const isMap = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const ci = (o: Record<string, any> | undefined, key: string): any => (o ? o[Object.keys(o).find((k) => k.toLowerCase() === key.toLowerCase()) ?? ""] : undefined);

function declared(doc: unknown): Record<string, unknown> {
  const p = isMap(doc) ? doc.parameters : undefined;
  if (Array.isArray(p)) return Object.fromEntries(p.filter((x) => isMap(x) && x.name).map((x) => [String(x.name), x.default]));
  if (isMap(p)) return { ...p };
  return {};
}

export function loadJob(sourceRoot: string, jobPath: string): JobDoc {
  const full = resolve(sourceRoot, jobPath);
  if (!existsSync(full)) throw new AihubError(`the pipeline YAML ${jobPath} is not in the source repository (${posix.basename(sourceRoot.replace(/\\/g, "/"))}); fix preflight.job in team.yaml (the job file may have moved)`);
  const out: JobDoc = { steps: [], variables: {}, notes: [] };
  const seen: string[] = [];
  const readDoc = (abs: string): unknown => {
    try {
      return parse(readUtf8(abs));
    } catch (e) {
      throw new AihubError(`${rel(abs)} is not valid YAML: ${(e as Error).message.split("\n")[0]}`);
    }
  };
  const rel = (abs: string) => relative(sourceRoot, abs).replace(/\\/g, "/");

  const addVars = (v: unknown, file: string) => {
    const put = (k: string, val: unknown) => {
      const s = asStr(val);
      if (s === undefined || /^\s*\$\[/.test(s)) return; // a runtime expression ($[ dependencies... ]) is not known before the run
      out.variables[k] = s;
    };
    if (isMap(v)) for (const [k, val] of Object.entries(v)) put(k, val);
    else if (Array.isArray(v))
      for (const x of v) {
        if (isMap(x) && x.name !== undefined) put(String(x.name), x.value);
        else if (isMap(x) && x.group) out.notes.push(`${file}: variable group ${x.group} is not read; put the values a step needs in preflight.variables`);
        else if (isMap(x) && x.template) out.notes.push(`${file}: variable template ${x.template} is not read; put the values a step needs in preflight.variables`);
      }
  };

  /** `- template: x` from `fromAbs`; undefined with a reason when it is outside the repository or from another one. */
  const templatePath = (t: string, fromAbs: string): { abs?: string; reason?: string } => {
    if (/\$\{\{/.test(t)) return { reason: "template path is an expression" };
    let p = t.trim();
    const at = p.lastIndexOf("@");
    if (at > 0) {
      if (p.slice(at + 1).toLowerCase() !== "self") return { reason: `template from another repository (${p.slice(at + 1)})` };
      p = p.slice(0, at);
      if (!p.startsWith("/")) p = `/${p}`;
    }
    const abs = p.startsWith("/") ? resolve(sourceRoot, `.${p}`) : resolve(dirname(fromAbs), p);
    const r = relative(sourceRoot, abs);
    if (r.startsWith("..") || isAbsolute(r)) return { reason: "template outside the source repository" };
    if (!existsSync(abs)) return { reason: `template ${r.replace(/\\/g, "/")} not found` };
    return { abs };
  };

  const pushOther = (name: string, file: string, scope: ParamScope, cannot: string, extra: Partial<PipelineStep> = {}) =>
    out.steps.push({ index: out.steps.length + 1, name, kind: "other", env: {}, enabled: true, continueOnError: false, file, scope, cannot, ...extra });

  const walkSteps = (steps: unknown, abs: string, scope: ParamScope) => {
    if (!Array.isArray(steps)) return;
    for (const s of steps) {
      if (!isMap(s)) continue;
      const file = rel(abs);
      const keys = Object.keys(s);
      if (keys.length && keys.every((k) => k.trim().startsWith("${{"))) {
        pushOther(keys[0].trim(), file, scope, "template expression cannot be evaluated", { expression: true });
        continue;
      }
      if (typeof s.template === "string") {
        const t = templatePath(s.template, abs);
        if (!t.abs) {
          pushOther(`template ${s.template}`, file, scope, t.reason!, { expression: true });
          continue;
        }
        if (seen.filter((x) => x === t.abs).length > 20) throw new AihubError(`template ${s.template} includes itself`);
        seen.push(t.abs);
        const doc = readDoc(t.abs);
        walkSteps(isMap(doc) ? doc.steps : undefined, t.abs, { file: rel(t.abs), passed: isMap(s.parameters) ? s.parameters : {}, defaults: declared(doc), parent: scope });
        continue;
      }
      out.steps.push(stepOf(s, out.steps.length + 1, file, scope));
    }
  };

  const walkJob = (j: unknown, abs: string, scope: ParamScope) => {
    if (!isMap(j)) return;
    if (typeof j.template === "string") {
      const t = templatePath(j.template, abs);
      if (!t.abs) return void out.notes.push(`${rel(abs)}: job ${j.template} not read (${t.reason})`);
      const doc = readDoc(t.abs);
      return walkContainer(doc, t.abs, { file: rel(t.abs), passed: isMap(j.parameters) ? j.parameters : {}, defaults: declared(doc), parent: scope });
    }
    addVars(j.variables, rel(abs));
    walkSteps(j.steps, abs, scope);
    const strat = isMap(j.strategy) ? j.strategy : undefined;
    for (const kind of ["runOnce", "rolling", "canary"]) {
      const st = strat?.[kind];
      if (!isMap(st)) continue;
      for (const phase of ["preDeploy", "deploy", "routeTraffic", "postRouteTraffic"]) walkSteps(st[phase]?.steps, abs, scope);
      for (const on of ["failure", "success"]) walkSteps(st.on?.[on]?.steps, abs, scope);
    }
  };

  const walkContainer = (doc: unknown, abs: string, scope: ParamScope) => {
    if (!isMap(doc)) return;
    addVars(doc.variables, rel(abs));
    if (Array.isArray(doc.stages))
      for (const st of doc.stages) {
        if (isMap(st) && typeof st.template === "string") {
          const t = templatePath(st.template, abs);
          if (!t.abs) {
            out.notes.push(`${rel(abs)}: stage ${st.template} not read (${t.reason})`);
            continue;
          }
          const d = readDoc(t.abs);
          walkContainer(d, t.abs, { file: rel(t.abs), passed: isMap(st.parameters) ? st.parameters : {}, defaults: declared(d), parent: scope });
          continue;
        }
        if (!isMap(st)) continue;
        addVars(st.variables, rel(abs));
        if (Array.isArray(st.jobs)) for (const j of st.jobs) walkJob(j, abs, scope);
      }
    if (Array.isArray(doc.jobs)) for (const j of doc.jobs) walkJob(j, abs, scope);
    walkSteps(doc.steps, abs, scope);
  };

  const doc = readDoc(full);
  walkContainer(doc, full, { file: rel(full), passed: {}, defaults: declared(doc) });
  if (!out.steps.length) throw new AihubError(`${jobPath} has no steps preflight can find (looked under steps, jobs[].steps, deployment strategies and stages)`);
  return out;
}

const DEFAULT_NAME: Record<string, string> = { script: "CmdLine", bash: "Bash", pwsh: "PowerShell", powershell: "PowerShell" };

function stepOf(s: Record<string, any>, index: number, file: string, scope: ParamScope): PipelineStep {
  const env = isMap(s.env) ? Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, asStr(v) ?? ""])) : {};
  const base = {
    index,
    displayName: asStr(s.displayName),
    ref: asStr(s.name),
    env,
    condition: asStr(s.condition),
    enabled: s.enabled !== false && String(s.enabled).toLowerCase() !== "false",
    continueOnError: s.continueOnError === true || String(s.continueOnError).toLowerCase() === "true",
    file,
    scope,
    workingDirectory: asStr(s.workingDirectory),
  };
  const named = (kind: StepKind, extra: Partial<PipelineStep>, dflt: string): PipelineStep => ({ ...base, kind, name: base.displayName ?? dflt, ...extra }) as PipelineStep;
  for (const k of ["script", "bash", "pwsh", "powershell"] as const) {
    if (s[k] !== undefined) return named(k, { inline: asStr(s[k]) ?? "" }, DEFAULT_NAME[k]);
  }
  if (typeof s.task === "string") {
    const task = s.task.trim();
    const t = task.toLowerCase().replace(/\s+/g, "");
    const inputs = isMap(s.inputs) ? s.inputs : {};
    const inp = (k: string) => asStr(ci(inputs, k));
    const wd = inp("workingDirectory") ?? base.workingDirectory;
    const dflt = task.split("@")[0];
    if (t === "pythonscript@0") {
      const inline = (inp("scriptSource") ?? "filePath").toLowerCase() === "inline";
      return named("python", { task, scriptPath: inline ? undefined : inp("scriptPath"), inline: inline ? (inp("script") ?? "") : undefined, arguments: inp("arguments"), workingDirectory: wd }, dflt);
    }
    if (t === "powershell@2" || t === "bash@3") {
      const inline = (inp("targetType") ?? "filePath").toLowerCase() === "inline";
      const kind: StepKind = t === "bash@3" ? "bash" : String(ci(inputs, "pwsh")).toLowerCase() === "true" ? "pwsh" : "powershell";
      return named(kind, { task, scriptPath: inline ? undefined : inp("filePath"), inline: inline ? (inp("script") ?? "") : undefined, arguments: inline ? undefined : inp("arguments"), workingDirectory: wd }, dflt);
    }
    if (t === "cmdline@2") return named("script", { task, inline: inp("script") ?? "", workingDirectory: wd }, dflt);
    return named("other", { task, cannot: `task ${task} does not run on a PC` }, dflt);
  }
  const kindKey = ["checkout", "download", "downloadBuild", "getPackage", "publish", "reviewApp"].find((k) => s[k] !== undefined);
  const what = kindKey ? `${kindKey}: ${asStr(s[kindKey])}` : Object.keys(s)[0] ?? "step";
  return named("other", { cannot: `${kindKey ?? "this kind of"} step does not run on a PC` }, kindKey === "checkout" ? `Checkout ${asStr(s.checkout)}` : what);
}

/** Resolves `${{ parameters.name }}` in a scope: passed value (itself expanded in the parent), declared default, parent. */
export function paramIn(scope: ParamScope, name: string, root: (name: string) => string | undefined, expandIn: (text: string, scope: ParamScope) => string | undefined): string | undefined {
  if (Object.prototype.hasOwnProperty.call(scope.passed, name)) {
    const raw = asStr(scope.passed[name]) ?? "";
    return scope.parent ? expandIn(raw, scope.parent) : raw;
  }
  if (!scope.parent) {
    const r = root(name);
    if (r !== undefined) return r;
  }
  if (Object.prototype.hasOwnProperty.call(scope.defaults, name) && scope.defaults[name] !== undefined && scope.defaults[name] !== null) return asStr(scope.defaults[name]);
  return undefined;
}

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { levelOf, norm, type Level, type PreflightConfig } from "./config.js";
import type { PipelineStep } from "./pipelineYaml.js";

/**
 * What changed in the pipeline since the team filled its lists, and since the last run on this PC: unknown steps,
 * listed names that are gone, a step that looks renamed (same script and arguments), and a changed script of a
 * read/apply step. The last seen fingerprints live in a small state file in the scratch area (never committed).
 */
export interface Fingerprint {
  /** kind, task, script path, arguments, env names and inline text: what makes a step the same step */
  sig: string;
  /** hash of the script content (file or inline) */
  content: string;
}

export interface State {
  version: 1;
  steps: Record<string, { name: string } & Fingerprint>;
  /** write call sites per read step (text search), as accepted */
  writes: Record<string, string[]>;
  setup: Record<string, string>;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export function fingerprint(step: PipelineStep, content: string | undefined): Fingerprint {
  const sig = hash(JSON.stringify([step.kind, (step.task ?? "").toLowerCase(), step.scriptPath ?? "", step.arguments ?? "", Object.keys(step.env).sort(), step.inline ?? ""]));
  return { sig, content: hash(content ?? step.inline ?? "") };
}

export const stateFile = (base: string) => join(base, "state.json");

export function readState(base: string): State {
  try {
    const s = JSON.parse(readFileSync(stateFile(base), "utf8")) as Partial<State>;
    return { version: 1, steps: s.steps ?? {}, writes: s.writes ?? {}, setup: s.setup ?? {} };
  } catch {
    return { version: 1, steps: {}, writes: {}, setup: {} };
  }
}

export function writeState(base: string, s: State): void {
  try {
    mkdirSync(base, { recursive: true });
    writeFileSync(stateFile(base), JSON.stringify(s, null, 1), "utf8");
  } catch {
    /* the state is a convenience */
  }
}

export interface Drift {
  /** runnable steps in no list */
  unknown: string[];
  /** listed names that are not in the YAML */
  missing: string[];
  renamed: { from: string; to: string }[];
  /** read/apply steps whose script changed since the last run here */
  changed: string[];
}

export const isRunnable = (s: PipelineStep) => s.kind !== "other";

/** Drift of the YAML against the lists and the state. `prints` gives each step's fingerprint. */
export function driftOf(steps: PipelineStep[], cfg: PreflightConfig, state: State, prints: Map<PipelineStep, Fingerprint>): Drift {
  const names = new Set(steps.map((s) => norm(s.name)));
  const unknown = steps.filter((s) => isRunnable(s) && !levelOf(cfg, s.name) && s.enabled).map((s) => s.name);
  const listed = [...cfg.steps.local, ...cfg.steps.read, ...cfg.steps.apply, ...cfg.steps.skip];
  const missing = [...new Set(listed.filter((n) => !names.has(norm(n))))];
  const renamed: Drift["renamed"] = [];
  for (const u of unknown) {
    const step = steps.find((s) => s.name === u)!;
    const fp = prints.get(step);
    const was = Object.values(state.steps).find((x) => fp && x.sig === fp.sig && missing.some((m) => norm(m) === norm(x.name)));
    if (was) renamed.push({ from: was.name, to: u });
  }
  const changed: string[] = [];
  for (const s of steps) {
    const l = levelOf(cfg, s.name);
    if (l !== "read" && l !== "apply") continue;
    const before = state.steps[norm(s.name)];
    const fp = prints.get(s);
    if (before && fp && before.content !== fp.content) changed.push(s.name);
  }
  return { unknown, missing, renamed, changed };
}

/** The state after a run: the fingerprints of every step seen now (renamed and changed steps are mentioned only once). */
export function rememberSteps(state: State, steps: PipelineStep[], prints: Map<PipelineStep, Fingerprint>): void {
  for (const s of steps) {
    const fp = prints.get(s);
    if (fp) state.steps[norm(s.name)] = { name: s.name, ...fp };
  }
}

// ---- write-call scan of read steps ------------------------------------------------------------------------------------

const WRITE_CALL = [
  /\brequests\.(post|put|patch|delete)\s*\(/i,
  /\.(post|put|patch|delete)\s*\(\s*(f?["']|url|uri|endpoint|path|`)/i,
  /\bmethod\s*[=:]\s*["'](post|put|patch|delete)["']/i,
  /\brequest\s*\(\s*["'](post|put|patch|delete)["']/i,
  /-Method\s+["']?(post|put|patch|delete)\b/i,
  /\bcurl\b[^\n]*\s-X\s*["']?(post|put|patch|delete)\b/i,
  /\baz\s+rest\b[^\n]*--method\s+["']?(post|put|patch|delete)\b/i,
];

/** Local modules a Python script imports (one level): `import a.b`, `from a.b import c`, `from . import x`. */
export function localImports(file: string, text: string, root: string): string[] {
  const out = new Set<string>();
  const dir = dirname(file);
  const tryMod = (mod: string, base: string) => {
    const p = mod.replace(/^\.+/, "").split(".").filter(Boolean).join("/");
    if (!p) return;
    for (const cand of [join(base, `${p}.py`), join(base, p, "__init__.py")]) {
      const r = relative(root, cand);
      if (!r.startsWith("..") && existsSync(cand)) out.add(resolve(cand));
    }
  };
  for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+([\w\s,()*]+)/gm)) {
    const bases = m[1].startsWith(".") ? [dir] : [dir, root];
    for (const b of bases) {
      tryMod(m[1], b);
      for (const name of m[2].replace(/[()]/g, "").split(",").map((x) => x.trim().split(/\s+/)[0]).filter((x) => x && x !== "*")) tryMod(`${m[1].replace(/^\.+$/, "")}.${name}`, b);
    }
  }
  for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) for (const mod of m[1].split(",")) for (const b of [dir, root]) tryMod(mod.trim(), b);
  out.delete(resolve(file));
  return [...out];
}

/** Write call sites (`file: line`) in a script and, for Python, the local modules it imports. A text search, not a guarantee. */
export function writeCalls(file: string, root: string, read: (f: string) => string | undefined = (f) => (existsSync(f) ? readFileSync(f, "utf8") : undefined)): string[] {
  const text = read(file);
  if (text === undefined) return [];
  const files = [file, ...(/\.py$/i.test(file) ? localImports(file, text, root) : [])];
  const out = new Set<string>();
  for (const f of files) {
    const t = f === file ? text : read(f);
    if (!t) continue;
    const rel = relative(root, f).replace(/\\/g, "/");
    for (const line of t.split("\n")) {
      const l = line.trim();
      if (!l || l.startsWith("#") || l.startsWith("//")) continue;
      if (WRITE_CALL.some((re) => re.test(l))) out.add(`${rel}: ${l.slice(0, 160)}`);
    }
  }
  return [...out].sort();
}

export const levelName = (l: Level | "skip" | undefined) => l ?? "unknown";

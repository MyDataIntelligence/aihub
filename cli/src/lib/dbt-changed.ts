import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "./context.js";
import { normalizedCopy } from "./dbt-eol.js";
import { filesImpact, stateImpact, type Impact } from "./dbt-impact.js";
import { loadManifest } from "./dbt-manifest.js";
import { dbtRunner, resolveProject, selectedTarget, type Project, type Runner } from "./dbt-run.js";
import { AihubError } from "./errors.js";
import { findProjects } from "./fabric-dbt.js";
import { git, gitRaw } from "./git.js";
import { changedFiles, resolveBase } from "./testChanged.js";

/** The dbt side of a branch: which nodes it changes (from the files, or from dbt's state:modified against a base manifest). */

function idsFrom(runner: Runner, select: string, stateDir: string, projectDir: string, profilesDir?: string): string[] {
  const prof = profilesDir ? ["--profiles-dir", profilesDir] : [];
  const r = runner.raw(["ls", "--select", select, "--state", stateDir, "--output", "json", "--output-keys", "unique_id", "--project-dir", projectDir, ...prof], 300_000);
  if (r.status !== 0) throw new AihubError(`dbt ls --select ${select} --state ${stateDir} failed (exit ${r.status}): ${(r.stdout + r.stderr).split("\n").slice(-6).join(" ").slice(0, 300)}`);
  const ids: string[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const id = JSON.parse(line).unique_id;
      if (typeof id === "string") ids.push(id);
    } catch {
      /* a log line */
    }
  }
  return ids;
}

export interface StateSide {
  /** folder with the base manifest */
  stateDir: string;
  /** the working project with normalised line endings: dbt compares this one against stateDir */
  curDir: string;
  cleanup: () => void;
}

/**
 * The two sides of a state comparison, both with LF endings and no trailing whitespace (see dbt-eol.ts). With `stateDir` given
 * (a production manifest from the pipeline) only the working project is copied; otherwise the merge base is checked out in a
 * temporary worktree without autocrlf, copied and parsed (`dbt deps` first when it has packages).
 */
export function stateSides(p: Project, runner: Runner, base: string, stateDir?: string): StateSide {
  const tmp = mkdtempSync(join(tmpdir(), "aihub-dbtbase-"));
  const wt = join(tmp, "wt");
  let worktree = false;
  const cleanup = () => {
    if (worktree) gitRaw(p.root, ["worktree", "remove", "--force", wt]);
    rmSync(tmp, { recursive: true, force: true });
  };
  try {
    const curDir = join(tmp, "cur");
    normalizedCopy(p.dir, curDir);
    if (stateDir) return { stateDir, curDir, cleanup };
    const add = gitRaw(p.root, ["-c", "core.autocrlf=false", "worktree", "add", "--detach", wt, base]);
    if (add.status !== 0) throw new AihubError(`cannot check out the merge base ${base.slice(0, 7)}: ${add.stderr?.trim()}`);
    worktree = true;
    const rel = p.dir.slice(p.root.length).replace(/^[\\/]+/, "");
    const baseDir = join(tmp, "base");
    normalizedCopy(join(wt, rel), baseDir);
    const state = join(tmp, "state");
    const prof = existsSync(join(p.dir, "profiles.yml")) ? ["--profiles-dir", p.dir] : [];
    if (existsSync(join(baseDir, "packages.yml"))) runner.raw(["deps", "--project-dir", baseDir, ...prof], 300_000);
    const r = runner.raw(["parse", "--project-dir", baseDir, ...prof, "--target-path", state], 300_000);
    if (r.status !== 0) throw new AihubError(`dbt parse of the merge base failed (exit ${r.status}): ${(r.stdout + r.stderr).split("\n").slice(-6).join(" ").slice(0, 300)}`);
    return { stateDir: state, curDir, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

export interface ImpactOpts {
  base?: string;
  /** a folder with the base manifest, or "auto": parse the merge base in a temporary worktree */
  state?: string;
}

export function projectImpact(ctx: Ctx, p: Project, o: ImpactOpts): Impact {
  const { target, base } = resolveBase(ctx, p.root, o.base);
  const runner = dbtRunner(ctx, p);
  const m = loadManifest(p, runner);
  const meta = { project: p.info.name, baseRef: target, base: base.slice(0, 7) };
  if (o.state) {
    const side = stateSides(p, runner, base, o.state === "auto" ? undefined : o.state);
    try {
      const prof = existsSync(join(p.dir, "profiles.yml")) ? p.dir : undefined;
      const modified = idsFrom(runner, "state:modified", side.stateDir, side.curDir, prof);
      const plus = idsFrom(runner, "state:modified+", side.stateDir, side.curDir, prof);
      return stateImpact(m, modified, plus, { ...meta, stateDir: o.state === "auto" ? `the merge base ${meta.base}` : o.state });
    } finally {
      side.cleanup();
    }
  }
  const rel = p.info.path === "." ? "" : `${p.info.path}/`;
  const inProject = changedFiles(p.root, base)
    .filter((f) => f.startsWith(rel))
    .map((f) => f.slice(rel.length));
  const removed = git(p.root, ["diff", "--name-only", "--diff-filter=D", base], { allowFail: true })
    .split("\n")
    .filter((f) => f.startsWith(rel) && /\.(sql|py)$/i.test(f))
    .map((f) => f.slice(rel.length).replace(/^.*\//, "").replace(/\.\w+$/, ""));
  return filesImpact({
    m,
    changed: inProject,
    removed,
    yml: (f) => ({ before: git(p.root, ["show", `${base}:${rel}${f}`], { allowFail: true }) || undefined, after: existsSync(join(p.dir, f)) ? readFileSync(join(p.dir, f), "utf8") : undefined }),
    ...meta,
  });
}

// ---- aihub test changed ------------------------------------------------------------------------------------------------

export interface DbtTestsConfig {
  /** template with {select}, {project} and {state}; replaces the default `aihub dbt build ...` */
  command?: string;
  /** build (default): models and their tests; test: only the tests */
  mode?: "build" | "test";
  /** folder with the production manifest: select state:modified+ and defer to it */
  state?: string;
}

export interface DbtPlan {
  project: string;
  route: "warehouse" | "lakehouse" | "other";
  changed: string[];
  downstream: number;
  selector: string[];
  command?: string;
  /** a Fabric project needs a workspace; the command is shown but never run by --run */
  needsWorkspace: boolean;
  notes: string[];
}

const q = (s: string) => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/** One plan per dbt project the branch touches. Never throws for a project dbt cannot parse: the plan carries the reason. */
export function dbtPlans(ctx: Ctx, root: string, changed: string[], base: string, target: string, cfg: DbtTestsConfig): DbtPlan[] {
  const out: DbtPlan[] = [];
  const projects = findProjects(root).filter((pr) => changed.some((f) => pr.path === "." || f.startsWith(`${pr.path}/`)));
  for (const info of projects) {
    const c = { ...ctx, cwd: join(root, info.path) } as Ctx;
    let p: Project;
    try {
      p = resolveProject(c, info.path === "." ? undefined : join(root, info.path));
    } catch (e) {
      out.push({ project: info.path, route: "other", changed: [], downstream: 0, selector: [], needsWorkspace: false, notes: [(e as Error).message] });
      continue;
    }
    const sel = selectedTarget(ctx, p);
    try {
      const impact = projectImpact(ctx, p, { base: target });
      const names = impact.changed.map((x) => x.name);
      const words = cfg.state ? ["state:modified+"] : impact.selector;
      const select = words.join(" ");
      const stateFlags = cfg.state ? ` --state ${q(cfg.state)} --defer` : "";
      const verb = cfg.mode === "test" ? "test" : "build";
      const proj = info.path === "." ? "" : ` --project ${q(info.path)}`;
      let command: string | undefined;
      const notes = [...impact.notes];
      const needsWorkspace = sel.route !== "other" && verb === "build";
      if (words.length && !impact.projectWide.length) {
        if (cfg.command) command = cfg.command.replace(/\{select\}/g, select).replace(/\{project\}/g, info.path).replace(/\{state\}/g, cfg.state ?? "");
        else if (needsWorkspace) command = `aihub fabric dbt run --workspace <workspace> --command build --select ${q(select)}${proj}`;
        else command = `aihub dbt ${verb} --select ${q(select)}${stateFlags}${proj}`;
      }
      if (needsWorkspace && !cfg.command) notes.push(`the target is a Fabric ${sel.route}: the build needs its workspace (the developer's DEV or FEATURE workspace); --run does not run it`);
      out.push({ project: info.path, route: sel.route, changed: names, downstream: impact.downstream.length, selector: words, command, needsWorkspace: needsWorkspace && !cfg.command, notes });
    } catch (e) {
      out.push({ project: info.path, route: sel.route, changed: [], downstream: 0, selector: [], needsWorkspace: false, notes: [`dbt impact not computed: ${(e as Error).message.split("\n")[0]}`] });
    }
  }
  void base;
  return out;
}

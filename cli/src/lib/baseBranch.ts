import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { git, hasRef, originDefaultBranch } from "./git.js";
import { defaultTargetFor, type TeamConfig } from "./team.js";
import { missingSetting } from "./team-guide.js";

/**
 * The branch a feature branch was cut from, when team.yaml does not name the target: local git only (no fetch).
 * Candidates: origin/HEAD, the protected branches of team.yaml, the upstream (branch.<b>.merge) and what the reflogs
 * say ("branch: Created from X", "checkout: moving from X to <b>"). The winner is the candidate whose merge-base with
 * HEAD is closest to HEAD (fewest commits of HEAD after it), then whose tip is least ahead of that merge-base.
 * A tie, or no merge-base at all, is not guessed: MissingTeamSetting (exit 3) before anything is created.
 */
export interface DerivedTarget {
  target: string;
  /** "default branch" when only origin/HEAD was a candidate, else "branch point" */
  how: "branch point" | "default branch";
}

const KEY = "repositories[0].defaultTarget";
const HINT = " (or pass --target <branch> for this one call)";
const cacheFile = (env: NodeJS.ProcessEnv) => join(env.AIHUB_HOME || join(homedir(), ".aihub"), "base-branch.json");

function readCache(env: NodeJS.ProcessEnv): Record<string, DerivedTarget> {
  try {
    return JSON.parse(readFileSync(cacheFile(env), "utf8")) as Record<string, DerivedTarget>;
  } catch {
    return {};
  }
}

function lastMatch(text: string, re: RegExp): string | undefined {
  let found: string | undefined;
  for (const l of text.split("\n")) {
    const m = re.exec(l.trim());
    if (m) found = m[1];
  }
  return found;
}

/** Branch names (without origin/) that local knowledge says this branch came from. */
function localOrigins(root: string, branch: string): string[] {
  const out: string[] = [];
  const merge = git(root, ["config", "--get", `branch.${branch}.merge`], { allowFail: true }).trim().replace(/^refs\/heads\//, "");
  if (merge) out.push(merge);
  // oldest entry of the branch's own reflog: "branch: Created from origin/develop"
  const created = lastMatch(git(root, ["log", "-g", "--format=%gs", `refs/heads/${branch}`], { allowFail: true }), /^branch: Created from (\S+)$/);
  if (created && created !== "HEAD") out.push(created.replace(/^(refs\/remotes\/)?origin\//, "").replace(/^refs\/heads\//, ""));
  // the HEAD reflog when the branch was first checked out: "checkout: moving from develop to feature/1-x"
  const esc = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const moved = lastMatch(git(root, ["log", "-g", "--format=%gs", "-n", "500", "HEAD"], { allowFail: true }), new RegExp(`^checkout: moving from (\\S+) to ${esc}$`));
  if (moved) out.push(moved);
  return [...new Set(out)].filter((b) => b !== branch && !/^[0-9a-f]{7,40}$/.test(b));
}

/** [commits of the candidate after the merge-base, commits of HEAD after it]; undefined without a merge-base. */
function distance(root: string, ref: string): [number, number] | undefined {
  const out = git(root, ["rev-list", "--left-right", "--count", `${ref}...HEAD`], { allowFail: true }).trim();
  const m = /^(\d+)\s+(\d+)$/.exec(out);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/**
 * The target of `branch` (checked out in `root`): team.yaml when it names one (no git call), else derived.
 * undefined: no local candidate at all (the caller falls back to the remote default).
 */
export function targetFor(ctx: { env: NodeJS.ProcessEnv }, root: string, branch: string, team: TeamConfig, repo: string): DerivedTarget | { target: string; how: "team.yaml" } | undefined {
  const set = defaultTargetFor(team, repo);
  if (set) return { target: set, how: "team.yaml" };
  return deriveTarget(ctx, root, branch, team);
}

export function deriveTarget(ctx: { env: NodeJS.ProcessEnv }, root: string, branch: string, team: TeamConfig): DerivedTarget | undefined {
  const head = git(root, ["rev-parse", "HEAD"], { allowFail: true }).trim();
  const id = `${root}#${branch}#${head}`;
  const cached = readCache(ctx.env)[id];
  if (cached) return cached;
  const def = originDefaultBranch(root);
  const local = localOrigins(root, branch);
  const names = [...new Set([def, ...(team.branches?.protected ?? []).filter((p) => !/[*?]/.test(p)), ...local].filter((b) => b && b !== branch))];
  const scored = names
    .map((name) => {
      const ref = hasRef(root, `origin/${name}`) ? `origin/${name}` : hasRef(root, name) ? name : undefined;
      const d = ref ? distance(root, ref) : undefined;
      return d && ref ? { name, ref, behind: d[0], ahead: d[1], local: local.includes(name) } : undefined;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (!scored.length) {
    if (def) throw missingSetting(KEY, names, HINT); // origin/HEAD exists but shares no history with this branch
    return undefined;
  }
  scored.sort((a, b) => a.ahead - b.ahead || a.behind - b.behind);
  const best = scored.filter((s) => s.ahead === scored[0].ahead && s.behind === scored[0].behind);
  let win = best.length === 1 ? best[0] : best.filter((s) => s.local).length === 1 ? best.find((s) => s.local) : undefined;
  if (!win) throw missingSetting(KEY, best.map((s) => s.name), HINT);
  // the closest candidate shares no history with HEAD: then none does (rev-list counts work without a merge-base)
  if (!git(root, ["merge-base", win.ref, "HEAD"], { allowFail: true }).trim()) throw missingSetting(KEY, scored.map((s) => s.name), HINT);
  const result: DerivedTarget = { target: win.name, how: scored.length === 1 && win.name === def ? "default branch" : "branch point" };
  try {
    const all = readCache(ctx.env);
    const keep = Object.fromEntries(Object.entries(all).slice(-200));
    mkdirSync(join(cacheFile(ctx.env), ".."), { recursive: true });
    writeFileSync(cacheFile(ctx.env), JSON.stringify({ ...keep, [id]: result }), "utf8");
  } catch {
    /* only costs a later call */
  }
  return result;
}

/** The note on a result line, when the target was not given and not in team.yaml. */
export const derivedNote = (t: { target: string; how: string } | undefined): string => (t && t.how === "branch point" ? `target: ${t.target} (derived from the branch point)` : "");

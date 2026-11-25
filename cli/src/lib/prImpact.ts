import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Ctx } from "./context.js";
import { repoClient } from "./context.js";
import { findRepoEntry, isGitDir, repoNameAt } from "./crossRepo.js";
import { git, currentBranch, mergeBase, repoRoot } from "./git.js";
import { globMatch } from "./glob.js";
import { isActionHeading, isNothing } from "./prActions.js";
import { repoDefaultBranch } from "./ado.js";
import { parseSections } from "./templates.js";
import { loadTeam, type TeamConfig } from "./team.js";
import { targetFor } from "./baseBranch.js";

/** team.yaml pullRequest.userImpact: who the action section is for, what their contract is, where their files live. */
export interface UserImpactConfig {
  audience?: string;
  contractPaths?: string[];
  userFiles?: { repository?: string; paths?: string[] }[];
}

export interface FileChange {
  file: string;
  status: "added" | "modified" | "deleted";
  /** YAML/JSON files only */
  added?: string[];
  removed?: string[];
}
export interface KeyUse {
  key: string;
  files: string[];
  count: number;
}
export interface Impact {
  base: string;
  audience?: string;
  contract: FileChange[];
  uses: { repo: string; keys: KeyUse[] }[];
  notSearched: string[];
}

const MAX_NAMES = 20;
const MAX_KEYS = 8;

/** All key paths that hold a value (objects and arrays are walked; arrays count as `path[]`). */
export function flattenKeys(v: unknown, prefix = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) {
    if (!v.length && prefix) out.add(prefix);
    for (const x of v) flattenKeys(x, `${prefix}[]`, out);
  } else if (v && typeof v === "object") {
    const e = Object.entries(v as Record<string, unknown>);
    if (!e.length && prefix) out.add(prefix);
    for (const [k, x] of e) flattenKeys(x, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out.add(prefix);
  return out;
}

function keysOf(file: string, text: string | undefined): Set<string> | undefined {
  if (text === undefined) return new Set();
  try {
    if (/\.json$/i.test(file)) return flattenKeys(JSON.parse(text));
    if (/\.ya?ml$/i.test(file)) return flattenKeys(parseYaml(text));
  } catch {
    return undefined;
  }
  return undefined;
}

const leafOf = (key: string) => key.replace(/\[\]$/, "").split(".").pop()!.replace(/\[\]/g, "");

/** Changed files under contractPaths between the merge base and HEAD, with the key diff for YAML and JSON. */
export function contractChanges(root: string, base: string, contractPaths: string[]): FileChange[] {
  const out: FileChange[] = [];
  const raw = git(root, ["diff", "--name-status", "--no-renames", base, "HEAD"], { allowFail: true });
  for (const line of raw.split("\n")) {
    const [s, ...p] = line.split("\t");
    const file = p.join("\t").trim();
    if (!file || !contractPaths.some((g) => globMatch(g, file))) continue;
    const status = s.startsWith("A") ? "added" : s.startsWith("D") ? "deleted" : "modified";
    const c: FileChange = { file, status };
    const before = status === "added" ? undefined : git(root, ["show", `${base}:${file}`], { allowFail: true });
    const after = status === "deleted" ? undefined : git(root, ["show", `HEAD:${file}`], { allowFail: true });
    const a = keysOf(file, before);
    const b = keysOf(file, after);
    if (a && b) {
      c.removed = [...a].filter((k) => !b.has(k)).sort();
      c.added = [...b].filter((k) => !a.has(k)).sort();
    }
    out.push(c);
  }
  return out;
}

/** A local clone of `repository`: this repo, the entry's path, or a sibling directory. Anything else is not searched. */
function localClone(root: string, team: TeamConfig, repository: string | undefined): string | undefined {
  if (!repository) return root;
  const here = repoNameAt(root);
  if (here === repository.toLowerCase()) return root;
  const entry = findRepoEntry(team, repository);
  const name = entry?.name ?? repository;
  if (entry?.path) {
    const p = isAbsolute(entry.path) ? entry.path : resolve(root, entry.path);
    return isGitDir(p) ? p : undefined;
  }
  const sib = join(dirname(root), name);
  return isGitDir(sib) ? sib : undefined;
}

/** Key used as a key: `leaf:` in YAML or `"leaf":` in JSON. */
const usedAs = (leaf: string) => new RegExp(`(^|[\\s"'{,\\-])${leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*:`, "m");

export function userFileUses(dir: string, paths: string[], keys: string[], skip: Set<string>): KeyUse[] {
  const files = git(dir, ["ls-files"], { allowFail: true })
    .split("\n")
    .filter((f) => f && !skip.has(f) && paths.some((g) => globMatch(g, f)));
  const texts = files.map((f) => {
    try {
      return { f, t: readFileSync(join(dir, f), "utf8") };
    } catch {
      return { f, t: "" };
    }
  });
  const out: KeyUse[] = [];
  for (const k of keys) {
    const re = usedAs(leafOf(k));
    const hit = texts.filter((x) => re.test(x.t)).map((x) => x.f);
    if (hit.length) out.push({ key: k, files: hit.slice(0, MAX_NAMES), count: hit.length });
  }
  return out;
}

export function computeImpact(root: string, base: string, team: TeamConfig): Impact | undefined {
  const cfg = team.pullRequest?.userImpact;
  if (!cfg?.contractPaths?.length) return undefined;
  const contract = contractChanges(root, base, cfg.contractPaths);
  const changedHere = new Set(contract.map((c) => c.file));
  const removed = [...new Set(contract.flatMap((c) => c.removed ?? []))];
  const uses: Impact["uses"] = [];
  const notSearched: string[] = [];
  if (removed.length) {
    for (const u of cfg.userFiles ?? []) {
      const label = u.repository ?? "this repository";
      const dir = localClone(root, team, u.repository);
      if (!dir) {
        notSearched.push(`${label} (no local clone)`);
        continue;
      }
      const keys = userFileUses(dir, u.paths ?? [], removed, dir === root ? changedHere : new Set());
      if (keys.length) uses.push({ repo: label, keys });
    }
  }
  return { base, audience: cfg.audience, contract, uses, notSearched };
}

const more = (xs: string[], n: number) => xs.slice(0, n).map((x) => `\`${x}\``).join(", ") + (xs.length > n ? ` and ${xs.length - n} more` : "");

export function impactText(i: Impact): string {
  const lines: string[] = [];
  if (i.audience) lines.push(`Audience: ${i.audience}`);
  if (!i.contract.length) lines.push("Contract unchanged: no file under contractPaths changed. Nothing for the users to do.");
  else {
    lines.push(`Contract changed (${i.contract.length} file${i.contract.length === 1 ? "" : "s"} since ${i.base.slice(0, 8)}):`);
    for (const c of i.contract.slice(0, MAX_NAMES)) {
      const d = [c.removed?.length ? `removed ${more(c.removed, MAX_KEYS)}` : "", c.added?.length ? `added ${more(c.added, MAX_KEYS)}` : ""].filter(Boolean).join("; ");
      const rename = c.removed?.length === 1 && c.added?.length === 1 ? " (renamed?)" : "";
      lines.push(`- ${c.file} (${c.status})${d ? `: ${d}${rename}` : ""}`);
    }
    if (i.contract.length > MAX_NAMES) lines.push(`- and ${i.contract.length - MAX_NAMES} more files`);
  }
  for (const u of i.uses) {
    for (const k of u.keys) lines.push(`Still used in ${u.repo}: \`${k.key}\` in ${k.count} file${k.count === 1 ? "" : "s"}: ${more(k.files, MAX_NAMES)}`);
  }
  if (i.notSearched.length) lines.push(`Not searched: ${i.notSearched.join(", ")}`);
  return lines.join("\n");
}

export async function prImpact(ctx: Ctx, o: { target?: string; json?: boolean }): Promise<string> {
  const root = repoRoot(ctx.cwd);
  const team = loadTeam(root);
  if (!team.pullRequest?.userImpact?.contractPaths?.length) {
    return o.json ? JSON.stringify({ configured: false }) : "no pullRequest.userImpact.contractPaths in team.yaml: the platform contract is not defined; describe the user actions from the diff.";
  }
  const branch = currentBranch(root);
  let target = o.target;
  if (!target) {
    const derived = targetFor(ctx, root, branch, team, repoNameAt(root) ?? "");
    target = derived?.target ?? (await repoDefaultBranch(repoClient(ctx).client)) ?? "main";
  }
  const impact = computeImpact(root, mergeBase(root, target), team)!;
  return o.json ? JSON.stringify({ configured: true, ...impact }) : impactText(impact);
}

/** Warning for the result line of `pr create`: the contract changed but an action section says there is nothing to do. */
export function impactWarning(root: string, base: string, team: TeamConfig, description: string): string | undefined {
  if (!team.pullRequest?.userImpact?.contractPaths?.length) return undefined;
  const empty = team.pullRequest?.emptySection;
  const nothing = parseSections(description).sections.find((s) => isActionHeading(s.heading, team.pullRequest?.actionSections) && isNothing(s.body.replace(/<!--[\s\S]*?-->/g, "").trim(), empty));
  if (!nothing) return undefined;
  const i = computeImpact(root, base, team);
  if (!i?.contract.length) return undefined;
  return `warning: '${nothing.heading}' says there is nothing to do, but the platform contract changed (${i.contract.map((c) => c.file).slice(0, 3).join(", ")}${i.contract.length > 3 ? ", ..." : ""}); run 'aihub pr impact'`;
}

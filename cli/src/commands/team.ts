import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { repoRoot } from "../lib/git.js";
import { loadTeam, TEAM_FILE } from "../lib/team.js";
import { detectAll } from "../lib/team-detect.js";
import { effective, parseValue, proposalYaml, questions, setKey, specOf, writeProposal, type Effective, type Question } from "../lib/team-guide.js";
import { teamLearn } from "../lib/teamLearn.js";

export const TEAM_USAGE = [
  "aihub team setup [--refresh] [--json]   (detects what it can, writes a proposed team.yaml when there is none, lists only the open questions)",
  "aihub team set <key> <value>   (changes one key, keeps comments; lists: a,b)",
  "aihub team show [--missing] [--json]   (effective values with their source: team.yaml, detected, default)",
  'aihub team learn "<one sentence rule>" [--rule-file <file>] [--json]   (adds it to the team guidelines through a pull request)',
].join("\n");

const short = (v: unknown): string => {
  if (v === undefined) return "-";
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? (x as { name?: string }).name ?? "?" : String(x))).join(",");
  return String(v);
};

const LABEL: Record<string, string> = {
  "azureDevOps.organization": "org",
  "azureDevOps.project": "project",
  "repositories[0].name": "repo",
  "repositories[0].defaultTarget": "target",
  "repositories[0].releaseBranches": "release",
  "pullRequest.template": "PR template",
  "workItems.storyType": "story type",
  "workItems.states.active": "start state",
  "workItems.states.finished": "finish state",
  "branches.feature": "branch pattern",
  "branches.protected": "protected",
  pipelines: "pipelines",
  "fabric.workspaces": "Fabric",
};

export function formatQuestions(qs: Question[]): string[] {
  if (!qs.length) return ["no open questions"];
  return ["ask the user, then run the command with the answer:", ...qs.map((q, i) => `${i + 1}. ${q.text} ${q.choices.join(" | ")} -> ${q.command}`)];
}

/** aihub team setup|set|show|learn */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === "learn") {
    const p = parse(rest, { "rule-file": { type: "string" }, json: { type: "boolean" } }, true);
    const rule = p.values["rule-file"] ? readFileSync(p.values["rule-file"], "utf8") : p.positionals.join(" ");
    return void ctx.out(await teamLearn(ctx, { rule, json: p.values.json }));
  }
  if (sub === "set") {
    const [key, ...value] = rest;
    if (!key || !value.length) throw new AihubError("usage: aihub team set <key> <value>   (e.g. aihub team set workItems.states.active Doing)");
    const root = repoRoot(ctx.cwd);
    const v = parseValue(key, value);
    const r = setKey(root, key, v);
    return void ctx.out(`${key}: ${short(r.before)} -> ${short(v)} (${TEAM_FILE}; propose it with 'aihub init' or a pull request)`);
  }
  if (sub === "setup") {
    const p = parse(rest, { refresh: { type: "boolean" }, json: { type: "boolean" } });
    return void ctx.out((await setup(ctx, { refresh: !!p.values.refresh, json: !!p.values.json })).join("\n"));
  }
  if (sub === "show") {
    const p = parse(rest, { missing: { type: "boolean" }, json: { type: "boolean" } });
    const root = repoRoot(ctx.cwd);
    const eff = effective(loadTeam(root), await detectAll(ctx, root));
    const qs = questions(eff, 99);
    const list = p.values.missing ? eff.filter((e) => e.source === "missing" || qs.some((q) => q.key === e.key)) : eff;
    if (p.values.json) return void ctx.out(JSON.stringify({ values: list, questions: qs }));
    for (const e of list) ctx.out(`${e.key} = ${short(e.value)}  (${sourceText(e)})`);
    if (p.values.missing && !list.length) ctx.out("nothing missing");
    return;
  }
  throw new AihubError(`usage: ${TEAM_USAGE.split("\n").map((l) => l.replace(/ {3}\(.*$/, "")).join(" | ")}`);
}

const sourceText = (e: Effective) => (e.source === "detected" ? `detected, ${e.confidence}: ${e.detail}` : e.source);

/**
 * aihub team setup (also `aihub init` without team.yaml): one compact report of what was detected, a proposed team.yaml
 * when the repository has none (never overwriting one), and only the questions aihub cannot answer itself.
 */
export async function setup(ctx: Ctx, o: { refresh?: boolean; json?: boolean; answered?: Record<string, unknown> } = {}): Promise<string[]> {
  const root = repoRoot(ctx.cwd);
  const file = join(root, TEAM_FILE);
  const had = existsSync(file);
  const team = loadTeam(root);
  const found = await detectAll(ctx, root, { refresh: o.refresh, storyType: team.workItems?.storyType });
  const eff = effective(team, found).map((e) => (o.answered && o.answered[e.key] !== undefined ? { ...e, value: o.answered[e.key], source: "team.yaml" as const } : e));
  const qs = questions(eff);
  if (!had) writeProposal(root, proposalYaml(eff));
  if (o.json) return [JSON.stringify({ file: TEAM_FILE, written: !had, values: eff, questions: qs })];
  const detected = eff
    .filter((e) => e.source === "detected" && e.confidence === "sure")
    .map((e) => `${LABEL[e.key] ?? e.key} ${short(e.value)}`)
    .join(", ");
  const lines = [
    had ? `${TEAM_FILE}: exists, kept as is` : `${TEAM_FILE}: none, wrote a proposal (not committed)`,
    `detected: ${detected || "nothing (no remote or no sign-in)"}`,
  ];
  const defaults = eff.filter((e) => e.source === "default" && !qs.some((q) => q.key === e.key) && specOf(e.key)?.ask);
  if (defaults.length) lines.push(`defaults: ${defaults.map((e) => `${LABEL[e.key] ?? e.key} ${short(e.value)}`).join(", ")}`);
  lines.push(...formatQuestions(qs));
  if (!had) lines.push("then: aihub init   (proposes the team pack as a pull request)");
  return lines;
}

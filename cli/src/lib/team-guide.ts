import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMap, isNode, isSeq, parse, parseDocument, type Document } from "yaml";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { packRoot } from "./pack.js";
import { requiredPaths, validateTeam } from "./schema.js";
import { loadTeam, readUtf8, TEAM_FILE, type TeamConfig } from "./team.js";
import { detectKey, type Detection } from "./team-detect.js";
import { trace } from "./trace.js";

/** Exit code of a command that stopped because one team setting is unclear: the agent asks the user one question. */
export const MISSING_SETTING_EXIT = 3;

/** First line of a team.yaml that aihub proposed and nobody committed yet. */
export const PROPOSAL_MARK = "# Proposed by 'aihub init'";

/** A team setting aihub cannot know for sure. Thrown BEFORE anything is created or changed. */
export class MissingTeamSetting extends AihubError {
  readonly exitCode = MISSING_SETTING_EXIT;
  constructor(
    readonly key: string,
    readonly choices: string[],
    hint = "",
  ) {
    super(`missing team setting ${key}${choices.length ? ` (found: ${choices.join(", ")})` : ""}: ask the user, then run: aihub team set ${key} "<value>"${hint}`);
    this.name = "MissingTeamSetting";
  }
}

export const missingSetting = (key: string, choices: string[] = [], hint = "") => new MissingTeamSetting(key, choices, hint);

export interface KeySpec {
  key: string;
  /** what the CLI uses when nothing is set or detected */
  default?: unknown;
  /** the question for the user, when the value is a guess */
  ask?: string;
  /** a list value: `team set` splits on commas */
  list?: boolean;
  /** asked even when nothing was detected (the default is only a guess) */
  askWhenUnknown?: boolean;
  /** fixed choices, when detection finds none */
  choices?: string[];
}

/** The keys aihub helps fill, in the order of team.yaml. Everything else in the schema stays optional and is edited by hand. */
export const KEYS: KeySpec[] = [
  { key: "language", default: "en", ask: "Language of stories, PR text and comments?", askWhenUnknown: true, choices: ["nl", "en"] },
  { key: "azureDevOps.organization" },
  { key: "azureDevOps.project" },
  { key: "repositories[0].name" },
  { key: "repositories[0].defaultTarget", default: "main", ask: "Branch a new pull request targets?" },
  { key: "repositories[0].releaseBranches", list: true, ask: "Release branch patterns (for cherry-pick and release)?" },
  { key: "pullRequest.template", default: ".azuredevops/pull_request_template.md" },
  { key: "workItems.storyType", default: "User Story", ask: "Work item type of a story?" },
  { key: "workItems.states.active", default: "Active", ask: "State of a story you start?" },
  { key: "workItems.states.finished", default: "Done", ask: "State of a story you finish?" },
  { key: "branches.feature", default: "feature/{storyId}-{slug}", ask: "Pattern of a story branch?" },
  { key: "branches.protected", list: true, ask: "Branches the CLI may never push to?" },
  { key: "pipelines" },
  { key: "fabric.workspaces" },
];

export const specOf = (key: string): KeySpec | undefined => KEYS.find((k) => k.key === key);

/** "repositories[0].name" -> ["repositories", 0, "name"] */
export function pathOf(key: string): (string | number)[] {
  return key.split(".").flatMap((s) => {
    const m = /^([^[]+)\[(\d+)\]$/.exec(s);
    return m ? [m[1], Number(m[2])] : [s];
  });
}

export function getIn(obj: unknown, key: string): unknown {
  let v: unknown = obj;
  for (const p of pathOf(key)) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string | number, unknown>)[p];
  }
  return v === "" || (Array.isArray(v) && !v.length) ? undefined : v;
}

export type Source = "team.yaml" | "detected" | "default" | "missing";
export interface Effective {
  key: string;
  value: unknown;
  source: Source;
  /** where a detected value came from, and whether it is sure */
  detail?: string;
  confidence?: "sure" | "guess";
  choices?: string[];
}

/** The value aihub uses per key: team.yaml first, then a sure or guessed detection, then the default. */
export function effective(team: TeamConfig, found: Detection[]): Effective[] {
  return KEYS.map((k) => {
    const set = getIn(team, k.key);
    if (set !== undefined) return { key: k.key, value: set, source: "team.yaml" };
    const d = found.find((x) => x.key === k.key);
    if (d) return { key: k.key, value: d.value, source: "detected", detail: d.source, confidence: d.confidence, choices: d.choices };
    if (k.default !== undefined) return { key: k.key, value: k.default, source: "default", choices: k.choices };
    return { key: k.key, value: undefined, source: "missing" };
  });
}

export interface Question {
  key: string;
  text: string;
  choices: string[];
  command: string;
}

const show = (v: unknown): string => (Array.isArray(v) ? v.map((x) => (typeof x === "object" ? (x as { name?: string }).name ?? JSON.stringify(x) : String(x))).join(",") : String(v));

/** Only what aihub cannot know for sure: guesses, and the keys whose default is only a guess. At most `max`. */
export function questions(eff: Effective[], max = 5): Question[] {
  const out: Question[] = [];
  for (const e of eff) {
    const spec = specOf(e.key);
    if (!spec?.ask) continue;
    const unsure = (e.source === "detected" && e.confidence === "guess") || (e.source === "default" && spec.askWhenUnknown);
    if (!unsure) continue;
    const choices = [...new Set([show(e.value), ...(e.choices?.length ? e.choices : spec.choices ?? [])])]; // the proposed value first
    out.push({ key: e.key, text: spec.ask, choices, command: `aihub team set ${e.key} ${quote(choices[0])}` });
  }
  return out.slice(0, max);
}

const quote = (v: string) => (/^[\w./*{}-]+$/.test(v) ? v : `"${v.replace(/"/g, '\\"')}"`);

/**
 * The one helper commands use for a team setting: team.yaml, else a SURE detection (used silently), else the default
 * when nothing could be detected. A guess (several candidates) throws MissingTeamSetting before anything is changed.
 */
export async function teamSetting(ctx: Ctx, root: string, key: string, team: TeamConfig = loadTeam(root)): Promise<string> {
  const set = getIn(team, key);
  if (set !== undefined) return String(set);
  const storyType = key.startsWith("workItems.states.") ? (getIn(team, "workItems.storyType") as string | undefined) : undefined;
  const d = await detectKey(ctx, root, key, { storyType });
  if (d?.confidence === "sure") return String(d.value);
  if (d) throw missingSetting(key, d.choices ?? [show(d.value)]);
  const def = specOf(key)?.default;
  if (def !== undefined) return String(def);
  throw missingSetting(key);
}

/** Parses a value given on the command line for a key. */
export function parseValue(key: string, raw: string[]): unknown {
  const text = raw.join(" ").trim();
  if (!text) throw new AihubError(`aihub team set ${key} needs a value`);
  if (/^[[{]/.test(text)) return parse(text);
  if (specOf(key)?.list) return text.split(",").map((s) => s.trim()).filter(Boolean);
  if (/^(true|false)$/.test(text)) return text === "true";
  return text;
}

const schemaRequired = () => requiredPaths(readFileSync(join(packRoot(), "skills", "_shared", "references", "team.schema.yaml"), "utf8"));

/**
 * Sets one key in team.yaml and keeps every comment and the order of the other keys. The file must be valid YAML;
 * a schema problem the change introduces is refused (problems that were already there are left alone).
 */
export function setKey(root: string, key: string, value: unknown): { file: string; before: unknown } {
  if (/token|secret|password|pat$/i.test(key)) throw new AihubError("secrets never go into team.yaml: use the credential store (aihub fabric auth sp add, az login)");
  const file = join(root, TEAM_FILE);
  if (!existsSync(file)) throw new AihubError(`${TEAM_FILE} not found: run 'aihub team setup' first`);
  const doc = parseDocument(readUtf8(file));
  if (doc.errors.length) throw new AihubError(`${TEAM_FILE} is not valid YAML: ${doc.errors[0].message.split("\n")[0]}`);
  const path = pathOf(key);
  for (let i = 1; i < path.length; i++) {
    const parent = doc.getIn(path.slice(0, i), true);
    if (parent !== undefined && !isMap(parent) && !isSeq(parent)) throw new AihubError(`${path.slice(0, i).join(".")} is not a section in ${TEAM_FILE}`);
  }
  const before = doc.getIn(path);
  const required = schemaRequired();
  const was = validateTeam(doc.toJS(), required);
  setKeep(doc, path, value);
  const now = validateTeam(doc.toJS(), required).filter((p) => !was.includes(p));
  if (now.length) throw new AihubError(`not set: ${now.join("; ")}`);
  writeFileSync(file, String(doc), "utf8");
  return { file, before: before && typeof before === "object" ? JSON.parse(JSON.stringify(before)) : before };
}

/** Sets a value and keeps the comment of the node it replaces (a scalar keeps its node, so its comment stays by itself). */
function setKeep(doc: Document, path: (string | number)[], value: unknown): void {
  if (value === null || typeof value !== "object") return void doc.setIn(path, value);
  const old = doc.getIn(path, true);
  const node = doc.createNode(value, { flow: Array.isArray(value) && value.every((x) => typeof x !== "object") });
  if (isNode(old)) {
    node.comment = old.comment;
    node.commentBefore = old.commentBefore;
  }
  doc.setIn(path, node);
}

/** A new team.yaml from the team-pack example with the effective values filled in; the comments stay. */
export function proposalYaml(eff: Effective[]): string {
  const src = readUtf8(join(packRoot(), "team-pack", TEAM_FILE));
  const doc = parseDocument(src);
  const val = (k: string) => eff.find((e) => e.key === k)?.value;
  const language = String(val("language") ?? "en");
  for (const e of eff) {
    if (e.value === undefined || e.key === "fabric.workspaces") continue;
    setKeep(doc, pathOf(e.key), e.value);
  }
  setKeep(doc, ["repositories", 0, "aliases"], []);
  if (val("repositories[0].releaseBranches") === undefined) doc.deleteIn(["repositories", 0, "releaseBranches"]);
  doc.setIn(["pullRequest", "emptySection"], language === "nl" ? "n.v.t." : "-");
  if (val("branches.protected") === undefined) doc.setIn(["branches", "protected"], doc.createNode([val("repositories[0].defaultTarget") ?? "main"]));
  if (val("pipelines") === undefined) doc.deleteIn(["pipelines"]);
  const ws = val("fabric.workspaces");
  if (ws !== undefined) setKeep(doc, ["fabric", "workspaces"], ws);
  doc.deleteIn(["guidelines"]);
  doc.deleteIn(["cherryPick"]);
  return `${PROPOSAL_MARK} (aihub team setup): check every value; 'aihub init' proposes it to the team as a pull request.\n` + String(doc).replace(/^# Team file for aihub\.[^\n]*\n(# Full schema[^\n]*\n)?/, "# One line of explanation per key; schema: docs/team-yaml.md in the aihub repository.\n");
}

export function writeProposal(root: string, text: string): string {
  const file = join(root, TEAM_FILE);
  if (trace.dryRun) {
    trace.plan(`would write ${file}`);
    return file;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  return file;
}

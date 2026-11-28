import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clientDirs } from "./clients.js";
import { configHome } from "./configHome.js";
import type { Result } from "./install.js";
import { trace } from "./trace.js";

/**
 * opencode asks for permission before a tool reads a file outside the project, and `opencode run` (no terminal)
 * rejects that and ends the turn. The skills read their templates next to SKILL.md in the global skills folder, so
 * `aihub skills install --client opencode` allows `external_directory` for that folder only (never a global allow).
 */
const FILES = ["opencode.json", "opencode.jsonc"];

export interface PermissionState {
  file: string;
  pattern: string;
  /** every folder aihub allows (skills, proposals) */
  patterns: string[];
  /** allowed: our patterns (or a global allow) are in place; missing: not all yet; unreadable: the file has comments or invalid JSON */
  state: "allowed" | "missing" | "unreadable";
}

const slash = (p: string) => p.replace(/\\/g, "/");

export function skillsPattern(skillsDir: string): string {
  return `${slash(skillsDir).replace(/\/$/, "")}/**`;
}

/**
 * The folders outside a project that the aihub skills and prompts use: the skills themselves (templates next to
 * SKILL.md), and the proposals the agent writes for the story browser or the user to apply (/story-criteria,
 * /story-refine, a draft). Without these rules opencode asks for every write there, and `opencode run` refuses it.
 */
export function aihubPatterns(env: NodeJS.ProcessEnv): string[] {
  // the aihub config folder of this env (HOME/USERPROFILE of the env, as clientDirs does, so an isolated home stays isolated)
  const home = env.HOME || env.USERPROFILE;
  const aihubHome = env.AIHUB_CONFIG_HOME || env.XDG_CONFIG_HOME || !home ? configHome(env) : join(home, ".config", "aihub");
  return [skillsPattern(clientDirs("opencode", env, { global: true }).skills), `${slash(join(aihubHome, "stories", "proposals"))}/**`];
}

export function configFile(env: NodeJS.ProcessEnv): string {
  const dir = join(clientDirs("opencode", env, { global: true }).skills, "..");
  for (const f of FILES) if (existsSync(join(dir, f))) return join(dir, f);
  return join(dir, FILES[0]);
}

type Json = Record<string, unknown>;

function readConfig(file: string): Json | undefined | "unreadable" {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  if (!text.trim()) return undefined;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : "unreadable";
  } catch {
    return "unreadable"; // comments or trailing commas: editing would lose them, so we do not touch it
  }
}

const extOf = (cfg: Json): unknown => (cfg.permission as Json | undefined)?.external_directory;

export function permissionState(env: NodeJS.ProcessEnv): PermissionState {
  const file = configFile(env);
  const patterns = aihubPatterns(env);
  const pattern = patterns[0];
  const cfg = readConfig(file);
  if (cfg === "unreadable") return { file, pattern, patterns, state: "unreadable" };
  const ext = cfg ? extOf(cfg) : undefined;
  const allowed = ext === "allow" || (!!ext && typeof ext === "object" && patterns.every((p) => (ext as Json)[p] === "allow"));
  return { file, pattern, patterns, state: allowed ? "allowed" : "missing" };
}

/** Adds `permission.external_directory["<skills>/**"] = "allow"`, keeping every other key (a string value becomes the "*" rule). */
export function ensureSkillsPermission(env: NodeJS.ProcessEnv): Result {
  const s = permissionState(env);
  const path = `${s.file} permission.external_directory`;
  if (s.state === "allowed") return { action: "unchanged", path };
  if (s.state === "unreadable") {
    return { action: "skipped", path, reason: `${s.file} has comments or is not plain JSON; add "permission": {"external_directory": {${s.patterns.map((p) => `"${p}": "allow"`).join(", ")}}} yourself` };
  }
  if (trace.dryRun) {
    trace.plan(`would allow external_directory ${s.patterns.join(", ")} in ${s.file}`);
    return { action: "created", path };
  }
  const existed = existsSync(s.file);
  const cfg = (readConfig(s.file) as Json | undefined) ?? { $schema: "https://opencode.ai/config.json" };
  const perm: Json = { ...((cfg.permission as Json | undefined) ?? {}) };
  const cur = perm.external_directory;
  const rules: Json = typeof cur === "string" ? { "*": cur } : { ...((cur as Json | undefined) ?? {}) };
  for (const p of s.patterns) rules[p] = "allow";
  perm.external_directory = rules;
  cfg.permission = perm;
  writeFileSync(s.file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return { action: existed ? "updated" : "created", path };
}

/** Removes only the rule aihub added. */
export function removeSkillsPermission(env: NodeJS.ProcessEnv): Result {
  const file = configFile(env);
  const patterns = aihubPatterns(env);
  const path = `${file} permission.external_directory`;
  const cfg = readConfig(file);
  if (!cfg || cfg === "unreadable") return { action: cfg === "unreadable" ? "skipped" : "unchanged", path, reason: cfg === "unreadable" ? "not plain JSON" : undefined };
  if (trace.dryRun) return { action: "removed", path };
  const ext = extOf(cfg);
  if (!ext || typeof ext !== "object" || !patterns.some((p) => (ext as Json)[p] === "allow")) return { action: "unchanged", path };
  const rules = { ...(ext as Json) };
  for (const p of patterns) delete rules[p];
  const perm = { ...(cfg.permission as Json) };
  if (Object.keys(rules).length) perm.external_directory = rules;
  else delete perm.external_directory;
  if (Object.keys(perm).length) cfg.permission = perm;
  else delete cfg.permission;
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return { action: "removed", path };
}

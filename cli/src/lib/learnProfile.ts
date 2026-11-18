import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { repoRoot } from "./git.js";
import { learnHome } from "./learnStore.js";
import { loadTeam } from "./team.js";

/** Your learning level and whether a lesson is offered after a PR. Personal (in the learn store); team.yaml may set the default of afterPr. */
export const LEVELS = ["junior", "medior", "senior"] as const;
export type Level = (typeof LEVELS)[number];

export interface Profile {
  level: Level;
  /** What the skill does with the level: the style of the lesson. */
  style: string;
  afterPr: boolean;
  afterPrSource: "user" | "team" | "default";
}

const STYLE: Record<Level, string> = {
  junior: "explain every term, use an everyday analogy, go step by step, keep the quiz easy and say why each answer is right",
  medior: "assume the basics, explain the design choices and the trade-offs, link to who is affected",
  senior: "be brief: what changed, why, the risks and the alternatives; skip explanations of basics",
};

const file = (ctx: Ctx) => join(learnHome(ctx.env), "profile.json");

function read(ctx: Ctx): { level?: Level; afterPr?: boolean } {
  try {
    return JSON.parse(readFileSync(file(ctx), "utf8"));
  } catch {
    return {};
  }
}

function write(ctx: Ctx, p: { level?: Level; afterPr?: boolean }) {
  mkdirSync(learnHome(ctx.env), { recursive: true });
  writeFileSync(file(ctx), JSON.stringify(p, null, 2), "utf8");
}

function teamAfterPr(ctx: Ctx): boolean | undefined {
  try {
    const t = loadTeam(repoRoot(ctx.cwd)) as { learn?: { afterPr?: boolean } };
    return typeof t.learn?.afterPr === "boolean" ? t.learn.afterPr : undefined;
  } catch {
    return undefined;
  }
}

export function profile(ctx: Ctx): Profile {
  const p = read(ctx);
  const level: Level = p.level && LEVELS.includes(p.level) ? p.level : "medior";
  const team = teamAfterPr(ctx);
  const afterPr = typeof p.afterPr === "boolean" ? p.afterPr : (team ?? false);
  return { level, style: STYLE[level], afterPr, afterPrSource: typeof p.afterPr === "boolean" ? "user" : team !== undefined ? "team" : "default" };
}

export function setLevel(ctx: Ctx, level: string): Profile {
  if (!LEVELS.includes(level as Level)) throw new AihubError(`level must be one of ${LEVELS.join(", ")}`);
  write(ctx, { ...read(ctx), level: level as Level });
  return profile(ctx);
}

export function setAfterPr(ctx: Ctx, on: boolean): Profile {
  write(ctx, { ...read(ctx), afterPr: on });
  return profile(ctx);
}

/** The one line after `pr create` / `story finish`; empty unless afterPr is on (off by default). */
export function afterPrOffer(ctx: Ctx): string {
  try {
    if (!existsSync(learnHome(ctx.env)) && teamAfterPr(ctx) === undefined) return "";
    return profile(ctx).afterPr ? "Wil je een les van deze wijziging? Zeg /leer (of: aihub learn change --json)." : "";
  } catch {
    return "";
  }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "./configHome.js";

/**
 * The stories this PC has seen (id, title, state), kept in `<config home>/stories.json` so the menus can name a story
 * and know it is closed without a call to Azure DevOps. Written whenever stories were read anyway.
 * Node only: the VS Code extension bundles this file as it is.
 */
export interface SeenStory {
  id: number;
  title: string;
  state?: string;
  at: number;
}

const FILE = "stories.json";
const MAX = 200;
export const CLOSED_STATES = ["closed", "done", "resolved", "removed", "completed"];

export const isClosedState = (state: string | undefined): boolean => !!state && CLOSED_STATES.includes(state.toLowerCase());

export function readSeenStories(env: NodeJS.ProcessEnv): Record<number, SeenStory> {
  try {
    const f = join(configHome(env), FILE);
    if (!existsSync(f)) return {};
    const j = JSON.parse(readFileSync(f, "utf8")) as { stories?: SeenStory[] };
    return Object.fromEntries((j.stories ?? []).filter((s) => s && typeof s.id === "number").map((s) => [s.id, s]));
  } catch {
    return {};
  }
}

/** Adds or updates the given stories (newest read wins); keeps the last MAX seen. */
export function rememberStories(env: NodeJS.ProcessEnv, stories: { id: number; title: string; state?: string }[], now = Date.now()): void {
  if (!stories.length) return;
  const all = readSeenStories(env);
  for (const s of stories) all[s.id] = { id: s.id, title: s.title || all[s.id]?.title || "", ...(s.state ? { state: s.state } : all[s.id]?.state ? { state: all[s.id].state } : {}), at: now };
  const list = Object.values(all).sort((a, b) => b.at - a.at).slice(0, MAX);
  const dir = configHome(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE), JSON.stringify({ schema: 1, stories: list }, null, 2), "utf8");
}

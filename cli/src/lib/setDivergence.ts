import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "./configHome.js";

/**
 * A story set against the branches the story links in Azure DevOps (the Development links are the truth): where the
 * set is on another branch than the story links, the user is told once, with three choices. Pure comparison plus a
 * small "already told" memory in the config home. Node only: the VS Code extension bundles this file as it is.
 */
export interface LinkedRow {
  repo: string;
  branch: string;
  /** where the link is: in Azure DevOps (Development), only locally, or both */
  linked: "ado" | "local" | "both" | "name";
  status?: "current" | "old" | "parked";
  lastActive?: string;
}

export interface Divergence {
  repo: string;
  /** the branch the set has checked out */
  current: string;
  /** the branch the story links: the star, else the most recently active */
  linked: string;
}

const rank = (s: LinkedRow["status"]) => (s === "current" ? 0 : s === "parked" ? 1 : 2);

/** Per repository of the set: the set is on a branch the story does not link, while the story links another one there. */
export function divergences(set: { name: string; branch: string }[], rows: LinkedRow[]): Divergence[] {
  const out: Divergence[] = [];
  for (const r of set) {
    const links = rows.filter((x) => x.repo === r.name && (x.linked === "ado" || x.linked === "both"));
    if (!links.length || links.some((x) => x.branch === r.branch)) continue;
    const best = [...links].sort((a, b) => rank(a.status) - rank(b.status) || (b.lastActive ?? "").localeCompare(a.lastActive ?? ""))[0];
    out.push({ repo: r.name, current: r.branch, linked: best.branch });
  }
  return out;
}

/** The same divergence has the same key, so it is told once. */
export const divergenceKey = (story: number, d: Divergence[]): string => `${story}|${d.map((x) => `${x.repo}:${x.current}>${x.linked}`).sort().join(",")}`;

/** The notification's words: names the story, the repository and both branches. */
export function divergenceMessage(story: number, d: Divergence[]): string {
  if (d.length === 1) return `Story #${story} links another branch: ${d[0].repo} is on ${d[0].current}. The story links ${d[0].linked}.`;
  return `Story #${story} links other branches: ${d.map((x) => `${x.repo} is on ${x.current} (the story links ${x.linked})`).join("; ")}.`;
}

const FILE = "divergence-seen.json";

export function seenDivergence(env: NodeJS.ProcessEnv, key: string): boolean {
  try {
    const f = join(configHome(env), FILE);
    return existsSync(f) && ((JSON.parse(readFileSync(f, "utf8")) as { keys?: string[] }).keys ?? []).includes(key);
  } catch {
    return false;
  }
}

/** Remembers (at most 100) that this divergence was shown and answered. */
export function markDivergenceSeen(env: NodeJS.ProcessEnv, key: string): void {
  let keys: string[] = [];
  const f = join(configHome(env), FILE);
  try {
    if (existsSync(f)) keys = (JSON.parse(readFileSync(f, "utf8")) as { keys?: string[] }).keys ?? [];
  } catch {
    keys = [];
  }
  if (keys.includes(key)) return;
  mkdirSync(configHome(env), { recursive: true });
  writeFileSync(f, JSON.stringify({ schema: 1, keys: [...keys, key].slice(-100) }, null, 2), "utf8");
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "./configHome.js";

/**
 * What was open last, sets and single repositories in one list, newest first: `<config home>/recent.json`. One file
 * for every window and for the CLI (`aihub recent`), so a new VS Code window can go back to where the last one was.
 * Node only: the VS Code extension bundles this file as it is (no process).
 */
export interface RecentUse {
  kind: "set" | "repo";
  /** a set: its workspace file (else its folder); a repository: its folder */
  id: string;
  label: string;
  detail?: string;
  story?: number;
  lastUsed: string;
}

export const MAX_RECENT_USE = 30;
const FILE = "recent.json";

/** The same path in another case or slash style is the same item. */
export const pathKey = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function readRecentUse(env: NodeJS.ProcessEnv): RecentUse[] {
  try {
    const f = join(configHome(env), FILE);
    if (!existsSync(f)) return [];
    const j = JSON.parse(readFileSync(f, "utf8")) as { items?: unknown };
    return Array.isArray(j.items) ? (j.items as RecentUse[]).filter((i) => i && (i.kind === "set" || i.kind === "repo") && typeof i.id === "string" && typeof i.lastUsed === "string") : [];
  } catch {
    return [];
  }
}

/** Newest first, no doubles, at most MAX_RECENT_USE. Pure. */
export function withUse(items: RecentUse[], item: Omit<RecentUse, "lastUsed">, now: number): RecentUse[] {
  const entry: RecentUse = { ...item, lastUsed: new Date(now).toISOString() };
  return [entry, ...items.filter((i) => pathKey(i.id) !== pathKey(item.id))].slice(0, MAX_RECENT_USE);
}

function write(env: NodeJS.ProcessEnv, items: RecentUse[]): void {
  const dir = configHome(env);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ schema: 1, items }, null, 2), "utf8");
  renameSync(tmp, join(dir, FILE));
}

/** A window that stays open writes nothing: the same item at the top within a minute is left alone. */
export function rememberUse(env: NodeJS.ProcessEnv, item: Omit<RecentUse, "lastUsed">, now = Date.now()): void {
  const old = readRecentUse(env);
  const top = old[0];
  if (top && pathKey(top.id) === pathKey(item.id) && top.label === item.label && top.detail === item.detail && now - Date.parse(top.lastUsed) < 60_000) return;
  write(env, withUse(old, item, now));
}

export function forgetUse(env: NodeJS.ProcessEnv, id: string): void {
  const old = readRecentUse(env);
  const next = old.filter((i) => pathKey(i.id) !== pathKey(id));
  if (next.length !== old.length) write(env, next);
}

/** "3 h ago", "yesterday", "5 d ago". */
export function ago(iso: string, now: number): string {
  const min = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} d ago`;
}

export function formatRecent(items: RecentUse[], now: number): string {
  if (!items.length) return "nothing recent yet";
  return items.map((i) => `${i.kind === "set" ? "set " : "repo"}  ${i.label}${i.detail ? `  (${i.detail})` : ""}  ${ago(i.lastUsed, now)}  ${i.id}`).join("\n");
}

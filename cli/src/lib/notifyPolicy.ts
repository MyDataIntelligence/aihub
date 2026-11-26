import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "./configHome.js";
import { AihubError } from "./errors.js";
import { parseDuration } from "./pipeline.js";

/**
 * How loud the background watchers are. One user-level setting file, never inside a work repository:
 * `<config home>/watch.json` = { notify: all|needed|off, quietUntil }. `toast-state.json` remembers the last toast, so
 * there is never more than one toast per TOAST_GAP_MS; what arrives in between waits for the next toast (and is in
 * `aihub watch events` anyway).
 */
export type NotifyMode = "all" | "needed" | "off";
export const NOTIFY_MODES: NotifyMode[] = ["all", "needed", "off"];
export const TOAST_GAP_MS = 2 * 60_000;
const MAX_HELD = 20;

export { configHome };

export interface WatchConfig {
  notify: NotifyMode;
  /** epoch ms; no toast before this */
  quietUntil?: number;
}

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = (env: NodeJS.ProcessEnv, name: string, value: unknown) => {
  const dir = configHome(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2), "utf8");
};

export function readWatchConfig(env: NodeJS.ProcessEnv): WatchConfig {
  const c = readJson<Partial<WatchConfig>>(join(configHome(env), "watch.json"), {});
  return { notify: NOTIFY_MODES.includes(c.notify as NotifyMode) ? (c.notify as NotifyMode) : "needed", quietUntil: typeof c.quietUntil === "number" ? c.quietUntil : undefined };
}

export function setNotifyMode(env: NodeJS.ProcessEnv, mode: string): WatchConfig {
  if (!NOTIFY_MODES.includes(mode as NotifyMode)) throw new AihubError(`--notify must be one of ${NOTIFY_MODES.join(", ")}`);
  const c = { ...readWatchConfig(env), notify: mode as NotifyMode };
  writeJson(env, "watch.json", c);
  return c;
}

/** `1h`, `90m` (from now) or `18:00` (today, else tomorrow) as an epoch time. */
export function quietUntilOf(spec: { for?: string; until?: string }, now: number): number {
  if (spec.for) return now + parseDuration(spec.for, 0, { flag: "--for", unitRequired: true });
  const m = /^(\d{1,2}):(\d{2})$/.exec((spec.until ?? "").trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new AihubError("--until needs a time like 18:00");
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function setQuiet(env: NodeJS.ProcessEnv, until: number | undefined): WatchConfig {
  const c = { ...readWatchConfig(env), quietUntil: until };
  writeJson(env, "watch.json", c);
  return c;
}

// ---- deciding and bundling toasts ---------------------------------------------------------------------

export interface ToastItem {
  message: string;
  /** Pull request number, when the item is about one: items of one PR are summed up in a bundle. */
  pr?: number;
  /** Short word for the bundle ("comment", "review gevraagd", ...). */
  what?: string;
  /** Needs a reaction from me (mention, review asked, reply to me, my red build). The default `needed` mode toasts only these. */
  needed: boolean;
  label?: string;
  url: string;
}

interface ToastState {
  last: number;
  held: ToastItem[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "3 nieuwe dingen" text: per PR "!42 2 comments", other things "review gevraagd op !51" or the clipped message. */
export function bundleText(items: ToastItem[]): { title: string; body: string } {
  if (items.length === 1) return { title: "aihub", body: items[0].message };
  const comments = new Map<number, number>();
  const parts: string[] = [];
  for (const i of items) {
    if (i.pr && (i.what ?? "comment") === "comment") comments.set(i.pr, (comments.get(i.pr) ?? 0) + 1);
    else parts.push(i.pr && i.what ? `${i.what} op !${i.pr}` : clip(i.message, 60));
  }
  const all = [...[...comments].map(([pr, n]) => `!${pr} ${n} comment${n > 1 ? "s" : ""}`), ...parts];
  const shown = all.slice(0, 4).join(" · ");
  return { title: `aihub · ${items.length} nieuwe dingen`, body: all.length > 4 ? `${shown} · +${all.length - 4} meer` : shown };
}

export interface ToastSink {
  (title: string, message: string, action: { label: string; url: string; secondary?: { label: string; url: string } }): boolean | Promise<boolean>;
}

export const QUIET_URL = "aihub://quiet?for=1h";

export interface DeliverResult {
  /** items that were put in a toast */
  shown: ToastItem[];
  /** items that waited for the next toast (the gap) */
  held: number;
  /** items the setting or quiet time keeps out of the toast */
  skipped: number;
  /** items whose toast could not be shown (the caller prints them) */
  failed: ToastItem[];
}

/**
 * Applies `watch.notify`, quiet time and the 2 minute gap to the items of ONE poll round and shows at most one toast.
 * `bundle: false` is for the single result of a run or PR the developer asked to follow: no gap, never held.
 */
export async function deliver(env: NodeJS.ProcessEnv, now: number, sink: ToastSink, items: ToastItem[], o: { bundle: boolean }): Promise<DeliverResult> {
  const cfg = readWatchConfig(env);
  const none: DeliverResult = { shown: [], held: 0, skipped: items.length, failed: [] };
  if (cfg.notify === "off" || (cfg.quietUntil !== undefined && now < cfg.quietUntil)) return none;
  const wanted = cfg.notify === "all" ? items : items.filter((i) => i.needed);
  const skipped = items.length - wanted.length;
  const stateFile = "toast-state.json";
  const state = readJson<ToastState>(join(configHome(env), stateFile), { last: 0, held: [] });
  let batch = wanted;
  if (o.bundle) {
    if (!wanted.length && !state.held.length) return { ...none, skipped };
    if (now - state.last < TOAST_GAP_MS) {
      state.held = [...state.held, ...wanted].slice(-MAX_HELD);
      writeJson(env, stateFile, state);
      return { shown: [], held: wanted.length, skipped, failed: [] };
    }
    batch = [...state.held, ...wanted];
  }
  if (!batch.length) return { ...none, skipped };
  const { title, body } = bundleText(batch);
  const first = batch[0];
  const ok = await sink(title, body, { label: first.label ?? "Open", url: first.url, secondary: { label: "Stil 1 uur", url: QUIET_URL } });
  writeJson(env, stateFile, { last: now, held: [] } satisfies ToastState);
  return { shown: ok ? batch : [], held: 0, skipped, failed: ok ? [] : batch };
}

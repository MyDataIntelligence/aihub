import { inflateRawSync } from "node:zlib";
import type { Ctx } from "./context.js";

/**
 * The developer's own iDiagram app: `POST /api/v1/import` turns a Mermaid flowchart into a board and its link. A 1:1 port
 * of the legacy IDiagramClient (extensions tag legacy/hub-surface-v2-2026-11-17). No key and no account; the board travels
 * in the link's `#board=` fragment, so the server keeps nothing. Only the Mermaid source (and the scenes) are sent, never
 * the explanation or files. Base URL: AIHUB_IDIAGRAM_URL, else the default app.
 */
export const IDIAGRAM_APP = "https://idiagram.vercel.app";
const MAX_LINK = 1_500_000;
const MAX_BOARD = 2_000_000;
const MAX_ANSWER = 200_000;
const MAX_SCENES = 12;

export interface IDiagramResult {
  /** created | unsupported (flowcharts only) | skipped | failed */
  status: "created" | "unsupported" | "skipped" | "failed";
  url: string;
  playUrl: string;
  nodes: number;
  edges: number;
  scenes: number;
  storyWarnings: string[];
  storyInLink: boolean;
  boardName: string;
  reason: string;
}

const empty = (status: IDiagramResult["status"], reason = ""): IDiagramResult => ({ status, url: "", playUrl: "", nodes: 0, edges: 0, scenes: 0, storyWarnings: [], storyInLink: false, boardName: "", reason });

export const appOf = (env: NodeJS.ProcessEnv): string => (env.AIHUB_IDIAGRAM_URL?.trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "") || IDIAGRAM_APP);
export const apiOf = (env: NodeJS.ProcessEnv): string => `${appOf(env)}/api/v1`;

/** Only https links of the app itself (or of a local `idiagram serve`). */
export function trusted(url: string, env: NodeJS.ProcessEnv): boolean {
  let u: URL;
  let app: URL;
  try {
    u = new URL(url);
    app = new URL(appOf(env));
  } catch {
    return false;
  }
  const local = app.hostname === "localhost" || app.hostname === "127.0.0.1";
  return u.protocol === app.protocol && u.host === app.host && !u.username && (u.protocol === "https:" || local);
}

/** The board file a `#board=` link carries (base64url of deflate-raw JSON); undefined when unreadable. */
export function boardOf(url: string): { board?: { name?: string; story?: unknown } } | undefined {
  try {
    const packed = url.split("#board=")[1]?.split("&")[0] ?? "";
    if (!packed || packed.length > MAX_LINK) return undefined;
    const raw = inflateRawSync(Buffer.from(packed.replace(/-/g, "+").replace(/_/g, "/"), "base64"), { maxOutputLength: MAX_BOARD });
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
}

export interface Story {
  title: string;
  scenes: { title: string; narration: string; nodes: string[] }[];
}

/** A story from a flowchart: the whole flow, then one scene per changed block (`:::changed`), in the order they appear. */
export function storyFor(mermaid: string, title: string, dutch = true): Story | undefined {
  if (!/^\s*(flowchart|graph)\b/i.test(mermaid)) return undefined;
  const ids: { id: string; label: string; changed: boolean }[] = [];
  for (const m of mermaid.matchAll(/\b([A-Za-z_][\w]*)\s*(?:\[\s*"?([^\]"]+)"?\s*\]|\(\s*"?([^)"]+)"?\s*\)|\{\s*"?([^}"]+)"?\s*\})(:::changed)?/g)) {
    if (!ids.some((x) => x.id === m[1])) ids.push({ id: m[1], label: (m[2] ?? m[3] ?? m[4] ?? m[1]).trim(), changed: !!m[5] });
  }
  if (!ids.length) return undefined;
  const scenes: Story["scenes"] = [{ title: dutch ? "De hele flow" : "The whole flow", narration: dutch ? "Zo loopt het van begin tot eind." : "How it runs from start to end.", nodes: ["*"] }];
  for (const c of ids.filter((x) => x.changed).slice(0, MAX_SCENES - 2)) scenes.push({ title: c.label, narration: dutch ? `Dit deel is veranderd: ${c.label}.` : `This part changed: ${c.label}.`, nodes: [c.id] });
  return { title, scenes: scenes.slice(0, MAX_SCENES) };
}

/** The import answer (status code and body) as a result; a link outside the iDiagram app is refused. */
export function parseAnswer(status: number, text: string, env: NodeJS.ProcessEnv): IDiagramResult {
  let root: Record<string, any> | undefined;
  try {
    root = JSON.parse(text);
  } catch {
    root = undefined;
  }
  if (status < 200 || status > 299 || !root) {
    const message = root?.error?.message ?? root?.message;
    return empty("failed", `iDiagram answered ${status}${message ? `: ${String(message).slice(0, 200)}` : ""}`);
  }
  const url = typeof root.link?.url === "string" ? root.link.url : "";
  if (!url) return empty("failed", String(root.link?.reason ?? "iDiagram returned no link").slice(0, 200));
  if (!trusted(url, env)) return empty("failed", "iDiagram returned a link outside the app");
  const warnings = ((root.issues as { code?: string; message?: string }[]) ?? []).filter((i) => (i.code ?? "").startsWith("story.")).map((i) => String(i.message ?? "").slice(0, 200));
  const play = typeof root.link?.playUrl === "string" && trusted(root.link.playUrl, env) ? root.link.playUrl : "";
  const linked = boardOf(url);
  return { status: "created", url, playUrl: play, nodes: Number(root.board?.nodes ?? 0), edges: Number(root.board?.edges ?? 0), scenes: 0, storyWarnings: warnings, storyInLink: !!linked?.board && "story" in linked.board, boardName: String(linked?.board?.name ?? ""), reason: "" };
}

/** Pushes a Mermaid flowchart (with its story) to iDiagram. Never throws: a failure is a result and the Mermaid stays. */
export async function pushToIDiagram(ctx: Ctx, o: { id: string; mermaid: string; story?: Story }): Promise<IDiagramResult> {
  if (!/^\s*(flowchart|graph)\b/i.test(o.mermaid)) return empty("unsupported", "iDiagram imports Mermaid flowcharts; this diagram stays Mermaid");
  const body: Record<string, unknown> = { text: o.mermaid, filename: `${o.id}.mmd`, outputs: ["link"], ...(o.story ? { story: o.story } : {}) };
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    const res = await ctx.fetch(`${apiOf(ctx.env)}/import?output=summary`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), redirect: "error", signal: ac.signal });
    clearTimeout(timer);
    const r = parseAnswer(res.status, (await res.text()).slice(0, MAX_ANSWER), ctx.env);
    return r.status === "created" && o.story ? { ...r, scenes: o.story.scenes.length } : r;
  } catch (e) {
    return empty("failed", `iDiagram could not be reached (${(e as Error).name})`);
  }
}

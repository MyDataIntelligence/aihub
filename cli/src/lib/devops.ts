import { trace } from "./trace.js";
import { readFileSync } from "node:fs";
import { AdoClient } from "./ado.js";
import { makeAuth } from "./auth.js";
import { resolveOrg } from "./browse/core.js";
import { remoteOf } from "./pipelineView.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { inferEnv } from "./fabric.js";
import { parseFlags } from "./cliargs.js";

/** Flags every Azure DevOps admin command accepts. */
export const COMMON_FLAGS = {
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  yes: { type: "boolean" },
  project: { type: "string" },
  top: { type: "string" },
  filter: { type: "string" },
  "allow-env": { type: "string" },
  org: { type: "string" },
} as const;

export type Flags = Record<string, string | boolean | undefined>;

export function flags(argv: string[], extra: Record<string, { type: "string" | "boolean" }>): Flags {
  return parseFlags(argv, { ...COMMON_FLAGS, ...extra });
}

/** The project client of the repository in the current folder; `--project` points it at another project of the organisation. */
export function devopsClient(ctx: Ctx, v: Flags): { client: AdoClient; root: string } {
  const project = typeof v.project === "string" && v.project ? v.project : undefined;
  const org = typeof v.org === "string" && v.org ? v.org : undefined;
  // --project outside a clone (or --org): a client of that project of the organisation, no repository
  if (project && (org || !inRepo(ctx))) {
    const o = resolveOrg(ctx, org);
    return { client: new AdoClient({ org: o, project, repo: "", orgUrl: `https://dev.azure.com/${encodeURIComponent(o)}` }, makeAuth({ env: ctx.env, exec: ctx.exec, cacheFile: ctx.tokenCache }), ctx.fetch), root: ctx.cwd };
  }
  const { client, root } = repoClient(ctx);
  return { client: project ? client.forProject(project) : client, root };
}

function inRepo(ctx: Ctx): boolean {
  try {
    remoteOf(ctx.cwd);
    return true;
  } catch {
    return false;
  }
}

export function emit(ctx: Ctx, v: Flags, data: unknown, text: string): void {
  ctx.out(v.json ? JSON.stringify(data) : text);
}

export function requireFlag(v: Flags, name: string, hint = ""): string {
  const x = v[name];
  if (typeof x !== "string" || !x.trim()) throw new AihubError(`--${name} is required${hint ? ` (${hint})` : ""}`);
  return x.trim();
}

export function top(v: Flags, fallback = 50): number {
  if (v.top === undefined) return fallback;
  const n = Number(v.top);
  if (!Number.isInteger(n) || n <= 0) throw new AihubError("--top must be a number");
  return n;
}

export function need(sub: string | undefined, allowed: string[], usage: string): string {
  if (!sub || !allowed.includes(sub)) throw new AihubError(`usage: ${usage}`);
  return sub;
}

/** Deletes need --yes (or --dry-run, which only prints). */
export function confirmDelete(v: Flags, what: string): void {
  if (!v.yes && !trace.dryRun) throw new AihubError(`deleting ${what} needs --yes (or --dry-run to see the call first)`);
}

/**
 * ACC and PRD protection for pipelines, environments, variable groups and approvals: the name decides (same words as Fabric).
 * Reads never call this. A change is refused unless --allow-env names that stage.
 */
export function guardStage(name: string, v: Flags, what: string): void {
  const env = inferEnv(name);
  if (env === "dev") return;
  const allow = typeof v["allow-env"] === "string" ? (v["allow-env"] as string).toLowerCase() : "";
  if (allow === env) return;
  const E = env.toUpperCase();
  throw new AihubError(`${what} '${name}' is ${E}: the developer runs ${E}, the CLI only changes dev and feature stages (--allow-env ${env} only when the developer asked for it)`);
}

/** The text piped to stdin (a secret value), never a command-line argument. */
export function stdinText(ctx: Ctx): string {
  return (ctx.stdin ? ctx.stdin() : readFileSync(0, "utf8")).replace(/\r?\n$/, "");
}

export function readJsonFile(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new AihubError(`cannot read ${path} as JSON: ${(e as Error).message}`);
  }
}

/** A plain aligned table; first row = header. */
export function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : (c ?? "").padEnd(widths[i]))).join("  ").trimEnd()).join("\n");
}

export function cut(s: string | undefined, n = 80): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Short ISO date. */
export function day(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

export const encode = encodeURIComponent;

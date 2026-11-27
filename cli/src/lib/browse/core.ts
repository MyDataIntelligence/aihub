import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AdoClient } from "../ado.js";
import { makeAuth } from "../auth.js";
import { configHome } from "../configHome.js";
import type { Ctx } from "../context.js";
import { AihubError } from "../errors.js";
import { remoteOf } from "../pipelineView.js";

/**
 * The repository browser: everything an Azure DevOps project or repository shows without a clone. Every read is
 * cached in the user's config folder (never in a work repository): lists with a timestamp, a tree or file at a commit
 * id for good, and the failures that stay true for a while (not signed in, no access) for 5 minutes.
 */

export type BrowseErrorKind = "signedOut" | "noAccess" | "notFound" | "searchUnavailable" | "protectedBranch" | "branchExists" | "offline" | "badInput" | "needsSetting" | "failed";

export class BrowseError extends AihubError {
  constructor(
    readonly kind: BrowseErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** The kind of a failure, from its message (the AdoClient words them). */
export function kindOf(e: unknown): BrowseErrorKind {
  if (e instanceof BrowseError) return e.kind;
  const m = String((e as Error)?.message ?? e);
  if (/not signed in|az login|AIHUB_ADO_PAT/i.test(m)) return "signedOut";
  if (/\(403\)|denied access/i.test(m)) return "noAccess";
  if (/\(404\)|not found/i.test(m)) return "notFound";
  if (/fetch failed|ENOTFOUND|ECONNRE|ETIMEDOUT|EAI_AGAIN|network/i.test(m)) return "offline";
  return "failed";
}

export const errorJson = (e: unknown) => ({ error: { kind: kindOf(e), message: String((e as Error)?.message ?? e).replace(/^aihub:\s*/, "") } });

// ---- cache -----------------------------------------------------------------------------------------------------------

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const TTL = { lists: 4 * HOUR, project: HOUR, branchRef: 2 * MIN, short: 2 * MIN, failure: 5 * MIN, forever: Number.POSITIVE_INFINITY } as const;

const cacheDir = (env: NodeJS.ProcessEnv) => join(configHome(env), "cache", "browse");
const fileOf = (env: NodeJS.ProcessEnv, key: string) => join(cacheDir(env), `${createHash("sha1").update(key.toLowerCase()).digest("hex")}.json`);

export interface Cached<T> {
  at: number;
  data: T;
}

export function cacheRead<T>(env: NodeJS.ProcessEnv, key: string, ttl: number, now: number): Cached<T> | undefined {
  try {
    const c = JSON.parse(readFileSync(fileOf(env, key), "utf8")) as Cached<T> & { key?: string };
    if (now - c.at < ttl) return { at: c.at, data: c.data };
  } catch {
    /* no entry yet */
  }
  return undefined;
}

export function cacheWrite<T>(env: NodeJS.ProcessEnv, key: string, data: T, now: number): void {
  try {
    const f = fileOf(env, key);
    mkdirSync(dirname(f), { recursive: true });
    const tmpFile = `${f}.${process.pid}.tmp`;
    writeFileSync(tmpFile, JSON.stringify({ at: now, key, data }), "utf8");
    renameSync(tmpFile, f);
  } catch {
    /* a read-only home only costs a call next time */
  }
}

export interface ReadMeta {
  readAt: string;
  cached: boolean;
}

/** Read through the cache: `work` runs only when there is no fresh entry (or `refresh`). */
export async function cached<T>(b: Browse, key: string, ttl: number, work: () => Promise<T>, keep: (data: T) => boolean = () => true): Promise<{ data: T; meta: ReadMeta }> {
  const now = b.now();
  if (!b.refresh) {
    const hit = cacheRead<T>(b.env, key, ttl, now);
    if (hit) return { data: hit.data, meta: { readAt: new Date(hit.at).toISOString(), cached: true } };
  }
  const data = await work();
  if (keep(data)) cacheWrite(b.env, key, data, now);
  return { data, meta: { readAt: new Date(now).toISOString(), cached: false } };
}

/** Failures that stay true for a while are remembered per organisation (and project), so a click does not wait on a call that cannot work. */
const REMEMBERED: BrowseErrorKind[] = ["signedOut", "noAccess", "searchUnavailable"];

export async function guarded<T>(b: Browse, scope: string, work: () => Promise<T>): Promise<T> {
  const key = `fail|${b.org}|${scope}`;
  const hit = b.refresh ? undefined : cacheRead<{ kind: BrowseErrorKind; message: string }>(b.env, key, TTL.failure, b.now());
  if (hit) throw new BrowseError(hit.data.kind, hit.data.message);
  try {
    return await work();
  } catch (e) {
    const kind = kindOf(e);
    if (REMEMBERED.includes(kind)) cacheWrite(b.env, key, { kind, message: (e as Error).message }, b.now());
    throw e instanceof BrowseError ? e : new BrowseError(kind, (e as Error).message);
  }
}

// ---- the client ------------------------------------------------------------------------------------------------------

export interface Browse {
  ctx: Ctx;
  env: NodeJS.ProcessEnv;
  org: string;
  /** a client of the organisation; `.forProject(p).forRepo(r)` for a repository */
  client: AdoClient;
  refresh: boolean;
  now: () => number;
}

const lastOrgKey = "last-org";

/** --org, else the organisation of the repository in this folder, else the last one used, else AIHUB_ADO_ORG. */
export function resolveOrg(ctx: Ctx, org?: string): string {
  if (org) return org;
  if (ctx.env.AIHUB_ADO_ORG) return ctx.env.AIHUB_ADO_ORG;
  try {
    return remoteOf(ctx.cwd).org; // read from .git/config: no git process
  } catch {
    /* not inside an Azure DevOps clone */
  }
  const last = cacheRead<string>(ctx.env, lastOrgKey, TTL.forever, 0);
  if (last?.data) return last.data;
  throw new BrowseError("badInput", "which Azure DevOps organisation? pass --org <name> (or run it inside a clone of one of its repositories)");
}

export function browseOf(ctx: Ctx, o: { org?: string; refresh?: boolean }): Browse {
  const org = resolveOrg(ctx, o.org);
  const now = ctx.now ?? Date.now;
  cacheWrite(ctx.env, lastOrgKey, org, 0);
  const remote = { org, project: "", repo: "", orgUrl: `https://dev.azure.com/${encodeURIComponent(org)}` };
  const auth = makeAuth({ env: ctx.env, exec: ctx.exec, cacheFile: ctx.tokenCache });
  return { ctx, env: ctx.env, org, client: new AdoClient(remote, auth, ctx.fetch), refresh: !!o.refresh, now };
}

export const repoClientOf = (b: Browse, project: string, repo: string) => b.client.forProject(project).forRepo(repo);

// ---- refs ------------------------------------------------------------------------------------------------------------

export interface RefSpec {
  name: string;
  kind: "branch" | "tag" | "commit";
}

/** `main` | `tag:v1.2` | `commit:<sha>`; undefined = the default branch. */
export function parseRef(ref: string | undefined): RefSpec | undefined {
  if (!ref) return undefined;
  const r = ref.trim();
  if (/^tag:/i.test(r)) return { name: r.slice(4).replace(/^refs\/tags\//, ""), kind: "tag" };
  if (/^commit:/i.test(r)) {
    const sha = r.slice(7);
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new BrowseError("badInput", `'${sha}' is not a commit id`);
    return { name: sha.toLowerCase(), kind: "commit" };
  }
  return { name: r.replace(/^refs\/heads\//, ""), kind: "branch" };
}

export const versionQuery = (r: RefSpec) => ({ "versionDescriptor.version": r.name, "versionDescriptor.versionType": r.kind });

export interface RefOut {
  name: string;
  kind: RefSpec["kind"];
  commit: string;
}

// ---- people ----------------------------------------------------------------------------------------------------------

export interface Person {
  name: string;
  email: string;
  isMe: boolean;
}

export interface MeInfo {
  id: string;
  name: string;
  email: string;
}

/** Who is signed in (asked once per organisation, kept for good; an empty answer when it cannot be read). */
export async function meOf(b: Browse): Promise<MeInfo> {
  try {
    return (
      await cached(b, `me|${b.org}`, TTL.forever, async () => {
        const r = await b.client.getOrg<{ authenticatedUser?: { id?: string; providerDisplayName?: string; customDisplayName?: string; properties?: { Account?: { $value?: string } } } }>("connectionData");
        const u = r.authenticatedUser ?? {};
        return { id: u.id ?? "", name: u.customDisplayName || u.providerDisplayName || "", email: (u.properties?.Account?.$value ?? "").toLowerCase() };
      })
    ).data;
  } catch {
    return { id: "", name: "", email: "" };
  }
}

export function personOf(p: { name?: string; email?: string; displayName?: string; uniqueName?: string; id?: string } | undefined, me: MeInfo): Person {
  const name = p?.name ?? p?.displayName ?? "";
  const email = (p?.email ?? p?.uniqueName ?? "").toLowerCase();
  const isMe = (!!me.email && email === me.email) || (!!me.id && !!p?.id && p.id.toLowerCase() === me.id.toLowerCase());
  return { name, email, isMe };
}

// ---- small helpers ---------------------------------------------------------------------------------------------------

/** Runs `fn` over `items` with at most `n` at the same time. */
export async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** A part of a page that fails on its own: the error goes in `errors`, the page still comes. */
export async function part<T>(errors: { part: string; kind: BrowseErrorKind; message: string }[], name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    errors.push({ part: name, kind: kindOf(e), message: (e as Error).message });
    return fallback;
  }
}

export const normPath = (p: string | undefined): string => {
  const s = (p ?? "/").replace(/\\/g, "/").trim();
  const withSlash = s.startsWith("/") ? s : `/${s}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : "/";
};

export const shortSha = (s: string | undefined | null) => (s ? s.slice(0, 7) : "");

export const webRepoUrl = (b: Browse, project: string, repo: string) => `${b.client.remote.orgUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`;

export function webFileUrl(b: Browse, project: string, repo: string, path: string, ref?: RefSpec): string {
  const v = ref ? `&version=${ref.kind === "branch" ? "GB" : ref.kind === "tag" ? "GT" : "GC"}${encodeURIComponent(ref.name)}` : "";
  return `${webRepoUrl(b, project, repo)}?path=${encodeURIComponent(path)}${v}`;
}

export const webCommitUrl = (b: Browse, project: string, repo: string, id: string) => `${webRepoUrl(b, project, repo)}/commit/${id}`;

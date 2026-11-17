import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { trace } from "./trace.js";
import { dirname, join } from "node:path";
import { clientDirs, CLIENTS, type Client } from "./clients.js";
import { cliVersion, listFiles, packRoot, readPackFile, sha256, stamp } from "./pack.js";

// --dry-run: the same code path runs, but nothing is written and every planned write is printed.
const wf = (p: string, c: string) => (trace.dryRun ? trace.plan(`would write ${p}`) : writeFileSync(p, c, "utf8"));
const wq = (p: string, c: string) => (trace.dryRun ? undefined : writeFileSync(p, c, "utf8"));
const mk = (p: string) => (trace.dryRun ? undefined : void mkdirSync(p, { recursive: true }));
const rm = (p: string) => (trace.dryRun ? trace.plan(`would delete ${p}`) : unlinkSync(p));

export const MANIFEST = ".aihub-manifest.json";

interface Manifest {
  version: string;
  /** relative path -> sha256 of the content as aihub wrote it */
  files: Record<string, string>;
}

export interface Entry {
  rel: string;
  content: string;
}

export type Action = "created" | "updated" | "unchanged" | "removed" | "skipped";
export interface Result {
  action: Action;
  path: string;
  reason?: string;
}

export function readManifest(dir: string): Manifest {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as Manifest;
    return { version: m.version, files: m.files ?? {} };
  } catch {
    return { version: "", files: {} };
  }
}

export const readNorm = (p: string): string => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/**
 * Write entries into dir. Files that are not ours (no manifest record) or that the user changed (checksum differs from
 * what we wrote) are never overwritten. Idempotent. Files we installed earlier that left the pack are removed when unmodified.
 */
export function installEntries(dir: string, entries: Entry[], version: string): Result[] {
  const man = readManifest(dir);
  const results: Result[] = [];
  const next: Record<string, string> = {};
  for (const e of entries) {
    const abs = join(dir, e.rel);
    const want = sha256(e.content);
    if (!existsSync(abs)) {
      mk(dirname(abs));
      wf(abs, e.content);
      next[e.rel] = want;
      results.push({ action: "created", path: abs });
      continue;
    }
    const cur = sha256(readNorm(abs));
    if (cur === want) {
      next[e.rel] = want;
      results.push({ action: "unchanged", path: abs });
    } else if (man.files[e.rel] === cur) {
      wf(abs, e.content);
      next[e.rel] = want;
      results.push({ action: "updated", path: abs });
    } else {
      if (man.files[e.rel]) next[e.rel] = man.files[e.rel];
      results.push({ action: "skipped", path: abs, reason: man.files[e.rel] ? "changed by the user" : "exists and is not an aihub file" });
    }
  }
  for (const [rel, sum] of Object.entries(man.files)) {
    if (entries.some((e) => e.rel === rel)) continue;
    const abs = join(dir, rel);
    if (!existsSync(abs)) continue;
    if (sha256(readNorm(abs)) === sum) {
      rm(abs);
      results.push({ action: "removed", path: abs, reason: "no longer in the pack" });
    } else next[rel] = sum;
  }
  if (Object.keys(next).length) {
    mk(dir);
    wq(join(dir, MANIFEST), JSON.stringify({ version, files: next }, null, 2) + "\n");
  }
  pruneEmpty(dir, dir);
  return results;
}

/** Remove only the files aihub wrote and the user did not change. */
export function uninstallDir(dir: string): Result[] {
  const man = readManifest(dir);
  const results: Result[] = [];
  const keep: Record<string, string> = {};
  for (const [rel, sum] of Object.entries(man.files)) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) continue;
    if (sha256(readNorm(abs)) === sum) {
      rm(abs);
      results.push({ action: "removed", path: abs });
    } else {
      keep[rel] = sum;
      results.push({ action: "skipped", path: abs, reason: "changed by the user" });
    }
  }
  const mf = join(dir, MANIFEST);
  if (Object.keys(keep).length) wq(mf, JSON.stringify({ version: man.version, files: keep }, null, 2) + "\n");
  else if (existsSync(mf) && !trace.dryRun) unlinkSync(mf);
  pruneEmpty(dir, dir);
  return results;
}

/** Delete empty directories below dir and dir itself when it ends up empty. */
function pruneEmpty(dir: string, top: string): void {
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir, { withFileTypes: true })) if (n.isDirectory()) pruneEmpty(join(dir, n.name), top);
  if (readdirSync(dir).length === 0 && !trace.dryRun) rmdirSync(dir);
}

export function skillEntries(version = cliVersion()): Entry[] {
  const src = join(packRoot(), "skills");
  return listFiles(src).map((rel) => ({ rel, content: stamp(rel, readPackFile(join(src, rel)), version) }));
}

export function commandEntries(source: "opencode" | "copilot", version = cliVersion()): Entry[] {
  const src = join(packRoot(), "commands", source);
  return listFiles(src).map((rel) => ({ rel, content: stamp(rel, readPackFile(join(src, rel)), version) }));
}

export interface ClientReport {
  client: Client;
  dir: string;
  results: Result[];
}

export function parseClients(value: string | undefined): Client[] {
  if (!value || value === "all") return [...CLIENTS];
  if ((CLIENTS as string[]).includes(value)) return [value as Client];
  throw new Error(`unknown client '${value}'; use opencode, github-copilot, codex or all`);
}

export function installClients(clients: Client[], env: NodeJS.ProcessEnv, opts: { global: boolean; root?: string }): ClientReport[] {
  const version = cliVersion();
  const out: ClientReport[] = [];
  for (const c of clients) {
    const d = clientDirs(c, env, opts);
    out.push({ client: c, dir: d.skills, results: installEntries(d.skills, skillEntries(version), version) });
    if (d.commands) out.push({ client: c, dir: d.commands.dir, results: installEntries(d.commands.dir, commandEntries(d.commands.source, version), version) });
  }
  return out;
}

export function uninstallClients(clients: Client[], env: NodeJS.ProcessEnv, opts: { global: boolean; root?: string }): ClientReport[] {
  const out: ClientReport[] = [];
  for (const c of clients) {
    const d = clientDirs(c, env, opts);
    out.push({ client: c, dir: d.skills, results: uninstallDir(d.skills) });
    if (d.commands) out.push({ client: c, dir: d.commands.dir, results: uninstallDir(d.commands.dir) });
  }
  return out;
}

/** The aihub version in the marker of an installed skills folder, or undefined when none is installed. */
export function installedVersion(skillsDir: string): string | undefined {
  try {
    return /aihub (\S+?) (?:-->|$)/m.exec(readFileSync(join(skillsDir, "start-here", "SKILL.md"), "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

/** Negative when a is older than b (semver-like; a prerelease is older than its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/.exec(v);
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : { n: [0, 0, 0], pre: v };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

/** Does this client already have aihub skills in its global folder? */
export function clientHasInstall(env: NodeJS.ProcessEnv, client: Client): boolean {
  const d = clientDirs(client, env, { global: true });
  return installedVersion(d.skills) !== undefined || Object.keys(readManifest(d.skills).files).length > 0;
}

/** Rewrite the copies of every selected client that has them from the bundled pack. */
export function updateClients(clients: Client[], env: NodeJS.ProcessEnv): ClientReport[] {
  return installClients(clients.filter((c) => clientHasInstall(env, c)), env, { global: true });
}
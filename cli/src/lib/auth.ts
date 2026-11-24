import { spawn, spawnSync } from "./proc.js";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AihubError } from "./errors.js";
import type { AuthProvider } from "./ado.js";

export const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

export type Exec = (cmd: string, args: string[], input?: string) => string;

export const defaultExec: Exec = (cmd, args, input) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    input,
    shell: process.platform === "win32" && cmd === "az",
    timeout: 30000,
  });
  if (r.error || r.status !== 0) throw new Error(r.error?.message ?? (r.stderr || "").trim());
  return r.stdout;
};

export interface AuthDeps {
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  cacheFile?: string;
  now?: () => number;
}

const basic = (pat: string) => `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;

/** The az config folder (`AZURE_CONFIG_DIR`, else `~/.azure`). */
export const azConfigDir = (env: NodeJS.ProcessEnv) => env.AZURE_CONFIG_DIR || join(env.USERPROFILE || env.HOME || homedir(), ".azure");

/** False when az has no signed-in account at all (no profile, or no subscriptions/tenants): then asking az only costs 1-3 s. */
export function azLoginLikely(env: NodeJS.ProcessEnv): boolean {
  try {
    const j = JSON.parse(readFileSync(join(azConfigDir(env), "azureProfile.json"), "utf8").replace(/^﻿/, "")) as { subscriptions?: unknown[] };
    return Array.isArray(j.subscriptions) && j.subscriptions.length > 0;
  } catch {
    return false;
  }
}

/** Changes when the user signs in or out with az: the profile and the token cache. */
function azSignature(env: NodeJS.ProcessEnv): string {
  const dir = azConfigDir(env);
  return ["azureProfile.json", "msal_token_cache.bin", "msal_token_cache.json"].map((f) => (existsSync(join(dir, f)) ? String(statSync(join(dir, f)).mtimeMs) : "-")).join(",");
}

/** A cached az token this close to its end is renewed in the background (it is still used meanwhile). */
export const REFRESH_AHEAD_MS = 15 * 60_000;

/**
 * Renews an az token in a detached `aihub token refresh` process: the command that noticed keeps the valid token and
 * does not wait the 3-12 s az needs on a slow machine. One renewal per cache file at a time (a lock file of 2 minutes).
 */
export function refreshTokenInBackground(resource: string, cacheFile: string): void {
  const cli = process.argv[1];
  if (!cli || !/aihub|cli\.js$/i.test(cli)) return;
  const lock = `${cacheFile}.refreshing`;
  try {
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 120_000) return;
    writeFileSync(lock, String(process.pid));
    spawn(process.execPath, [cli, "token", "refresh", "--resource", resource, "--cache", cacheFile], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    /* renewing early is optional: the token is asked for when it expires */
  }
}

/** `aihub token refresh`: asks az for a token and writes the cache file (run detached by refreshTokenInBackground). */
export function refreshTokenNow(env: NodeJS.ProcessEnv, resource: string, cacheFile: string, now = Date.now): void {
  try {
    const j = azToken(defaultExec, true, env, resource, now);
    const expiresAt = j.expires_on ? Number(j.expires_on) * 1000 : Date.parse(j.expiresOn ?? "") || now() + 30 * 60_000;
    writeFileSync(cacheFile, JSON.stringify({ token: j.accessToken, expiresAt }), { mode: 0o600 });
  } finally {
    rmSync(`${cacheFile}.refreshing`, { force: true });
  }
}

const AZ_NONE_TTL_MS = 10 * 60_000;
const GIT_NONE_TTL_MS = 5 * 60_000;
const noneFile = () => join(tmpdir(), "aihub-signin-none.json");
type NoneCache = Record<string, { until: number; sig: string }>;

function readNone(): NoneCache {
  try {
    return JSON.parse(readFileSync(noneFile(), "utf8")) as NoneCache;
  } catch {
    return {};
  }
}

/** True when this way to sign in failed a moment ago and nothing it depends on (`sig`) changed since. */
export function recentlyFailed(key: string, now: () => number, sig: string): boolean {
  const hit = readNone()[key];
  return !!hit && hit.until > now() && hit.sig === sig;
}

export function rememberFailure(key: string, now: () => number, sig: string, ttlMs: number): void {
  try {
    const n = readNone();
    n[key] = { until: now() + ttlMs, sig };
    writeFileSync(noneFile(), JSON.stringify(n), { mode: 0o600 });
  } catch {
    /* the shortcut is optional */
  }
}

/**
 * `az account get-access-token` for a resource, with two shortcuts that only apply to the real az (not an injected exec):
 * no az login at all -> fail at once; az failed for this resource in the last 10 minutes and the login did not change ->
 * fail at once. A status read without a login then takes milliseconds instead of seconds per call.
 */
export function azToken(exec: Exec, realAz: boolean, env: NodeJS.ProcessEnv, resource: string, now: () => number): { accessToken: string; expires_on?: number | string; expiresOn?: string } {
  const key = `az:${resource}`;
  if (realAz) {
    if (!azLoginLikely(env)) throw new Error("az has no signed-in account");
    if (recentlyFailed(key, now, azSignature(env))) throw new Error("az could not give a token a moment ago");
  }
  try {
    return JSON.parse(exec("az", ["account", "get-access-token", "--resource", resource, "--output", "json"]));
  } catch (e) {
    if (realAz) rememberFailure(key, now, azSignature(env), AZ_NONE_TTL_MS);
    throw e;
  }
}

/** Order: PAT env -> az token (cached until expiry) -> git credential fill. */
export function makeAuth(deps: AuthDeps = {}): AuthProvider {
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const cacheFile = deps.cacheFile ?? join(tmpdir(), "aihub-az-token.json");
  let cached: string | undefined;
  // a failed sign-in is not retried within one command: every later read fails at once with the same message
  let failed: AihubError | undefined;

  return async () => {
    if (cached) return cached;
    if (failed) throw failed;
    const pat = env.AIHUB_ADO_PAT || env.AZURE_DEVOPS_EXT_PAT;
    if (pat) return (cached = basic(pat));

    try {
      if (existsSync(cacheFile)) {
        const c = JSON.parse(readFileSync(cacheFile, "utf8")) as { token: string; expiresAt: number };
        if (c.token && c.expiresAt - 120_000 > now()) {
          // still valid but expiring soon: renew it in a detached process, so no command waits for az
          if (!deps.exec && c.expiresAt - REFRESH_AHEAD_MS < now()) refreshTokenInBackground(ADO_RESOURCE, cacheFile);
          return (cached = `Bearer ${c.token}`);
        }
      }
    } catch {
      /* ignore a broken cache */
    }

    try {
      const j = azToken(exec, !deps.exec, env, ADO_RESOURCE, now);
      const expiresAt = j.expires_on ? Number(j.expires_on) * 1000 : Date.parse(j.expiresOn ?? "") || now() + 30 * 60_000;
      try {
        writeFileSync(cacheFile, JSON.stringify({ token: j.accessToken, expiresAt }), { mode: 0o600 });
      } catch {
        /* cache is optional */
      }
      return (cached = `Bearer ${j.accessToken}`);
    } catch {
      /* fall through to git credential */
    }

    // the credential helper starts slowly (~0.3 s for Git Credential Manager); an empty answer is remembered for 5 minutes
    const realGit = !deps.exec;
    if (!(realGit && recentlyFailed("git-credential:dev.azure.com", now, ""))) {
      try {
        const out = exec("git", ["credential", "fill"], "protocol=https\nhost=dev.azure.com\n\n");
        const pw = /^password=(.*)$/m.exec(out)?.[1]?.trim();
        if (pw) return (cached = basic(pw));
      } catch {
        /* fall through */
      }
      if (realGit) rememberFailure("git-credential:dev.azure.com", now, "", GIT_NONE_TTL_MS);
    }
    throw (failed = new AihubError(NOT_SIGNED_IN));
  };
}

export const NOT_SIGNED_IN = "not signed in to Azure DevOps: run 'az login' or set AIHUB_ADO_PAT";

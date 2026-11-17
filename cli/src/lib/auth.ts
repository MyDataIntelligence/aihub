import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** Order: PAT env -> az token (cached until expiry) -> git credential fill. */
export function makeAuth(deps: AuthDeps = {}): AuthProvider {
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const cacheFile = deps.cacheFile ?? join(tmpdir(), "aihub-az-token.json");
  let cached: string | undefined;

  return async () => {
    if (cached) return cached;
    const pat = env.AIHUB_ADO_PAT || env.AZURE_DEVOPS_EXT_PAT;
    if (pat) return (cached = basic(pat));

    try {
      if (existsSync(cacheFile)) {
        const c = JSON.parse(readFileSync(cacheFile, "utf8")) as { token: string; expiresAt: number };
        if (c.token && c.expiresAt - 120_000 > now()) return (cached = `Bearer ${c.token}`);
      }
    } catch {
      /* ignore a broken cache */
    }

    try {
      const out = exec("az", ["account", "get-access-token", "--resource", ADO_RESOURCE, "--output", "json"]);
      const j = JSON.parse(out) as { accessToken: string; expires_on?: number | string; expiresOn?: string };
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

    try {
      const out = exec("git", ["credential", "fill"], "protocol=https\nhost=dev.azure.com\n\n");
      const pw = /^password=(.*)$/m.exec(out)?.[1]?.trim();
      if (pw) return (cached = basic(pw));
    } catch {
      /* fall through */
    }
    throw new AihubError("not signed in to Azure DevOps: run 'az login' or set AIHUB_ADO_PAT");
  };
}

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ctx } from "../src/lib/context.js";

const here = dirname(fileURLToPath(import.meta.url));

export interface Call {
  method: string;
  url: string;
  body?: any;
  headers: Record<string, string>;
}
export interface Route {
  method?: string;
  match: RegExp;
  respond: (call: Call) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };
}

export function fakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fn = (async (input: any, init: any = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: String(input),
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers ?? {},
    };
    calls.push(call);
    const r = routes.find((x) => (x.method ?? "GET") === call.method && x.match.test(call.url));
    if (!r) {
      return new Response(JSON.stringify({ message: `no route ${call.method} ${call.url}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const out = r.respond(call);
    const headers = { "content-type": out.text !== undefined ? "text/plain" : "application/json", ...(out.headers ?? {}) };
    return new Response(out.text !== undefined ? out.text : JSON.stringify(out.body ?? {}), { status: out.status ?? 200, headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

export const fixture = (name: string): any => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
export const fixtureText = (name: string): string => readFileSync(join(here, "fixtures", name), "utf8");

export function sh(cwd: string, args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export const tmp = (prefix = "aihub-"): string => mkdtempSync(join(tmpdir(), prefix));

export function write(root: string, rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

export const ADO_URL = "https://dev.azure.com/ferron-org/test-project/_git/test-repo";

/** A clone whose origin is an Azure DevOps URL that is rewritten to a local bare repository. */
export function makeRepo(): { dir: string; bare: string } {
  const base = tmp();
  const bare = join(base, "remote.git");
  const dir = join(base, "work");
  mkdirSync(bare);
  mkdirSync(dir);
  sh(bare, ["init", "--bare", "-b", "main"]);
  sh(dir, ["init", "-b", "main"]);
  sh(dir, ["config", "remote.origin.url", ADO_URL]);
  sh(dir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  sh(dir, ["config", `url.${bare.replace(/\\/g, "/")}.insteadOf`, ADO_URL]);
  write(dir, "README.md", "x\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "initial"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["fetch", "origin"]);
  sh(dir, ["remote", "set-head", "origin", "main"]);
  return { dir, bare };
}

export function ctxFor(dir: string, fetchFn: typeof fetch) {
  const lines: string[] = [];
  const errs: string[] = [];
  const ctx: Ctx = {
    cwd: dir,
    env: { AIHUB_ADO_PAT: "synthetic-pat" },
    fetch: fetchFn,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
  };
  return { ctx, lines, errs };
}

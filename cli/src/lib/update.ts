import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENTS, clientDirs } from "./clients.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { compareVersions, installedVersion, updateClients, type ClientReport } from "./install.js";
import { cliPackageName, cliVersion, packRoot } from "./pack.js";

type Run = (cmd: string, args: string[]) => string;

/** npm and aihub are .cmd files on Windows, so they need a shell there. */
const sysRun: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32", timeout: 300_000 });
  if (r.error || r.status !== 0) throw new Error(r.error?.message ?? ((r.stderr || r.stdout || "").trim().split("\n")[0] || `exit ${r.status}`));
  return r.stdout;
};

const runner = (ctx: Ctx): Run => (cmd, args) => (ctx.exec ? ctx.exec(cmd, args) : sysRun(cmd, args));

/** `## <version>` sections of CHANGELOG.md newer than `from` and not newer than the running CLI, as one line per bullet. */
export function changelogSince(from: string, text: string, current = cliVersion()): string[] {
  const out: string[] = [];
  let version = "";
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const h = /^##\s+v?(\d+\.\d+\.\d+\S*)/.exec(line);
    if (h) {
      version = h[1];
      continue;
    }
    if (version && /^\s*[-*]\s+/.test(line) && compareVersions(version, from) > 0 && compareVersions(version, current) <= 0) {
      out.push(`  ${version}: ${line.replace(/^\s*[-*]\s+/, "")}`);
    }
  }
  return out;
}

function readChangelog(): string {
  try {
    const p = join(packRoot(), "CHANGELOG.md");
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  } catch {
    return "";
  }
}

export function isGlobalInstall(ctx: Ctx, run: Run): boolean {
  try {
    const root = realpathSync(run("npm", ["root", "-g"]).trim());
    const raw = ctx.installPath ?? dirname(fileURLToPath(import.meta.url));
    const here = realpathSync(raw);
    return here.toLowerCase().startsWith((root + sep).toLowerCase());
  } catch {
    return false;
  }
}

function skillsLines(ctx: Ctx, current: string): string[] {
  const lines: string[] = [];
  for (const c of CLIENTS) {
    const v = installedVersion(clientDirs(c, ctx.env, { global: true }).skills);
    if (v) lines.push(`skills ${c}: aihub ${v}${compareVersions(v, current) < 0 ? ` (older than the CLI, 'aihub skills update' refreshes it)` : ""}`);
  }
  return lines.length ? lines : ["skills: not installed ('aihub skills install')"];
}

export interface UpdateOpts {
  check?: boolean;
  /** Internal: the old version, passed by the previous CLI after it installed this one. */
  after?: string;
}

export interface UpdateResult {
  lines: string[];
  reports: ClientReport[];
}

export function runUpdate(ctx: Ctx, o: UpdateOpts): UpdateResult {
  const run = runner(ctx);
  const name = cliPackageName();
  const current = cliVersion();

  if (o.after !== undefined) {
    const lines = changelogSince(o.after, readChangelog(), current);
    const reports = updateClients([...CLIENTS], ctx.env);
    return { lines: [`aihub ${o.after} -> ${current}`, ...(lines.length ? ["changes:", ...lines] : ["no changelog entries for this range"])], reports };
  }

  let registry = "";
  try {
    registry = run("npm", ["config", "get", "registry"]).trim();
  } catch {
    /* npm missing: the next call reports it */
  }
  let latest: string;
  try {
    latest = run("npm", ["view", name, "version"]).trim();
  } catch (e) {
    throw new AihubError(`cannot read the latest version of ${name}${registry ? ` from ${registry}` : ""}: ${(e as Error).message}; check your .npmrc (registry and sign-in)`);
  }
  const head = [`${name} ${current}${registry ? ` (registry ${registry})` : ""}`, `latest: ${latest}`];
  const newer = compareVersions(current, latest) < 0;
  const global = isGlobalInstall(ctx, run);
  const cmd = `npm i -g ${name}@latest`;

  if (o.check) {
    return {
      lines: [
        ...head,
        newer ? `update available: run 'aihub update'${global ? "" : ` (not a global npm install: run '${cmd}' yourself)`}` : "the CLI is up to date",
        ...skillsLines(ctx, current),
      ],
      reports: [],
    };
  }

  if (newer) {
    if (!global) {
      return { lines: [...head, `not detected as a global npm install, so run this yourself: ${cmd}`, "then run 'aihub update' again to refresh the skills"], reports: [] };
    }
    run("npm", ["i", "-g", `${name}@latest`]);
    // the new CLI shows the changelog and refreshes the skills from its own bundled pack
    const after = run("aihub", ["update", "--after", current]);
    return { lines: [...head, `installed ${name}@${latest}`, ...after.trimEnd().split("\n")], reports: [] };
  }
  const reports = updateClients([...CLIENTS], ctx.env);
  return { lines: [...head, "the CLI is up to date", reports.length ? "skills refreshed from the bundled pack:" : "no client has aihub skills yet ('aihub skills install')"], reports };
}

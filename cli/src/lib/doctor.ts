import { spawnSync } from "./proc.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { parseRemote, type AdoRemote } from "./ado.js";
import { cachedDetections, fabricTokenAtHand } from "./team-detect.js";
import { effective, questions } from "./team-guide.js";
import { defaultExec, type Exec, ADO_RESOURCE } from "./auth.js";
import { CLIENTS, clientDirs, opencodeVersion } from "./clients.js";
import type { Ctx } from "./context.js";
import { originDefaultBranch, remoteUrl, repoRoot, showFile } from "./git.js";
import { permissionState } from "./opencodePermission.js";
import { clientHasAgents, compareVersions, installedVersion } from "./install.js";
import { cliVersion, packRoot } from "./pack.js";
import { requiredPaths, validateTeam } from "./schema.js";
import { defaultTargetFor, loadTeam, readUtf8, TEAM_FILE } from "./team.js";
import { resolveTemplate } from "./templates.js";
import { legacyFootprint, LEGACY_FIX } from "./legacy.js";
import { aihubDir } from "./aihubDir.js";

export interface Check {
  name: string;
  status: "OK" | "FIX";
  detail: string;
  fix?: string;
}

const ok = (name: string, detail: string): Check => ({ name, status: "OK", detail });
const fix = (name: string, detail: string, how: string): Check => ({ name, status: "FIX", detail, fix: how });

/** Never prompts: a credential helper that wants a terminal fails instead of hanging. */
const quietExec: Exec = (cmd, args, input) => {
  if (cmd !== "git") return defaultExec(cmd, args, input);
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    input,
    timeout: 10000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  });
  if (r.error || r.status !== 0) throw new Error(r.error?.message ?? (r.stderr || "").trim());
  return r.stdout;
};

function checkAuth(ctx: Ctx): Check {
  const how = "run 'az login', set AIHUB_ADO_PAT, or sign in once with git (git credential manager)";
  const pat = ctx.env.AIHUB_ADO_PAT ? "AIHUB_ADO_PAT" : ctx.env.AZURE_DEVOPS_EXT_PAT ? "AZURE_DEVOPS_EXT_PAT" : "";
  if (pat) return ok("auth", `PAT from environment (${pat})`);
  const exec = ctx.exec ?? quietExec;
  try {
    const j = JSON.parse(exec("az", ["account", "get-access-token", "--resource", ADO_RESOURCE, "--output", "json"])) as { accessToken?: string };
    if (j.accessToken) return ok("auth", "Azure CLI token (az login)");
  } catch {
    /* next method */
  }
  try {
    if (/^password=.+$/m.test(exec("git", ["credential", "fill"], "protocol=https\nhost=dev.azure.com\n\n"))) {
      return ok("auth", "git credential");
    }
  } catch {
    /* none */
  }
  return fix("auth", "no way to sign in to Azure DevOps works", how);
}

export function runChecks(ctx: Ctx): Check[] {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(
    major >= 18
      ? ok("node", `v${process.versions.node}`)
      : fix("node", `v${process.versions.node} is too old (needs 18 or newer)`, "install Node 18 or newer from nodejs.org"),
  );
  const g = spawnSync("git", ["--version"], { encoding: "utf8" });
  checks.push(g.status === 0 ? ok("git", g.stdout.trim()) : fix("git", "git is not available", "install git and make sure it is on the PATH"));

  let root: string | undefined;
  try {
    root = repoRoot(ctx.cwd);
  } catch {
    checks.push(fix("repository", "not inside a git repository", "cd into a clone of your team repository"));
  }
  let repoName = "";
  let remote: AdoRemote | undefined;
  if (root) {
    try {
      const r = parseRemote(remoteUrl(root));
      remote = r;
      repoName = r.repo;
      checks.push(ok("remote", `${r.org}/${r.project}/${r.repo}`));
    } catch (e) {
      checks.push(fix("remote", (e as Error).message, "set origin to the Azure DevOps clone URL: git remote set-url origin <url>"));
    }
  }
  checks.push(checkAuth(ctx));

  if (root) {
    const teamPath = join(root, TEAM_FILE);
    if (!existsSync(teamPath)) {
      checks.push(fix("team.yaml", `${TEAM_FILE} not found`, "run 'aihub team setup' (detects what it can and asks the rest), then 'aihub init'"));
    } else {
      try {
        const data = parse(readUtf8(teamPath));
        const schemaFile = join(packRoot(), "skills", "_shared", "references", "team.schema.yaml");
        const problems = validateTeam(data, requiredPaths(readFileSync(schemaFile, "utf8")));
        checks.push(
          problems.length
            ? fix("team.yaml", problems.join("; "), `edit ${TEAM_FILE} (see docs/team-yaml.md) and open a pull request`)
            : ok("team.yaml", `${TEAM_FILE} is valid`),
        );
      } catch (e) {
        checks.push(fix("team.yaml", `cannot be read: ${(e as Error).message.split("\n")[0]}`, `repair ${TEAM_FILE} (valid YAML) or recreate it with 'aihub init'`));
      }
    }
    const team = loadTeam(root);
    if (existsSync(teamPath)) {
      // keys team.yaml leaves open that aihub could only guess: from the detection cache, no network
      const found = remote ? cachedDetections(ctx.env, remote, (ctx.now ?? Date.now)()) : [];
      for (const q of questions(effective(team, found), 99)) checks.push(fix(`team:${q.key}`, `not in team.yaml and not sure (found: ${q.choices.join(", ")})`, `ask the user, then: ${q.command}`));
    }
    const guidelines = (Array.isArray(team.guidelines) ? (team.guidelines as unknown[]) : Array.isArray((team.guidelines as { files?: unknown[] } | undefined)?.files) ? (team.guidelines as { files: unknown[] }).files : []).map(String); // a list, or { files, linters }
    if (guidelines.length) {
      const missing = guidelines.filter((g) => !existsSync(join(root, g)));
      checks.push(
        missing.length
          ? fix("guidelines", `listed in team.yaml but not found: ${missing.join(", ")}`, "add the files or remove them from guidelines: in team.yaml")
          : ok("guidelines", `${guidelines.length} guideline file(s) found`),
      );
    }
    const target = defaultTargetFor(team, repoName) || originDefaultBranch(root) || "main";
    const tpl = resolveTemplate(target, { readRef: (b, p) => showFile(root!, b, p), localRoot: root });
    checks.push(
      tpl
        ? ok("pr-template", `${tpl.path} (${tpl.from === "ref" ? `on origin/${target}` : "in the working tree only"})`)
        : fix("pr-template", "no pull request template found", "run 'aihub init' or add .azuredevops/pull_request_template.md"),
    );
  }

  const fabricToken = fabricTokenAtHand(ctx.env, (ctx.now ?? Date.now)(), ctx.tokenCache && `${ctx.tokenCache}.fabric`);
  checks.push(ok("fabric", fabricToken ? "token at hand (Fabric commands and workspace detection work)" : "no token at hand; Fabric commands sign in with 'az login' or AIHUB_FABRIC_TOKEN when used"));

  const current = cliVersion();
  for (const c of CLIENTS) {
    const found = [
      { label: "global", dir: clientDirs(c, ctx.env, { global: true }).skills },
      ...(root ? [{ label: "project", dir: clientDirs(c, ctx.env, { global: false, root }).skills }] : []),
    ]
      .map((p) => ({ ...p, version: installedVersion(p.dir) }))
      .filter((p) => p.version !== undefined);
    // Claude Code is opt-in: nothing to report until it has been installed
    if (c === "claude" && !found.length && !clientHasAgents(ctx.env, c)) continue;
    const stale = found.filter((p) => compareVersions(p.version!, current) < 0);
    const where = found.map((p) => `${p.label} ${p.dir} (aihub ${p.version})`).join(", ");
    checks.push(
      !found.length
        ? fix(`skills:${c}`, "aihub skills not installed", `aihub skills install --client ${c}`)
        : stale.length
          ? fix(`skills:${c}`, `stale copy, older than the CLI ${current}: ${where}`, "run 'aihub skills update'")
          : ok(`skills:${c}`, where),
    );
    const agents = clientDirs(c, ctx.env, { global: true }).agents;
    if (agents) {
      // the agents are optional: not installed is fine, a stale copy or the wrong opencode format is not
      const where = [agents.dir, agents.other].find((d) => d && agentsVersion(d) !== undefined);
      const v = where ? agentsVersion(where) : undefined;
      const want = c === "opencode" ? ` (opencode ${opencodeVersion(ctx.env) ?? "not found, 1.x format"}: ${agents.source === "opencode2" ? "2.x format, agents/ with permissions" : "1.x format, agent/ with a permission map"})` : "";
      checks.push(
        !where
          ? ok(`agents:${c}`, `optional aihub agents not installed (aihub skills install --client ${c} adds them)${want}`)
          : where !== agents.dir
            ? fix(`agents:${c}`, `agents are in ${where}, the format of the other opencode version${want}`, "run 'aihub skills update'")
            : v && compareVersions(v, current) < 0
              ? fix(`agents:${c}`, `stale agents, older than the CLI ${current}: ${where} (aihub ${v})`, "run 'aihub skills update'")
              : ok(`agents:${c}`, `${where} (aihub ${v ?? current})${want}`),
      );
    }
    if (c === "opencode" && found.some((p) => p.label === "global")) {
      const s = permissionState(ctx.env);
      checks.push(
        s.state === "allowed"
          ? ok("permission:opencode", `skills folder may be read without a prompt (${s.file})`)
          : fix("permission:opencode", s.state === "unreadable" ? `${s.file} has comments, aihub cannot edit it` : "opencode will ask before a skill reads its templates (and 'opencode run' rejects that)", s.state === "unreadable" ? `add "permission": {"external_directory": {"${s.pattern}": "allow"}}` : "aihub skills install --client opencode"),
      );
    }
  }
  try {
    const old = legacyFootprint(ctx.env, ctx.cwd);
    checks.push(
      old.found.length
        ? fix("legacy-hub", `the old AI Context Hub is still installed (${old.found.join(", ")}); its skills and rules make agents run 'hub call' instead of aihub`, LEGACY_FIX)
        : ok("legacy-hub", "no old AI Context Hub found"),
    );
  } catch {
    /* an unreadable folder must not fail the doctor */
  }
  if (root) {
    const perf = vscodePerf(root);
    if (perf) checks.push(perf);
  }
  return checks;
}

/** The VS Code extension's performance log: where it is and its summary of the last 24 h (written by the extension). */
function vscodePerf(root: string): Check | undefined {
  try {
    const j = JSON.parse(readFileSync(aihubDir(root, "vscode-perf.json"), "utf8")) as { logDir?: string; updated?: string; summary?: string };
    if (!j.logDir) return undefined;
    return ok("vscode-perf", `log in ${j.logDir}; ${j.summary ?? "no summary yet"}${j.updated ? ` (as of ${j.updated})` : ""}`);
  } catch {
    return undefined;
  }
}

/** The aihub version in the marker of the installed aihub agent file. */
function agentsVersion(dir: string): string | undefined {
  for (const f of ["aihub.md", "aihub.agent.md", "aihub.toml"]) {
    try {
      return /(?:<!-- |^# )aihub (\S+?)(?: -->|$)/m.exec(readFileSync(join(dir, f), "utf8"))?.[1];
    } catch {
      /* try the next name */
    }
  }
  return undefined;
}

export function formatChecks(checks: Check[]): string[] {
  return checks.map((c) => `${c.status.padEnd(4)} ${c.name}: ${c.detail}${c.fix ? ` -> ${c.fix}` : ""}`);
}

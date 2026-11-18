import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { parseRemote } from "./ado.js";
import { defaultExec, type Exec, ADO_RESOURCE } from "./auth.js";
import { CLIENTS, clientDirs } from "./clients.js";
import type { Ctx } from "./context.js";
import { originDefaultBranch, remoteUrl, repoRoot, showFile } from "./git.js";
import { permissionState } from "./opencodePermission.js";
import { clientHasAgents, compareVersions, installedVersion } from "./install.js";
import { cliVersion, packRoot } from "./pack.js";
import { requiredPaths, validateTeam } from "./schema.js";
import { defaultTargetFor, loadTeam, readUtf8, TEAM_FILE } from "./team.js";
import { resolveTemplate } from "./templates.js";

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
  if (root) {
    try {
      const r = parseRemote(remoteUrl(root));
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
      checks.push(fix("team.yaml", `${TEAM_FILE} not found`, "run 'aihub init' (opens a pull request with the team pack)"));
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
    const guidelines = Array.isArray(team.guidelines) ? (team.guidelines as unknown[]).map(String) : [];
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

  const current = cliVersion();
  for (const c of CLIENTS) {
    const found = [
      { label: "global", dir: clientDirs(c, ctx.env, { global: true }).skills },
      ...(root ? [{ label: "project", dir: clientDirs(c, ctx.env, { global: false, root }).skills }] : []),
    ]
      .map((p) => ({ ...p, version: installedVersion(p.dir) }))
      .filter((p) => p.version !== undefined);
    const stale = found.filter((p) => compareVersions(p.version!, current) < 0);
    const where = found.map((p) => `${p.label} ${p.dir} (aihub ${p.version})`).join(", ");
    checks.push(
      !found.length
        ? fix(`skills:${c}`, "aihub skills not installed", `aihub skills install --client ${c}`)
        : stale.length
          ? fix(`skills:${c}`, `stale copy, older than the CLI ${current}: ${where}`, "run 'aihub skills update'")
          : ok(`skills:${c}`, where),
    );
    if (clientDirs(c, ctx.env, { global: true }).agents) {
      // the agents are optional: not installed is fine, a stale copy is not
      const dir = clientDirs(c, ctx.env, { global: true }).agents!.dir;
      const have = clientHasAgents(ctx.env, c);
      const v = have ? agentsVersion(dir) : undefined;
      checks.push(
        !have
          ? ok(`agents:${c}`, `optional aihub agents not installed (aihub skills install --client ${c} adds them)`)
          : v && compareVersions(v, current) < 0
            ? fix(`agents:${c}`, `stale agents, older than the CLI ${current}: ${dir} (aihub ${v})`, "run 'aihub skills update'")
            : ok(`agents:${c}`, `${dir} (aihub ${v ?? current})`),
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
  }  return checks;
}

/** The aihub version in the marker of the installed aihub agent file. */
function agentsVersion(dir: string): string | undefined {
  for (const f of ["aihub.md", "aihub.agent.md"]) {
    try {
      return /<!-- aihub (\S+) -->/.exec(readFileSync(join(dir, f), "utf8"))?.[1];
    } catch {
      /* try the next name */
    }
  }
  return undefined;
}

export function formatChecks(checks: Check[]): string[] {
  return checks.map((c) => `${c.status.padEnd(4)} ${c.name}: ${c.detail}${c.fix ? ` -> ${c.fix}` : ""}`);
}

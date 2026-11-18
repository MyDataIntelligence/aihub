import { parseArgs } from "node:util";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { repoRoot } from "../lib/git.js";
import { diffClient } from "../lib/skillsDiff.js";
import { installClients, parseClients, uninstallClients, updateClients, type ClientReport } from "../lib/install.js";
import { LEGACY_FIX, legacyFootprint } from "../lib/legacy.js";

const USAGE =
  "usage: aihub skills install|update|diff|uninstall [--client opencode|github-copilot|codex|claude|all] [--into-repo] [--no-agents]\n" +
  "  install    copy the bundled skills and slash commands, and the optional aihub agents (opencode, github-copilot) into each client's global folder\n" +
  "  update     rewrite the copies of every client that has them from the bundled pack (files you edited stay)\n" +
  "  diff       show your edits to the installed skills (and copies behind the bundled pack)\n" +
  "  uninstall  remove only the files aihub wrote and you did not change\n" +
  "  --no-agents  install: skip the optional aihub and aihub-runner agents (your default agent is never touched)\n" +
  "  --into-repo  use the current repository instead of the global folders (for teams that keep skills in the repo)";

export function report(reports: ClientReport[], out: (l: string) => void): void {
  for (const r of reports) {
    const count = (a: string) => r.results.filter((x) => x.action === a).length;
    out(`${r.client}: ${r.dir}`);
    out(`  created ${count("created")}, updated ${count("updated")}, unchanged ${count("unchanged")}, removed ${count("removed")}, skipped ${count("skipped")}`);
    for (const s of r.results.filter((x) => x.action === "skipped")) out(`  skipped ${s.path} (${s.reason})`);
  }
}

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub !== "install" && sub !== "update" && sub !== "uninstall" && sub !== "diff") throw new AihubError(USAGE);
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({ args: rest, options: { global: { type: "boolean" }, "into-repo": { type: "boolean" }, "no-agents": { type: "boolean" }, client: { type: "string" } } }).values;
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  let clients;
  try {
    clients = parseClients(v.client as string | undefined);
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  let opts: { global: boolean; root?: string } = { global: true };
  if (v["into-repo"]) {
    try {
      opts = { global: false, root: repoRoot(ctx.cwd) };
    } catch {
      throw new AihubError("--into-repo needs a git repository: cd into the repository first");
    }
  }
  if (sub === "diff") {
    let any = false;
    for (const c of clients) {
      const d = diffClient(ctx.env, c, opts);
      for (const f of d) {
        any = true;
        ctx.out(`${c}: ${f.rel} (${f.state === "edited" ? "edited by you" : f.state === "behind" ? "older than the bundled pack, aihub skills update refreshes it" : "deleted by you"})`);
        for (const l of f.diff) ctx.out(`  ${l}`);
      }
    }
    if (!any) ctx.out("no differences: installed skills match the bundled pack");
    return;
  }
  if (sub === "install") {
    report(installClients(clients, ctx.env, { ...opts, agents: !v["no-agents"] }), ctx.out);
    for (const line of installNotes(ctx, clients)) ctx.out(line);
  }
  else if (sub === "uninstall") report(uninstallClients(clients, ctx.env, opts), ctx.out);
  else {
    if (!opts.global) throw new AihubError("'aihub skills update' refreshes the global copies; for the repository run 'aihub skills install --into-repo' again");
    const r = updateClients(clients, ctx.env);
    if (!r.length) throw new AihubError("no client has aihub skills yet; run 'aihub skills install'");
    report(r, ctx.out);
  }
}
/** Lines printed after `aihub skills install`: the old Hub still wins in the agents, and how each client auto-approves commands. */
function installNotes(ctx: Ctx, clients: string[]): string[] {
  const out: string[] = [];
  try {
    const old = legacyFootprint(ctx.env, ctx.cwd);
    if (old.found.length) out.push(`warning: the old AI Context Hub is still installed (${old.found.join(", ")}); agents keep running 'hub call' instead of aihub. Run: ${LEGACY_FIX}`);
  } catch {
    /* never fail an install because of this check */
  }
  if (clients.includes("opencode")) out.push("note: the opencode aihub agent runs commands without asking (git push to main/staging/release, force pushes and a short dangerous list are denied)");
  if (clients.includes("github-copilot")) out.push('note: Copilot and VS Code ask before each terminal command; set "chat.tools.terminal.autoApprove" in your user settings, for example {"/^(aihub|git|az|npm|python|dbt)\\b/": true, "/^git push\\b.*(--force|\\s-f\\b)/": false} (docs/agents.md)');
  if (clients.includes("codex")) out.push('note: Codex asks per session; use a profile with approval_policy = "never" and sandbox_mode = "workspace-write" (docs/agents.md)');
  if (clients.includes("claude")) out.push('note: Claude Code: add "permissions": {"allow": ["Bash(aihub:*)", "Bash(git:*)", "Bash(python:*)"], "deny": ["Bash(git push --force:*)"]} to settings.json (docs/agents.md)');
  return out;
}

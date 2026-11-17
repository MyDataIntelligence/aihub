import { parseArgs } from "node:util";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { repoRoot } from "../lib/git.js";
import { diffClient } from "../lib/skillsDiff.js";
import { installClients, parseClients, uninstallClients, updateClients, type ClientReport } from "../lib/install.js";

const USAGE =
  "usage: aihub skills install|update|diff|uninstall [--client opencode|github-copilot|codex|all] [--into-repo]\n" +
  "  install    copy the bundled skills and slash commands into each client's global folder\n" +
  "  update     rewrite the copies of every client that has them from the bundled pack (files you edited stay)\n" +
  "  diff       show your edits to the installed skills (and copies behind the bundled pack)\n" +
  "  uninstall  remove only the files aihub wrote and you did not change\n" +
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
    v = parseArgs({ args: rest, options: { global: { type: "boolean" }, "into-repo": { type: "boolean" }, client: { type: "string" } } }).values;
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
  if (sub === "install") report(installClients(clients, ctx.env, opts), ctx.out);
  else if (sub === "uninstall") report(uninstallClients(clients, ctx.env, opts), ctx.out);
  else {
    if (!opts.global) throw new AihubError("'aihub skills update' refreshes the global copies; for the repository run 'aihub skills install --into-repo' again");
    const r = updateClients(clients, ctx.env);
    if (!r.length) throw new AihubError("no client has aihub skills yet; run 'aihub skills install'");
    report(r, ctx.out);
  }
}
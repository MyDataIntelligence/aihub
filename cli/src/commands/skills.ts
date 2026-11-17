import { parseArgs } from "node:util";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { repoRoot } from "../lib/git.js";
import { installClients, parseClients, uninstallClients, type ClientReport } from "../lib/install.js";

function report(reports: ClientReport[], out: (l: string) => void): void {
  for (const r of reports) {
    const count = (a: string) => r.results.filter((x) => x.action === a).length;
    out(`${r.client}: ${r.dir}`);
    out(
      `  created ${count("created")}, updated ${count("updated")}, unchanged ${count("unchanged")}, removed ${count("removed")}, skipped ${count("skipped")}`,
    );
    for (const s of r.results.filter((x) => x.action === "skipped")) out(`  skipped ${s.path} (${s.reason})`);
  }
}

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub !== "install" && sub !== "uninstall") throw new AihubError("usage: aihub skills install|uninstall [--global] [--client opencode|github-copilot|codex|all]");
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({ args: rest, options: { global: { type: "boolean" }, client: { type: "string" } } }).values;
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  let clients;
  try {
    clients = parseClients(v.client as string | undefined);
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  const global = !!v.global;
  let root: string | undefined;
  if (!global) {
    try {
      root = repoRoot(ctx.cwd);
    } catch {
      throw new AihubError("not inside a git repository: run in a repository for a project install, or add --global");
    }
  }
  const opts = { global, root };
  report(sub === "install" ? installClients(clients, ctx.env, opts) : uninstallClients(clients, ctx.env, opts), ctx.out);
}

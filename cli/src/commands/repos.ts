import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { list } from "../lib/cliargs.js";
import { reposClone, reposList } from "../lib/projectRepos.js";
import { adoRepos, cloneRepos, joinAdoLocal, localRepos } from "../lib/repoPicker.js";

const USAGE = `usage: aihub repos list [--filter text] | repos clone --name <repository>[,<repository>] [--root <folder>]
       aihub repos local [--root <folder>] [--json]          (the clones under the repos root, read from their files: no network)
       aihub repos ado [--refresh] [--root <folder>] [--json] (every Azure DevOps repository you can see, cached a few hours, with its local clone)
       aihub repos clone --repos <project/name>[,...] [--root <folder>] [--json]   (into the repos root; an existing folder is never touched)`;

/** aihub repos list|local|ado|clone */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parse(rest, { filter: { type: "string" }, name: { type: "string" }, repos: { type: "string" }, root: { type: "string" }, refresh: { type: "boolean" }, json: { type: "boolean" } }).values;
  if (sub === "list") return void ctx.out(await reposList(ctx, { filter: v.filter, root: v.root, json: v.json }));
  if (sub === "local") {
    const r = localRepos(ctx, { root: v.root });
    return void ctx.out(v.json ? JSON.stringify(r) : r.repos.map((x) => `${x.name.padEnd(32)} ${(x.branch || "(detached)").padEnd(28)} ${x.path}`).join("\n") || `no clones under ${r.root ?? "(no repos root)"}`);
  }
  if (sub === "ado") {
    const local = localRepos(ctx, { root: v.root });
    const a = await adoRepos(ctx, { refresh: v.refresh });
    const repos = joinAdoLocal(a.repos, local.repos, local.root);
    if (v.json) return void ctx.out(JSON.stringify({ cached: a.cached, at: new Date(a.at).toISOString(), root: local.root, repos }));
    return void ctx.out(repos.map((x) => `${`${x.project}/${x.name}`.padEnd(44)} ${x.path ? `${x.branch || "(detached)"}  ${x.path}` : "not cloned"}`).join("\n") || "no repositories in Azure DevOps");
  }
  if (sub === "clone") {
    if (v.repos) {
      const r = await cloneRepos(ctx, list(v.repos), { root: v.root });
      if (v.json) return void ctx.out(JSON.stringify(r));
      ctx.out(r.map((x) => `${x.project}/${x.repo}: ${x.status}${x.error ? `: ${x.error}` : ""}${x.path ? ` (${x.path})` : ""}`).join("\n"));
      if (r.some((x) => x.status === "failed")) throw new AihubError(`${r.filter((x) => x.status === "failed").length} repository(ies) could not be cloned`);
      return;
    }
    return void ctx.out(await reposClone(ctx, { names: list(v.name), root: v.root, json: v.json }));
  }
  throw new AihubError(USAGE);
}

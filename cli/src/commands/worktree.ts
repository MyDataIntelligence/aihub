import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { list, optInt, parseFlags, posInt } from "../lib/cliargs.js";
import { findGroup, groupDirs, listGroups, removeGroup, resolveRepos, saveGroup, saveTeamGroup } from "../lib/repoGroups.js";
import { currentBranches, formatOpenSet, listBranches, openSet, type OpenMode, type OpenWindow } from "../lib/repoSet.js";
import { createSet, listSets, removeSet } from "../lib/worktree.js";
import { formatCleanup, formatRemoved, listCleanup, removeCleanup } from "../lib/worktreeCleanup.js";

const USAGE =
  "usage: aihub worktree create|list|remove --story <id> [--repos a,b] [--root <folder>] | worktree open --group <name> | --repos a,b,c --branch <b> [--from <target>] [--mode worktree|switch] [--window new|this] [--story <id>] [--new-set] | worktree branches --group <name> | --repos a,b | worktree groups list|save <name> --repos a,b|remove <name> | worktree remove --branch <b> | worktree cleanup [--json] [--repos a,b] [--remove p1,p2 [--delete-branch]]";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === "groups") return groups(rest, ctx);
  const v = parseFlags(rest, {
    story: { type: "string" },
    repos: { type: "string" },
    group: { type: "string" },
    root: { type: "string" },
    branch: { type: "string" },
    base: { type: "string" },
    from: { type: "string" },
    mode: { type: "string" },
    window: { type: "string" },
    "new-set": { type: "boolean" },
    json: { type: "boolean" },
    remove: { type: "string" },
    "delete-branch": { type: "boolean" },
    "no-size": { type: "boolean" },
    offline: { type: "boolean" },
  });
  const root = v.root as string | undefined;
  const json = !!v.json;
  if (sub === "create") {
    ctx.out(await createSet(ctx, { story: posInt(v.story, "--story"), repos: list(v.repos), root, branch: v.branch as string | undefined, base: v.base as string | undefined, json }));
  } else if (sub === "list") {
    ctx.out(listSets(ctx, { root, json }));
  } else if (sub === "remove") {
    ctx.out(removeSet(ctx, { story: optInt(v.story, "--story"), branch: v.branch as string | undefined, root, json }));
  } else if (sub === "open") {
    // no --mode: worktree for a new set; inside a set, naming some of its repositories switches them in place
    const mode = v.mode as string | undefined;
    const window = (v.window as string | undefined) ?? "new";
    if (mode !== undefined && mode !== "worktree" && mode !== "switch") throw new AihubError("--mode must be worktree or switch");
    if (window !== "new" && window !== "this" && window !== "none") throw new AihubError("--window must be new, this or none");
    const r = openSet(ctx, { group: v.group as string | undefined, repos: list(v.repos), branch: String(v.branch ?? ""), from: (v.from ?? v.base) as string | undefined, mode: mode as OpenMode | undefined, window: window as OpenWindow, root, storyId: optInt(v.story, "--story"), newSet: !!v["new-set"] });
    ctx.out(json ? JSON.stringify(r) : formatOpenSet(r));
    const bad = r.repos.filter((x) => !x.ok).length;
    // --json is for programs (the VS Code extension): the table says which repositories failed, so the exit code stays 0
    if (bad && !json) throw new AihubError(`${bad} of ${r.repos.length} repositories need attention (the others are open)`);
  } else if (sub === "cleanup") {
    // aihub worktree cleanup [--json] [--repos a,b] [--no-size] [--offline] [--remove p1,p2 [--delete-branch]]
    const rows = await listCleanup(ctx, { repos: list(v.repos), sizes: !v["no-size"], offline: !!v.offline });
    if (v.remove) {
      const done = removeCleanup(rows, String(v.remove).split(",").map((p) => p.trim()).filter(Boolean), { deleteBranch: !!v["delete-branch"] });
      ctx.out(json ? JSON.stringify({ removed: done, freedBytes: done.reduce((n, r) => n + r.freedBytes, 0) }) : formatRemoved(done));
    } else ctx.out(json ? JSON.stringify({ worktrees: rows, preselected: rows.filter((r) => r.preselected).length, preselectedBytes: rows.filter((r) => r.preselected).reduce((n, r) => n + (r.sizeBytes ?? 0), 0) }) : formatCleanup(rows));
  } else if (sub === "branches") {
    const dirs = v.group ? groupDirs(ctx, findGroup(ctx, String(v.group))).dirs : resolveRepos(ctx, list(v.repos));
    if (!dirs.length) throw new AihubError("--group <name> or --repos a,b needed");
    const rows = listBranches(dirs);
    ctx.out(json ? JSON.stringify({ repos: dirs.map((d) => d.name), current: currentBranches(dirs), branches: rows }) : rows.map((b) => `${b.name}  (${b.in.length}/${dirs.length}${b.missing.length ? `, missing in ${b.missing.join(", ")}` : ""})`).join("\n"));
  } else throw new AihubError(USAGE);
}

function groups(argv: string[], ctx: Ctx): void {
  const [sub, ...rest] = argv;
  const name = rest[0] && !rest[0].startsWith("-") ? rest[0] : undefined;
  const v = parseFlags(name ? rest.slice(1) : rest, { repos: { type: "string" }, team: { type: "boolean" }, json: { type: "boolean" } });
  if (sub === "save") {
    if (!name) throw new AihubError("usage: aihub worktree groups save <name> --repos a,b,c [--team]");
    // --team: in team.yaml of this repository (for everyone, commit it); else personal
    const g = v.team ? saveTeamGroup(ctx, name, list(v.repos)) : saveGroup(ctx, name, list(v.repos));
    return void ctx.out(v.json ? JSON.stringify(g) : `group ${g.name}: ${g.repos.map((r) => r.name).join(", ")}`);
  }
  if (sub === "remove") {
    if (!name) throw new AihubError("usage: aihub worktree groups remove <name>");
    return void ctx.out(removeGroup(ctx, name) ? `group ${name} removed` : `no saved group '${name}'`);
  }
  if (sub === "list" || sub === undefined) {
    const all = listGroups(ctx).map((g) => ({ ...g, ...(({ dirs, missing }) => ({ present: dirs.map((d) => d.name), missing }))(groupDirs(ctx, g)) }));
    return void ctx.out(v.json ? JSON.stringify(all) : all.length ? all.map((g) => `${g.name} (${g.source}): ${g.repos.map((r) => r.name).join(", ")}${g.missing.length ? `  [not on this PC: ${g.missing.join(", ")}]` : ""}`).join("\n") : "no repo groups; save one: aihub worktree groups save <name> --repos a,b,c");
  }
  throw new AihubError("usage: aihub worktree groups list|save <name> --repos a,b|remove <name>");
}

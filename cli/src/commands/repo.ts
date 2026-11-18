import type { Ctx } from "../lib/context.js";
import { devopsClient, flags, need, requireFlag } from "../lib/devops.js";
import { branchCreate, branchDelete, branchList, branchLock, commitShow, commitsList, forkCreate, forksList, pushesList, repoDiff, repoFile, repoShow, repoTree, statusList, statusPost, tagCreate, tagDelete, tagList } from "../lib/repoAdmin.js";

export const USAGE =
  "aihub repo show | branch list [--filter p] [--stats] | branch create|delete|lock|unlock --name B [--from ref] | tag list|create|delete [--name T] [--from ref] [--message m|--lightweight] | tree [--path p] [--recursive] | file --path p [--lines a-b] | commits [--path p] [--author a] [--since d] | commit --id sha | diff --base ref --target ref | pushes [--branch b] | status list|post --sha sha [--state s --name n] | forks list|create  (all take --repo R, --branch/--tag/--commit for the version, --json)";

/** Server-side repository operations: branches, tags, files, commits, pushes, statuses, forks. Local work stays with git. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...r1] = argv;
  const s = need(sub, ["show", "branch", "tag", "tree", "file", "commits", "commit", "diff", "pushes", "status", "forks"], USAGE);
  const grouped = ["branch", "tag", "status", "forks"].includes(s);
  const action = grouped ? r1[0] : undefined;
  const rest = grouped ? r1.slice(1) : r1;
  const v = flags(rest, {
    repo: { type: "string" },
    name: { type: "string" },
    from: { type: "string" },
    stats: { type: "boolean" },
    message: { type: "string" },
    lightweight: { type: "boolean" },
    path: { type: "string" },
    recursive: { type: "boolean" },
    lines: { type: "string" },
    branch: { type: "string" },
    tag: { type: "string" },
    commit: { type: "string" },
    author: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    id: { type: "string" },
    base: { type: "string" },
    target: { type: "string" },
    sha: { type: "string" },
    state: { type: "string" },
    description: { type: "string" },
    genre: { type: "string" },
    url: { type: "string" },
    "base-tag": { type: "boolean" },
    "into-project": { type: "string" },
  });
  const { client: base } = devopsClient(ctx, v);
  const c = typeof v.repo === "string" && v.repo ? base.forRepo(v.repo) : base;
  switch (s) {
    case "show":
      return repoShow(c, ctx, v);
    case "branch": {
      const a = need(action, ["list", "create", "delete", "lock", "unlock"], USAGE);
      if (a === "list") return branchList(c, ctx, v);
      const name = requireFlag(v, "name", "the branch name");
      if (a === "create") return branchCreate(c, ctx, v, name);
      if (a === "delete") return branchDelete(c, ctx, v, name);
      return branchLock(c, ctx, v, name, a === "lock");
    }
    case "tag": {
      const a = need(action, ["list", "create", "delete"], USAGE);
      if (a === "list") return tagList(c, ctx, v);
      const name = requireFlag(v, "name", "the tag name");
      return a === "create" ? tagCreate(c, ctx, v, name) : tagDelete(c, ctx, v, name);
    }
    case "tree":
      return repoTree(c, ctx, v);
    case "file":
      return repoFile(c, ctx, v, requireFlag(v, "path", "the file path"));
    case "commits":
      return commitsList(c, ctx, v);
    case "commit":
      return commitShow(c, ctx, v, requireFlag(v, "id", "a commit sha"));
    case "diff":
      return repoDiff(c, ctx, v, requireFlag(v, "base", "a branch, tag or commit"), requireFlag(v, "target", "a branch, tag or commit"));
    case "pushes":
      return pushesList(c, ctx, v);
    case "status": {
      const a = need(action, ["list", "post"], USAGE);
      const sha = requireFlag(v, "sha", "a commit sha");
      return a === "list" ? statusList(c, ctx, v, sha) : statusPost(c, ctx, v, sha);
    }
    default: {
      const a = need(action, ["list", "create"], USAGE);
      return a === "list" ? forksList(c, ctx, v) : forkCreate(c, ctx, v);
    }
  }
}

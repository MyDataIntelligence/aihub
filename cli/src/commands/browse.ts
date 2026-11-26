import { num, parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { browseOf, BrowseError, errorJson } from "../lib/browse/core.js";

export const BROWSE_USAGE = `usage: aihub browse <sub> [--org O] [--refresh]   (always JSON; a failure is {"error":{"kind","message"}} and exit 1)
  projects                                                    every project and repository you can read, with the local clone
  project  --project P [--days 30]                            project page: repositories, languages, recent files, active authors
  repo     --project P --repo R [--ref <branch|tag:T|commit:SHA>]   repository page: README, root, branches, PRs, commits, pipelines
  items    --project P --repo R [--path /dir] [--ref ...] [--last-commit]   one folder level
  file     --project P --repo R --path /file [--ref ...] [--max-bytes N]    file content (binary or too large: content null)
  branches --project P --repo R [--filter t] [--top 50]
  history  --project P --repo R [--path /p] [--ref ...] [--top 50] [--skip 0]
  diff     --project P --repo R --commit SHA --path /file     the change of one commit to one file
  blame    --project P --repo R --path /file [--ref ...]      only for a repository cloned on this PC (git blame)
  find     --query <file name> [--top 50] [--repos P/R,...]   Ctrl+P over all repositories (Code Search, else recent trees)
  search   --text <text> [--project P] [--repo R] [--path /p] [--ext py,sql] [--top 25]   Code Search
  push     --project P --repo R --path /file --base-commit SHA --base-branch B --content-file F --branch feature/x --message-file M
           [--pr [--target T] [--story N] [--pr-title t] [--draft]] [--rebase]   one commit on a new branch, no clone
  pr       --project P --repo R --branch B [--target T] [--story N] [--pr-title t] [--draft]   Create Pull Request after a push
  suggest-branch [--story N] --path /file [--title t]`;

const SUBS = ["projects", "project", "repo", "items", "file", "branches", "history", "diff", "blame", "find", "search", "push", "pr", "suggest-branch"];

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || !SUBS.includes(sub)) throw new AihubError(BROWSE_USAGE);
  const v = parse(rest, {
    org: { type: "string" },
    project: { type: "string" },
    repo: { type: "string" },
    repos: { type: "string" },
    ref: { type: "string" },
    path: { type: "string" },
    commit: { type: "string" },
    query: { type: "string" },
    text: { type: "string" },
    ext: { type: "string" },
    filter: { type: "string" },
    top: { type: "string" },
    skip: { type: "string" },
    days: { type: "string" },
    "max-bytes": { type: "string" },
    "last-commit": { type: "boolean" },
    refresh: { type: "boolean" },
    "base-commit": { type: "string" },
    "base-branch": { type: "string" },
    "content-file": { type: "string" },
    "message-file": { type: "string" },
    branch: { type: "string" },
    pr: { type: "boolean" },
    target: { type: "string" },
    story: { type: "string" },
    "pr-title": { type: "string" },
    title: { type: "string" },
    draft: { type: "boolean" },
    rebase: { type: "boolean" },
    json: { type: "boolean" },
  }).values;
  try {
    ctx.out(JSON.stringify(await answer(sub, v, ctx)));
  } catch (e) {
    ctx.out(JSON.stringify(errorJson(e)));
    throw e instanceof AihubError ? e : new AihubError((e as Error).message);
  }
}

type V = Record<string, string | boolean | undefined>;

const need = (v: V, flag: string): string => {
  const x = v[flag];
  if (typeof x !== "string" || !x.trim()) throw new BrowseError("badInput", `aihub browse needs --${flag} (aihub browse --help)`);
  return x;
};

const str = (v: V, flag: string) => (typeof v[flag] === "string" ? (v[flag] as string) : undefined);
const list = (s: string | undefined) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

async function answer(sub: string, v: V, ctx: Ctx): Promise<unknown> {
  if (sub === "suggest-branch") {
    const { suggestBranch } = await import("../lib/browse/push.js");
    return { branch: suggestBranch(num(str(v, "story"), "--story"), str(v, "path") ?? "", str(v, "title")) };
  }
  const b = browseOf(ctx, { org: str(v, "org"), refresh: !!v.refresh });
  const repoArgs = () => ({ project: need(v, "project"), repo: need(v, "repo") });
  const remember = async (project: string, repo: string) => (await import("../lib/browse/search.js")).rememberRepo(b, project, repo);
  const read = await import("../lib/browse/read.js");
  switch (sub) {
    case "projects":
      return read.browseProjects(b);
    case "project":
      return read.browseProject(b, need(v, "project"), num(str(v, "days"), "--days") ?? 30);
    case "repo": {
      const r = await read.browseRepo(b, { ...repoArgs(), ref: str(v, "ref") });
      await remember(r.repo.project, r.repo.repo);
      return r;
    }
    case "items": {
      const r = await read.browseItems(b, { ...repoArgs(), path: str(v, "path"), ref: str(v, "ref"), lastCommit: !!v["last-commit"] });
      await remember(need(v, "project"), need(v, "repo"));
      return r;
    }
    case "file": {
      const r = await read.browseFile(b, { ...repoArgs(), path: need(v, "path"), ref: str(v, "ref"), maxBytes: num(str(v, "max-bytes"), "--max-bytes") });
      await remember(need(v, "project"), need(v, "repo"));
      return r;
    }
    case "branches":
      return read.browseBranches(b, { ...repoArgs(), filter: str(v, "filter"), top: num(str(v, "top"), "--top") });
    case "history":
      return read.browseHistory(b, { ...repoArgs(), path: str(v, "path"), ref: str(v, "ref"), top: num(str(v, "top"), "--top"), skip: str(v, "skip") === "0" ? 0 : num(str(v, "skip"), "--skip") });
    case "diff":
      return read.browseDiff(b, { ...repoArgs(), commit: need(v, "commit"), path: need(v, "path") });
    case "blame":
      return read.browseBlame(b, { ...repoArgs(), path: need(v, "path"), ref: str(v, "ref") });
    case "find":
      return (await import("../lib/browse/search.js")).browseFind(b, { query: need(v, "query"), top: num(str(v, "top"), "--top"), repos: list(str(v, "repos")) });
    case "search":
      return (await import("../lib/browse/search.js")).browseSearch(b, { text: need(v, "text"), project: str(v, "project"), repo: str(v, "repo"), path: str(v, "path"), ext: list(str(v, "ext")), top: num(str(v, "top"), "--top") });
    case "pr":
      return (await import("../lib/browse/push.js")).browsePr(b, { ...repoArgs(), branch: need(v, "branch"), target: str(v, "target"), story: num(str(v, "story"), "--story"), prTitle: str(v, "pr-title"), draft: !!v.draft });
    case "push": {
      const p = await import("../lib/browse/push.js");
      return p.browsePush(b, {
        ...repoArgs(),
        path: need(v, "path"),
        baseCommit: need(v, "base-commit"),
        baseBranch: need(v, "base-branch"),
        content: p.readText(need(v, "content-file")),
        message: p.readText(need(v, "message-file")),
        branch: need(v, "branch"),
        pr: !!v.pr,
        target: str(v, "target"),
        story: num(str(v, "story"), "--story"),
        prTitle: str(v, "pr-title"),
        draft: !!v.draft,
        rebase: !!v.rebase,
      });
    }
  }
  throw new AihubError(BROWSE_USAGE);
}

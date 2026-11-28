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
  search   --text <text> [--project P] [--repo R] [--scope P,P/R,...] [--branch B] [--path /p] [--ext py,sql] [--top 25] [--local]
           Code Search; without it (or --local) the clones on this PC (ripgrep, else git grep), nothing sent
  push     --project P --repo R --path /file --base-commit SHA --base-branch B --content-file F --branch feature/x --message-file M
           [--pr [--target T] [--story N] [--pr-title t] [--draft]] [--rebase]   one commit on a new branch, no clone
  pr       --project P --repo R --branch B [--target T] [--story N] [--pr-title t] [--draft]   Create Pull Request after a push
  suggest-branch [--story N] --path /file [--title t]
  pipelines --project P                                       pipelines of a project: folders, repo, YAML, default branch, latest run
  pipeline  --project P --pipeline ID [--top 8]               one pipeline with its latest runs
  run-plan  --project P --pipeline ID [--ref <branch|tag:T|commit:SHA>]   the run form from the YAML on that ref
  run       --project P --pipeline ID (--branch B|--tag T) [--commit SHA] [--changes-file F]   start a run
  artifacts --project P --run N                               artifacts of a run
  artifact-files --project P --run N --artifact A             the files in one artifact
  artifact-open  --project P --run N --artifact A [--path p] [--max-bytes N]   one file (or the zip) in a temporary folder
  draft-create --project P --repo R --name N --branch feature/x (--from-pipeline ID | --empty)   draft-N in \Drafts on its own branch
  drafts       --project P                                    the draft pipelines (draft-* in \Drafts)
  draft-delete --project P --pipeline ID [--keep-branch]      only your own draft-* in \Drafts: the pipeline and its branch
  (push takes --pipeline ID too: the answer says whether that pipeline can run on the new branch)`;

const SUBS = ["change", "ask", "projects", "project", "repo", "items", "file", "branches", "history", "diff", "blame", "find", "search", "push", "pr", "suggest-branch", "pipelines", "pipeline", "run-plan", "run", "artifacts", "artifact-files", "artifact-open", "draft-create", "drafts", "draft-delete"];

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub0, ...rest0] = argv;
  // `browse change <action>`: the action is the sub command
  const sub = sub0 === "change" || sub0 === "ask" ? `${sub0}-${rest0[0] ?? ""}` : sub0;
  const rest = sub0 === "change" || sub0 === "ask" ? rest0.slice(1) : rest0;
  if (!sub0 || !SUBS.includes(sub0)) throw new AihubError(BROWSE_USAGE);
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
    id: { type: "string" },
    paths: { type: "string" },
    "prompt-file": { type: "string" },
    file: { type: "string" },
    dir: { type: "string" },
    delete: { type: "boolean" },
    selection: { type: "string" },
    limit: { type: "string" },
    scope: { type: "string" },
    more: { type: "string" },
    local: { type: "boolean" },
    json: { type: "boolean" },
    pipeline: { type: "string" },
    run: { type: "string" },
    tag: { type: "string" },
    "changes-file": { type: "string" },
    artifact: { type: "string" },
    name: { type: "string" },
    "from-pipeline": { type: "string" },
    empty: { type: "boolean" },
    "keep-branch": { type: "boolean" },
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
  if (sub.startsWith("change-")) return changeAnswer(sub.slice(7), v, ctx);
  if (sub.startsWith("ask-")) return askAnswer(sub.slice(4), v, ctx);
  if (sub === "suggest-branch") {
    const { suggestBranch } = await import("../lib/browse/push.js");
    return { branch: suggestBranch(num(str(v, "story"), "--story"), str(v, "path") ?? "", str(v, "title")) };
  }
  const b = browseOf(ctx, { org: str(v, "org"), refresh: !!v.refresh });
  const repoArgs = () => ({ project: need(v, "project"), repo: need(v, "repo") });
  const remember = async (project: string, repo: string) => (await import("../lib/browse/search.js")).rememberRepo(b, project, repo);
  const read = await import("../lib/browse/read.js");
  const pipes = () => import("../lib/browse/pipelines.js");
  const id = (flag: string) => {
    const n = num(need(v, flag), `--${flag}`);
    if (!n) throw new BrowseError("badInput", `--${flag} must be a number`);
    return n;
  };
  switch (sub) {
    case "pipelines":
      return (await pipes()).browsePipelines(b, need(v, "project"));
    case "pipeline":
      return (await pipes()).browsePipeline(b, need(v, "project"), id("pipeline"), num(str(v, "top"), "--top") ?? 8);
    case "run-plan":
      return (await pipes()).browseRunPlan(b, need(v, "project"), id("pipeline"), str(v, "ref"));
    case "run":
      return (await pipes()).browseRun(b, need(v, "project"), id("pipeline"), { branch: str(v, "branch"), tag: str(v, "tag"), commit: str(v, "commit"), changesFile: str(v, "changes-file") });
    case "artifacts":
      return (await pipes()).browseArtifacts(b, need(v, "project"), id("run"));
    case "artifact-files":
      return (await pipes()).browseArtifactFiles(b, need(v, "project"), id("run"), need(v, "artifact"));
    case "artifact-open":
      return (await pipes()).browseArtifactOpen(b, need(v, "project"), id("run"), need(v, "artifact"), str(v, "path"), num(str(v, "max-bytes"), "--max-bytes"));
    case "draft-create":
      return (await pipes()).browseDraftCreate(b, { project: need(v, "project"), repo: need(v, "repo"), name: need(v, "name"), branch: need(v, "branch"), fromPipeline: num(str(v, "from-pipeline"), "--from-pipeline"), empty: !!v.empty });
    case "drafts":
      return (await pipes()).browseDrafts(b, need(v, "project"));
    case "draft-delete":
      return (await pipes()).browseDraftDelete(b, need(v, "project"), id("pipeline"), { keepBranch: !!v["keep-branch"] });
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
      {
      const s = await import("../lib/browse/search.js");
      return s.browseSearch(b, { text: need(v, "text"), scope: s.parseScope(str(v, "scope")), project: str(v, "project"), repo: str(v, "repo"), path: str(v, "path"), ext: list(str(v, "ext")), branch: str(v, "branch"), top: num(str(v, "top"), "--top"), local: !!v.local });
    }
    case "pr":
      return (await import("../lib/browse/push.js")).browsePr(b, { ...repoArgs(), branch: need(v, "branch"), target: str(v, "target"), story: num(str(v, "story"), "--story"), prTitle: str(v, "pr-title"), draft: !!v.draft });
    case "push": {
      const p = await import("../lib/browse/push.js");
      const pushed = await p.browsePush(b, {
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
      // --pipeline: can that pipeline run on the branch just pushed?
      if (pushed.status === "pushed" && str(v, "pipeline")) return { ...pushed, pipeline: await (await pipes()).runnableOn(b, need(v, "project"), id("pipeline"), need(v, "repo"), need(v, "path")) };
      return pushed;
    }
  }
  throw new AihubError(BROWSE_USAGE);
}

/** --selection /path:16-23 */
function selectionOf(s: string | undefined): { path: string; startLine: number; endLine: number } | undefined {
  if (!s) return undefined;
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(s.trim());
  if (!m) throw new AihubError("--selection is /path:<from>-<to>, for example /notebooks/load_orders.py:16-23");
  return { path: m[1], startLine: Number(m[2]), endLine: Number(m[3] ?? m[2]) };
}

async function changeAnswer(action: string, v: V, ctx: Ctx): Promise<unknown> {
  const c = await import("../lib/browse/change.js");
  const { readText } = await import("../lib/browse/push.js");
  if (action === "list") return c.changeList(ctx.env);
  if (action === "discard") return c.changeDiscard(ctx.env, need(v, "id"));
  if (action === "summary") return c.changeSummary(ctx.env, need(v, "id"), readText(need(v, "file")));
  if (action === "start") {
    const b = browseOf(ctx, { org: str(v, "org"), refresh: !!v.refresh });
    return c.changeStart(b, { project: need(v, "project"), repo: need(v, "repo"), ref: str(v, "ref"), branch: str(v, "branch"), story: num(str(v, "story"), "--story"), paths: list(str(v, "paths")), prompt: str(v, "prompt-file") ? readText(str(v, "prompt-file")!) : undefined, selection: selectionOf(str(v, "selection")) });
  }
  // the other actions belong to an existing change: its organisation is in the change
  const id = need(v, "id");
  const b = browseOf(ctx, { org: c.readMeta(ctx.env, id).meta.org, refresh: !!v.refresh });
  if (action === "read") return c.changeRead(b, id, need(v, "path"));
  if (action === "write") return c.changeWrite(b, id, need(v, "path"), { content: readText(need(v, "content-file")) });
  if (action === "rm") return c.changeWrite(b, id, need(v, "path"), { delete: true });
  if (action === "diff") {
    const { contents: _c, ...d } = await c.changeDiff(b, id);
    return d;
  }
  if (action === "push")
    return c.changePush(b, id, { message: str(v, "message-file") ? readText(str(v, "message-file")!) : undefined, branch: str(v, "branch"), pr: !!v.pr, target: str(v, "target"), story: num(str(v, "story"), "--story"), prTitle: str(v, "pr-title"), draft: !!v.draft, rebase: !!v.rebase });
  if (action === "apply") return c.changeApply(b, id, need(v, "dir"));
  throw new AihubError(BROWSE_USAGE);
}

async function askAnswer(action: string, v: V, ctx: Ctx): Promise<unknown> {
  const a = await import("../lib/browse/ask.js");
  const { readText } = await import("../lib/browse/push.js");
  if (action === "list") return a.askList(ctx.env);
  if (action === "discard") return a.askDiscard(ctx.env, need(v, "id"));
  if (action === "allow") return a.askAllow(ctx.env, need(v, "id"), num(str(v, "more"), "--more"));
  if (action === "report") return a.askReport(ctx.env, need(v, "id"), readText(need(v, "file")));
  if (action === "start") {
    const scope = (str(v, "scope") ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => (x.includes("/") ? { project: x.slice(0, x.indexOf("/")), repo: x.slice(x.indexOf("/") + 1) } : { project: x }));
    const b = browseOf(ctx, { org: str(v, "org"), refresh: !!v.refresh });
    return a.askStart(b, { scope, prompt: readText(need(v, "prompt-file")), story: num(str(v, "story"), "--story"), limit: num(str(v, "limit"), "--limit") });
  }
  const id = need(v, "id");
  const b = browseOf(ctx, { org: a.readAsk(ctx.env, id).meta.org, refresh: !!v.refresh });
  if (action === "read") return a.askRead(b, id, { project: need(v, "project"), repo: need(v, "repo"), path: need(v, "path") });
  if (action === "propose") return a.askPropose(b, id, { project: need(v, "project"), repo: need(v, "repo"), path: need(v, "path"), content: readText(need(v, "content-file")) });
  if (action === "state") return a.askState(b, id);
  if (action === "apply") return a.askApply(b, id, { project: need(v, "project"), repo: need(v, "repo"), branch: str(v, "branch"), story: num(str(v, "story"), "--story") });
  throw new AihubError(BROWSE_USAGE);
}

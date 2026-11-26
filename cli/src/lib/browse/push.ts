import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { getWorkItemTitle } from "../ado.js";
import { compose, DEFAULT_EMPTY, resolveTemplate, templateCandidates } from "../templates.js";
import { TEAM_FILE, type TeamConfig } from "../team.js";
import { BrowseError, kindOf, normPath, repoClientOf, shortSha, webCommitUrl, webRepoUrl, type Browse, type Person } from "./core.js";
import { browseHistory, readFileAt } from "./read.js";
import { hunks, merge3, type Hunk } from "./lineDiff.js";

/**
 * Save an edited file without a clone: one commit on a NEW feature branch through the Pushes API, optionally a pull request
 * to the default branch (the team's template from the remote, the story linked). Pushing to main, staging, master, develop
 * or a protected branch of team.yaml is refused. When the file changed on the base branch since the version that was read,
 * nothing is pushed and the answer is a conflict; `rebase` re-applies the change on the newest version when the lines do
 * not overlap.
 */

export const NEVER_PUSH = ["main", "master", "staging", "develop"];
const ZERO = "0".repeat(40);

export interface PushInput {
  project: string;
  repo: string;
  path: string;
  /** the commit the file was read at (ref.commit of browse file) */
  baseCommit: string;
  /** the branch the file was read on; its newest version is checked for changes */
  baseBranch: string;
  content: string;
  branch: string;
  message: string;
  pr?: boolean;
  /** the pull request's target; default: the repository's default branch */
  target?: string;
  story?: number;
  prTitle?: string;
  draft?: boolean;
  rebase?: boolean;
}

export type PushResult =
  | {
      status: "pushed";
      branch: string;
      commit: { id: string; short: string; webUrl: string };
      startedFrom: string;
      rebased: boolean;
      pr: { id: number; title: string; webUrl: string } | null;
      prError: string | null;
      webUrl: string;
    }
  | {
      status: "conflict";
      path: string;
      baseCommit: string;
      latest: { id: string; short: string; message: string; at: string | null; by: Person } | null;
      overlap: boolean;
      mine: { hunks: Hunk[] };
      theirs: { hunks: Hunk[] };
    };

export function isProtected(branch: string, team: TeamConfig, extra: string[] = []): boolean {
  const b = branch.replace(/^refs\/heads\//, "").toLowerCase();
  const list = [...NEVER_PUSH, ...(team.branches?.protected ?? []), ...extra].map((x) => x.toLowerCase());
  return list.some((p) => (p.endsWith("*") ? b.startsWith(p.slice(0, -1)) : b === p));
}

/** A feature-branch name from the story and the file: feature/<story>-<words of the file name>. */
export function suggestBranch(story: number | undefined, path: string, title?: string): string {
  const words = (title || (path.split("/").pop() ?? "change").replace(/\.[^.]+$/, ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .join("-");
  return `feature/${story ? `${story}-` : ""}${words || "change"}`;
}

export const readText = (file: string): string => {
  const b = readFileSync(file);
  return b.toString("utf8").replace(/^\uFEFF/, "");
};

async function teamOf(b: Browse, project: string, repo: string, branch: string): Promise<TeamConfig> {
  try {
    const f = await readFileAt(b, project, repo, `/${TEAM_FILE}`, { name: branch, kind: "branch" });
    return (f.content ? (parse(f.content) as TeamConfig) : {}) ?? {};
  } catch {
    return {};
  }
}

async function headOf(b: Browse, project: string, repo: string, branch: string): Promise<string | undefined> {
  const rc = repoClientOf(b, project, repo);
  const r = await rc.get<{ value?: { name: string; objectId: string }[] }>(`${rc.repoPath()}/refs`, { filter: `heads/${branch}` });
  return r.value?.find((x) => x.name === `refs/heads/${branch}`)?.objectId;
}

/** The file at a version, or null when it is not there. */
async function contentAt(b: Browse, project: string, repo: string, path: string, commit: string): Promise<{ content: string | null; objectId: string } | null> {
  try {
    const f = await readFileAt(b, project, repo, path, { name: commit, kind: "commit" }, 4 * 1024 * 1024);
    return { content: f.content, objectId: f.objectId };
  } catch (e) {
    if (kindOf(e) === "notFound") return null;
    throw e;
  }
}

export async function browsePush(b: Browse, o: PushInput): Promise<PushResult> {
  const path = normPath(o.path);
  const branch = o.branch.trim().replace(/^refs\/heads\//, "");
  if (!branch || /\s|\.\.|[~^:?*[\\]|\/$|^\/|\.lock$/.test(branch)) throw new BrowseError("badInput", `'${o.branch}' is not a valid branch name`);
  if (!/^[0-9a-f]{40}$/i.test(o.baseCommit)) throw new BrowseError("badInput", "--base-commit must be the full commit id the file was read at (ref.commit of aihub browse file)");
  if (!o.message.trim()) throw new BrowseError("badInput", "a commit message is needed (--message-file)");
  const rc = repoClientOf(b, o.project, o.repo);
  const repoInfo = await rc.get<{ id: string; defaultBranch?: string }>(rc.repoPath());
  const def = (repoInfo.defaultBranch ?? "").replace(/^refs\/heads\//, "");
  const team = await teamOf(b, o.project, o.repo, def || o.baseBranch);
  if (isProtected(branch, team, [def, o.baseBranch])) throw new BrowseError("protectedBranch", `pushing to '${branch}' is refused: a change goes to a new feature branch (for example ${suggestBranch(o.story, path)})`);
  if (await headOf(b, o.project, o.repo, branch)) throw new BrowseError("branchExists", `branch '${branch}' already exists in ${o.repo}: choose another name`);

  // did the file change on the base branch since it was read?
  const head = await headOf(b, o.project, o.repo, o.baseBranch);
  if (!head) throw new BrowseError("notFound", `branch '${o.baseBranch}' not found in ${o.repo}`);
  const base = await contentAt(b, o.project, o.repo, path, o.baseCommit);
  let startFrom = o.baseCommit;
  let content = o.content;
  let rebased = false;
  if (head.toLowerCase() !== o.baseCommit.toLowerCase()) {
    const now = await contentAt(b, o.project, o.repo, path, head);
    if ((base?.objectId ?? null) !== (now?.objectId ?? null)) {
      const baseText = base?.content ?? "";
      const theirs = now?.content ?? "";
      const m = now && base?.content !== null && now.content !== null ? merge3(baseText, o.content, theirs) : { overlap: true as const, merged: undefined };
      if (o.rebase && !m.overlap && m.merged !== undefined) {
        content = m.merged;
        startFrom = head;
        rebased = true;
      } else {
        const hist = await browseHistory({ ...b, refresh: true }, { project: o.project, repo: o.repo, path, ref: o.baseBranch, top: 1 }).catch(() => undefined);
        const c = hist?.commits[0];
        return {
          status: "conflict",
          path,
          baseCommit: o.baseCommit,
          latest: c ? { id: c.id, short: c.short, message: c.message, at: c.at, by: c.by } : null,
          overlap: m.overlap,
          mine: { hunks: hunks(baseText, o.content) },
          theirs: { hunks: hunks(baseText, theirs) },
        };
      }
    }
  }

  const pushed = await rc.post<{ commits?: { commitId: string }[]; refUpdates?: { name: string; newObjectId: string }[] }>(`${rc.repoPath()}/pushes`, {
    refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId: ZERO }],
    commits: [{ comment: o.message.trim(), parents: [startFrom], changes: [{ changeType: base ? "edit" : "add", item: { path }, newContent: { content, contentType: "rawtext" } }] }],
  });
  const commitId = pushed.commits?.[0]?.commitId ?? pushed.refUpdates?.[0]?.newObjectId ?? "";
  const out: Extract<PushResult, { status: "pushed" }> = {
    status: "pushed",
    branch,
    commit: { id: commitId, short: shortSha(commitId), webUrl: webCommitUrl(b, o.project, o.repo, commitId) },
    startedFrom: startFrom,
    rebased,
    pr: null,
    prError: null,
    webUrl: `${webRepoUrl(b, o.project, o.repo)}?version=GB${encodeURIComponent(branch)}`,
  };
  if (o.pr) {
    try {
      out.pr = await createRemotePr(b, { ...o, branch, path, target: o.target || def || o.baseBranch, commitId, team });
    } catch (e) {
      out.prError = (e as Error).message; // the branch is pushed; the PR can be made from the notification
    }
  }
  return out;
}

/** A pull request from a pushed branch without a clone: the template of the target branch on the remote, the story linked. */
export async function createRemotePr(b: Browse, o: { project: string; repo: string; branch: string; target: string; path: string; message: string; story?: number; prTitle?: string; draft?: boolean; commitId: string; team: TeamConfig }): Promise<{ id: number; title: string; webUrl: string }> {
  const rc = repoClientOf(b, o.project, o.repo);
  const tplFiles = new Map<string, string>();
  for (const p of templateCandidates(o.target)) {
    try {
      const f = await readFileAt(b, o.project, o.repo, `/${p}`, { name: o.target, kind: "branch" });
      if (f.content !== null) {
        tplFiles.set(p, f.content);
        break;
      }
    } catch {
      /* not this one */
    }
  }
  const tpl = resolveTemplate(o.target, { readRef: (_b, p) => tplFiles.get(p) });
  const storyTitle = o.story ? await getWorkItemTitle(b.client.forProject(o.project), o.story) : undefined;
  const subject = o.message.trim().split(/\r?\n/)[0];
  const title = o.prTitle?.trim() || (o.story && storyTitle ? `${o.story} ${storyTitle}` : subject);
  const commits = `- ${subject} (${shortSha(o.commitId)})`;
  const nl = (o.team as { language?: string }).language === "nl";
  const description = tpl
    ? compose({
        template: tpl.content,
        body: "",
        code: { story: o.story ? `AB#${o.story}` : undefined, commits },
        emptyText: o.team.pullRequest?.emptySection || DEFAULT_EMPTY,
        optionalSections: o.team.pullRequest?.optionalSections,
        fallback: { changes: `- ${o.path}: ${subject}`, tests: nl ? "Nog niet uitgevoerd." : "Not run yet." },
      }).text
    : [o.story ? `AB#${o.story}` : "", `## Commits\n\n${commits}`].filter(Boolean).join("\n\n") + "\n";
  const pr = await rc.post<{ pullRequestId: number; title: string }>(`${rc.repoPath()}/pullrequests`, {
    sourceRefName: `refs/heads/${o.branch}`,
    targetRefName: `refs/heads/${o.target}`,
    title,
    description,
    isDraft: !!o.draft,
    ...(o.story ? { workItemRefs: [{ id: String(o.story) }] } : {}),
  });
  return { id: pr.pullRequestId, title: pr.title ?? title, webUrl: `${webRepoUrl(b, o.project, o.repo)}/pullrequest/${pr.pullRequestId}` };
}

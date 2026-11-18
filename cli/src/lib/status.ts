import { findActivePr, type AdoClient, type PullRequest } from "./ado.js";
import { reviewersOf, type Reviewer } from "./prList.js";
import { getThreads } from "./comments.js";
import { repoClient, type Ctx } from "./context.js";
import { currentBranch, workItemFromBranch } from "./git.js";
import { hasWorkToCommit, unpushedCount } from "./gitx.js";
import { readNotes } from "./notes.js";
import { latestPerDefinition, selectBuilds, type Build } from "./pipeline.js";
import { loadTeam } from "./team.js";
import { getWorkItem, isProtected } from "./workitems.js";

export type Checks = "none" | "running" | "green" | "red";

export interface Status {
  repo: string;
  branch: string;
  story: { id: number; title: string; state: string } | null;
  pr: { id: number; title: string; status: string; draft: boolean; url: string; reviewers: Reviewer[] } | null;
  pipeline: { name: string; state: string }[];
  checks: Checks;
  openThreads: number;
  dirty: boolean;
  unpushed: number;
  notes: number;
  done: string[];
  next: string;
  warnings: string[];
}

const stateOf = (b: Build) => (b.status === "completed" ? (b.result ?? "completed") : (b.status ?? "unknown"));

export function checksOf(builds: Build[]): Checks {
  if (!builds.length) return "none";
  if (builds.some((b) => b.status !== "completed")) return "running";
  return builds.every((b) => b.result === "succeeded" || b.result === "partiallySucceeded") ? "green" : "red";
}

/** The next step of the story-run flow for a state; the order is the flow's order. */
export interface StepInput {
  branch: string;
  story: Status["story"];
  pr: { id: number; draft: boolean } | null;
  checks: Checks;
  openThreads: number;
  dirty: boolean;
  unpushed: number;
  protectedBranch: boolean;
  prCompleted: boolean;
}

export function nextStep(s: StepInput): { done: string[]; next: string } {
  const done: string[] = [];
  if (s.story) done.push(`story ${s.story.id} started on branch ${s.branch}`);
  if (s.prCompleted) {
    done.push("pull request completed");
    return { done, next: "story-finish: clean up the branch and close the story (aihub story finish --id N)" };
  }
  if (s.protectedBranch || !s.story) {
    return {
      done,
      next: s.protectedBranch
        ? `on '${s.branch}', no feature branch: start a story (aihub story start --id N) or switch to the story branch`
        : "no story id in the branch name: link it (aihub story link --id N) or start the story (aihub story start --id N)",
    };
  }
  if (s.dirty) return { done, next: "commit the open changes with your own git, then continue (implement)" };
  if (s.unpushed > 0 && !s.pr) return { done, next: "push the branch and create the PR (aihub pr create)" };
  if (!s.pr) {
    return { done, next: "implement the story, then create the PR (aihub pr create)" };
  }
  done.push(`PR !${s.pr.id} open${s.pr.draft ? " (draft)" : ""}`);
  if (s.unpushed > 0) return { done, next: "push the new commits (git push), then watch the pipeline (aihub pipeline follow)" };
  if (s.checks === "running") return { done, next: "wait for the pipeline: aihub pipeline follow" };
  if (s.checks === "red") return { done, next: "fix the failing pipeline: aihub pipeline follow shows the failed step (pipeline-fix)" };
  if (s.checks === "green") done.push("pipeline green");
  if (s.openThreads > 0) return { done, next: `process ${s.openThreads} open review thread(s): aihub comments get (review-process)` };
  if (s.checks === "none") return { done, next: "no pipeline run found yet: check aihub pipeline status, or ask for review" };
  return { done, next: "green and no open threads: report to the user; completing the PR is story-finish and their call" };
}

async function completedPr(client: AdoClient, branch: string): Promise<PullRequest | undefined> {
  const prs = await client.list<PullRequest>(`${client.repoPath()}/pullrequests`, {
    "searchCriteria.sourceRefName": `refs/heads/${branch}`,
    "searchCriteria.status": "completed",
  });
  return prs[0];
}

export async function getStatus(ctx: Ctx): Promise<Status> {
  const { root, client } = repoClient(ctx);
  const branch = currentBranch(root);
  const team = loadTeam(root);
  const warnings: string[] = [];
  const guard = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      warnings.push(`${what}: ${(e as Error).message}`);
      return undefined;
    }
  };

  const storyId = workItemFromBranch(branch);
  const wi = storyId ? await guard("story", () => getWorkItem(client, storyId)) : undefined;
  const story = storyId ? { id: storyId, title: wi?.title ?? "(unknown)", state: wi?.state ?? "?" } : null;

  const active = await guard("pull request", () => findActivePr(client, branch));
  const done = !active ? await guard("pull request", () => completedPr(client, branch)) : undefined;
  const pr = active ?? done;

  const sel = active
    ? await guard("pipeline", () => selectBuilds(client, root, { pr: String(active.pullRequestId) }))
    : story
      ? await guard("pipeline", () => selectBuilds(client, root, { branch }))
      : undefined;
  const latest = latestPerDefinition(sel?.builds ?? []);
  const checks = checksOf(latest);

  const threads = active ? await guard("threads", () => getThreads(client, active.pullRequestId, undefined, false)) : undefined;
  const openThreads = threads?.length ?? 0;
  const dirty = hasWorkToCommit(root);
  const unpushed = unpushedCount(root);
  const notes = readNotes(root, branch).length;
  const prCompleted = !!done;

  const step = nextStep({
    branch,
    story,
    pr: active ? { id: active.pullRequestId, draft: !!active.isDraft } : null,
    checks,
    openThreads,
    dirty,
    unpushed,
    protectedBranch: isProtected(team, branch),
    prCompleted,
  });

  return {
    repo: client.remote.repo,
    branch,
    story,
    pr: pr ? { id: pr.pullRequestId, title: pr.title, status: pr.status, draft: !!pr.isDraft, url: client.prUrl(pr.pullRequestId), reviewers: reviewersOf(pr as { reviewers?: { displayName?: string; vote?: number; isRequired?: boolean }[] }) } : null,
    pipeline: latest.map((b) => ({ name: b.definition?.name ?? "pipeline", state: stateOf(b) })),
    checks,
    openThreads,
    dirty,
    unpushed,
    notes,
    done: step.done,
    next: step.next,
    warnings,
  };
}

export function formatStatus(s: Status): string {
  const L: string[] = [];
  L.push(`${s.repo} @ ${s.branch}`);
  L.push(s.story ? `Story: ${s.story.id} ${s.story.title} [${s.story.state}]` : "Story: none linked");
  L.push(s.pr ? `PR: !${s.pr.id} ${s.pr.title} [${s.pr.status}${s.pr.draft ? ", draft" : ""}] ${s.pr.url}` : "PR: none");
  if (s.pipeline.length) L.push(`Pipeline: ${s.pipeline.map((p) => `${p.name} ${p.state}`).join("; ")}`);
  if (s.pr) L.push(`Open threads: ${s.openThreads}`);
  L.push(`Working tree: ${s.dirty ? "uncommitted changes" : "clean"}${s.unpushed ? `, ${s.unpushed} unpushed commit(s)` : ""}${s.notes ? `, ${s.notes} private note(s)` : ""}`);
  if (s.done.length) L.push(`Done: ${s.done.join("; ")}`);
  L.push(`Next step: ${s.next}`);
  for (const w of s.warnings) L.push(`(could not read ${w})`);
  return L.join("\n");
}

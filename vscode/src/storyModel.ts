/**
 * "My Stories": the pure parts. The data is `aihub story branches --json` (Azure DevOps Development links, local
 * facts, PR) with the star/old/label of each repository's story-worktrees.json laid over it, so a change made in the
 * Worktree Maker shows without a new CLI read. No vscode, no I/O.
 */
import type { BranchStatus, StarSuggestion, StoryBranch } from "../../cli/src/lib/storyWorktrees";
import type { SetModel } from "./repoSetModel";

export interface BranchRowJson {
  repo: string;
  branch: string;
  linked: "ado" | "local" | "both" | "name";
  status: BranchStatus;
  label?: string;
  worktree?: string;
  local: boolean;
  pushed: boolean;
  ahead: number;
  dirty: boolean;
  pr?: { id: number; draft: boolean; status: string };
  lastActive?: string;
}

export interface StoryJson {
  id: number;
  title: string;
  state: string;
  branches: BranchRowJson[];
}

export type StoryNode =
  | { kind: "story"; story: StoryJson }
  | { kind: "repo"; story: StoryJson; repo: string; rows: BranchRowJson[] }
  | { kind: "branch"; story: StoryJson; row: BranchRowJson };

/** The local file of a repository (branch -> entry) wins for star, status and label: it is what was marked last. */
export function overlay(stories: StoryJson[], local: Record<string, Record<string, StoryBranch>>): StoryJson[] {
  return stories.map((s) => ({
    ...s,
    branches: s.branches.map((b) => {
      const e = local[b.repo]?.[b.branch];
      return e && e.storyId === s.id ? { ...b, status: e.status, label: e.label, lastActive: e.lastActive ?? b.lastActive } : b;
    }),
  }));
}

export function storyChildren(n: StoryNode | undefined, stories: StoryJson[]): StoryNode[] {
  if (!n) return stories.map((story) => ({ kind: "story", story }));
  if (n.kind === "story") {
    const repos = [...new Set(n.story.branches.map((b) => b.repo))];
    return repos.map((repo) => ({ kind: "repo", story: n.story, repo, rows: n.story.branches.filter((b) => b.repo === repo) }));
  }
  if (n.kind === "repo") return order(n.rows).map((row) => ({ kind: "branch", story: n.story, row }));
  return [];
}

const rank = (s: BranchStatus) => (s === "current" ? 0 : s === "parked" ? 1 : 2);
const order = (rows: BranchRowJson[]) => [...rows].sort((a, b) => rank(a.status) - rank(b.status) || (b.lastActive ?? "").localeCompare(a.lastActive ?? "") || a.branch.localeCompare(b.branch));

/** The facts of a branch in a few words: local work first, then where it is, then the PR. */
export function branchFacts(b: BranchRowJson): string {
  const where = b.local ? (b.pushed ? (b.ahead ? `${b.ahead} to push` : "pushed") : "local only") : b.pushed ? "remote only" : "gone";
  return [b.dirty ? "uncommitted work" : "", where, b.pr ? `PR !${b.pr.id}${b.pr.draft ? " draft" : ""}` : "", b.linked === "local" || b.linked === "name" ? "not linked in Azure DevOps" : ""].filter(Boolean).join(" · ");
}

export interface ItemView {
  label: string;
  description?: string;
  tooltip: string;
  icon: string;
  /** dimmed (an old branch) */
  dim: boolean;
  contextValue: string;
}

export function itemView(n: StoryNode): ItemView {
  if (n.kind === "story") {
    const star = n.story.branches.filter((b) => b.status === "current").length;
    return { label: `#${n.story.id} ${n.story.title}`, description: `${n.story.state} · ${n.story.branches.length} branch${n.story.branches.length === 1 ? "" : "es"}${star ? "" : " · no ★ yet"}`, tooltip: `Story ${n.story.id}: ${n.story.title}\n${n.story.state}`, icon: "book", dim: false, contextValue: "aihubStory" };
  }
  if (n.kind === "repo") {
    return { label: n.repo, description: `${n.rows.length} branch${n.rows.length === 1 ? "" : "es"}`, tooltip: n.repo, icon: "repo", dim: false, contextValue: "aihubStoryRepo" };
  }
  const b = n.row;
  const star = b.status === "current";
  return {
    label: `${star ? "★ " : ""}${b.branch}`,
    description: [b.status === "old" ? "old" : "", b.label ? `“${b.label}”` : "", branchFacts(b)].filter(Boolean).join(" · "),
    tooltip: [`${b.repo}: ${b.branch}`, star ? "★ the branch you work on" : b.status, b.label ?? "", b.worktree ? `worktree ${b.worktree}` : "no worktree", branchFacts(b)].filter(Boolean).join("\n"),
    icon: star ? "star-full" : b.status === "old" ? "history" : "git-branch",
    dim: b.status === "old",
    contextValue: `aihubStoryBranch-${b.status}${b.worktree ? "-wt" : ""}`,
  };
}

/** `aihub.set` of a workspace file (written by `aihub worktree open` / `story open`) as the status bar's set. */
export function windowSet(v: unknown): SetModel | null {
  const s = v as { story?: number; group?: string; branch?: string; repos?: { name: string; branch: string }[] } | undefined;
  if (!s?.branch || !Array.isArray(s.repos) || !s.repos.length) return null;
  return { story: s.story ?? 0, group: s.group, branch: s.branch, total: s.repos.length, repos: s.repos.map((r) => r.name) };
}

export type AutoMark = "ask" | "auto" | "off";

/** The one notification when the star should move. */
export function starQuestion(s: StarSuggestion): string {
  const why = s.reason === "most activity" ? "You mostly work in" : s.reason === "three sessions in a row" ? "Your last three sessions were in" : "You committed in";
  return `${why} ${s.branch}${s.reason === "commit while the star is quiet" && s.current ? ` while ★ ${s.current} has been quiet for days` : ""}. Mark it as the current ★ for story ${s.storyId}?`;
}

export const STAR_ANSWERS = { yes: "Yes", no: "No", never: "Don't ask again for this story" } as const;

/** What the last reflog line of a worktree says: a commit, a checkout to a branch, or something else. */
export function lastReflog(line: string): { kind: "commit" | "checkout" | "other"; to?: string } {
  const msg = line.split("\t")[1] ?? "";
  if (/^commit( \(.+\))?:/.test(msg)) return { kind: "commit" };
  const m = /^checkout: moving from .+ to (.+)$/.exec(msg);
  return m ? { kind: "checkout", to: m[1].trim() } : { kind: "other" };
}

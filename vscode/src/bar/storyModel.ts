import type { SeenStory } from "../../../cli/src/lib/storyCache";
import type { ScanRepo } from "../../../cli/src/lib/machineScan";
import { storyBranchSuggestion } from "../repoSetModel";
import type { BranchRowJson } from "../storyModel";

/**
 * Open Story and the branch dialogs, the pure parts: which repositories are ticked, the CLI arguments, the branch
 * names. No vscode, no I/O.
 */
export interface StoryRef {
  id: number;
  title: string;
  state?: string;
}

const tier = (b: BranchRowJson): number => (b.linked === "ado" || b.linked === "both" ? 0 : b.linked === "local" ? 1 : 2);
const rank = (s: BranchRowJson["status"]) => (s === "current" ? 0 : s === "parked" ? 1 : 2);

export interface StoryPick {
  row: BranchRowJson;
  /** linked to the story in Azure DevOps (a branch known only locally is not) */
  linked: boolean;
  /** the other existing branches of the story in this repository (information only) */
  others: number;
}

/**
 * Per repository, one branch of the story out of every existing one (local or on the remote, linked in Azure DevOps or
 * not): a branch linked in Azure DevOps goes before one that is not, then the star, then the most recently active.
 * Only a repository with no branch for the story at all has none.
 */
export function storyBranchCandidates(rows: BranchRowJson[]): Map<string, StoryPick> {
  const byRepo = new Map<string, BranchRowJson[]>();
  for (const b of rows.filter((x) => x.local || x.pushed)) byRepo.set(b.repo, [...(byRepo.get(b.repo) ?? []), b]);
  const out = new Map<string, StoryPick>();
  for (const [repo, all] of byRepo) {
    // linked in Azure DevOps, then linked only locally, then known only by its name; inside a tier the star, then the latest
    const best0 = Math.min(...all.map(tier));
    let best: BranchRowJson | undefined;
    for (const b of all.filter((x) => tier(x) === best0)) if (!best || rank(b.status) < rank(best.status) || (rank(b.status) === rank(best.status) && (b.lastActive ?? "") > (best.lastActive ?? ""))) best = b;
    out.set(repo, { row: best!, linked: best0 === 0, others: all.length - 1 });
  }
  return out;
}

/** One branch per repository of the story (see storyBranchCandidates). */
export function storyBranchPerRepo(rows: BranchRowJson[]): Map<string, BranchRowJson> {
  return new Map([...storyBranchCandidates(rows)].map(([repo, p]) => [repo, p.row]));
}

export interface StoryRepoRow {
  repo: string;
  path: string;
  /** the story's branch there; absent: a new branch is made */
  branch?: string;
  /** the branch is linked to the story in Azure DevOps (false: it exists but is not linked yet; it is linked after opening) */
  linked?: boolean;
  /** how many other existing branches of the story this repository has */
  others?: number;
  /** ticked at the start: the ones that have a branch of the story (nothing is ticked when there is none) */
  picked: boolean;
  /** the repository is cloned on this PC (a linked repository that is not cannot be opened) */
  onThisPc: boolean;
}

/** The text behind a repository in the picker: its branch and "· N other", else the new branch. */
export const rowDescription = (r: StoryRepoRow): string => (r.branch ? `${r.branch}${r.others ? ` · ${r.others} other` : ""}` : "new branch from the target");

/** The repositories of "Open Story": the linked ones ticked, then every other repository on this PC unticked. */
export function storyRepoRows(rows: BranchRowJson[], clones: Pick<ScanRepo, "name" | "path">[]): { rows: StoryRepoRow[]; notOnThisPc: string[] } {
  const per = storyBranchCandidates(rows);
  const byName = new Map<string, Pick<ScanRepo, "name" | "path">>();
  for (const c of clones) if (!byName.has(c.name.toLowerCase())) byName.set(c.name.toLowerCase(), c);
  const out: StoryRepoRow[] = [];
  const notOnThisPc: string[] = [];
  for (const [repo, c] of per) {
    const clone = byName.get(repo.toLowerCase());
    if (!clone) notOnThisPc.push(repo);
    // a repository that has a branch of the story (linked, or found by its name) is ticked, so "number, Enter" works; one that is not linked yet is linked after opening
    else out.push({ repo: clone.name, path: clone.path, branch: c.row.branch, linked: c.linked, ...(c.others ? { others: c.others } : {}), picked: true, onThisPc: true });
  }
  // ticked ones first, then the unlinked ones that already have a branch (the sort is stable)
  out.sort((a, b) => Number(b.picked) - Number(a.picked));
  const taken = new Set(out.map((r) => r.repo.toLowerCase()));
  for (const c of [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))) if (!taken.has(c.name.toLowerCase())) out.push({ repo: c.name, path: c.path, picked: false, onThisPc: true });
  return { rows: out, notOnThisPc };
}

/** `aihub worktree open ...` for the ticked repositories: linked ones on their branch, the others on a new story branch. */
export function openStoryArgs(story: StoryRef, ticked: StoryRepoRow[], from?: string): string[] {
  const fresh = storyBranchSuggestion(story);
  const setBranch = (ticked.find((r) => r.branch && r.linked !== false) ?? ticked.find((r) => r.branch))?.branch ?? fresh;
  const pairs = ticked.map((r) => `${r.repo}=${r.branch ?? fresh}`);
  // the clone the user sees is the clone that is used: its folder goes in, its repository name (the remote's) names the entry
  return ["worktree", "open", "--repos", ticked.map((r) => r.path).join(","), "--branch", setBranch, "--branch-for", pairs.join(","), "--story", String(story.id), ...(from ? ["--from", from] : []), "--window", "none"];
}

/** feature/<id>-<slug>-<n>: the first number (2, 3, ...) that no branch of the story has yet. */
export function nextStoryBranch(story: StoryRef, existing: string[]): string {
  const base = storyBranchSuggestion(story);
  const taken = new Set(existing);
  if (!taken.has(base) && !existing.some((b) => /-\d+$/.test(b) && b.startsWith(`${base}-`))) return `${base}-2`;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** The number a person typed to open a story by number ("4711", "#4711", "AB#4711"). */
export const storyNumberOf = (text: string): number | undefined => {
  const m = /^(?:AB)?#?(\d{1,9})$/i.exec(text.trim());
  return m ? Number(m[1]) : undefined;
};

/** The rows of the story picker: seen stories at once, the fresh list when it arrives; closed ones last. */
export function storyPickRows(seen: SeenStory[], fresh: StoryRef[] | undefined): StoryRef[] {
  const by = new Map<number, StoryRef>();
  for (const s of seen) by.set(s.id, { id: s.id, title: s.title, ...(s.state ? { state: s.state } : {}) });
  for (const s of fresh ?? []) by.set(s.id, s);
  const closed = (s: StoryRef) => /^(closed|done|resolved|removed|completed)$/i.test(s.state ?? "");
  const freshIds = new Set((fresh ?? []).map((s) => s.id));
  // the fresh list keeps Azure DevOps order (yours first); stories only seen before follow
  return [...(fresh ?? []), ...[...by.values()].filter((s) => !freshIds.has(s.id))].sort((a, b) => Number(closed(a)) - Number(closed(b)));
}

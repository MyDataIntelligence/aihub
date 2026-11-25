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

const rank = (s: BranchRowJson["status"]) => (s === "current" ? 0 : s === "parked" ? 1 : 2);

/** One branch per repository of the story: Azure DevOps links first (they are the truth), the star, else the most recently active. */
export function storyBranchPerRepo(rows: BranchRowJson[]): Map<string, BranchRowJson> {
  const out = new Map<string, BranchRowJson>();
  const usable = rows.filter((b) => b.local || b.pushed);
  const linkedInAdo = usable.filter((b) => b.linked !== "local");
  // a story whose links are in Azure DevOps ignores a branch known only locally; a story with no link there uses what is local
  const from = linkedInAdo.length ? linkedInAdo : usable;
  for (const b of from) {
    const had = out.get(b.repo);
    if (!had || rank(b.status) < rank(had.status) || (rank(b.status) === rank(had.status) && (b.lastActive ?? "") > (had.lastActive ?? ""))) out.set(b.repo, b);
  }
  return out;
}

export interface StoryRepoRow {
  repo: string;
  path: string;
  /** the story's branch there; absent: a new branch is made */
  branch?: string;
  /** ticked at the start: the linked ones */
  picked: boolean;
  /** the repository is cloned on this PC (a linked repository that is not cannot be opened) */
  onThisPc: boolean;
}

/** The repositories of "Open Story": the linked ones ticked, then every other repository on this PC unticked. */
export function storyRepoRows(rows: BranchRowJson[], clones: Pick<ScanRepo, "name" | "path">[]): { rows: StoryRepoRow[]; notOnThisPc: string[] } {
  const per = storyBranchPerRepo(rows);
  const byName = new Map<string, Pick<ScanRepo, "name" | "path">>();
  for (const c of clones) if (!byName.has(c.name.toLowerCase())) byName.set(c.name.toLowerCase(), c);
  const out: StoryRepoRow[] = [];
  const notOnThisPc: string[] = [];
  for (const [repo, b] of per) {
    const clone = byName.get(repo.toLowerCase());
    if (!clone) notOnThisPc.push(repo);
    else out.push({ repo: clone.name, path: clone.path, branch: b.branch, picked: true, onThisPc: true });
  }
  const taken = new Set(out.map((r) => r.repo.toLowerCase()));
  for (const c of [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))) if (!taken.has(c.name.toLowerCase())) out.push({ repo: c.name, path: c.path, picked: false, onThisPc: true });
  return { rows: out, notOnThisPc };
}

/** `aihub worktree open ...` for the ticked repositories: linked ones on their branch, the others on a new story branch. */
export function openStoryArgs(story: StoryRef, ticked: StoryRepoRow[], from?: string): string[] {
  const fresh = storyBranchSuggestion(story);
  const setBranch = ticked.find((r) => r.branch)?.branch ?? fresh;
  const pairs = ticked.map((r) => `${r.repo}=${r.branch ?? fresh}`);
  return ["worktree", "open", "--repos", ticked.map((r) => r.repo).join(","), "--branch", setBranch, "--branch-for", pairs.join(","), "--story", String(story.id), ...(from ? ["--from", from] : []), "--window", "none"];
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

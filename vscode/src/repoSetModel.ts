/**
 * "Open Repo Set": the pure parts of the quick-pick flow. The CLI does the work (`aihub worktree open`);
 * this file builds the pick lists and the command line and turns the answer into a message. No vscode, no I/O.
 */

export interface GroupJson {
  name: string;
  source?: "user" | "team";
  repos: { name: string; path: string }[];
  present?: string[];
  missing?: string[];
}

export interface BranchJson {
  name: string;
  in: string[];
  missing: string[];
}

export interface BranchesJson {
  repos: string[];
  /** repository -> the branch it is on now ("" when detached); CLI 1.0.10+ */
  current?: Record<string, string>;
  branches: BranchJson[];
}

export interface OpenRepoJson {
  repo: string;
  ok: boolean;
  state: string;
  branch: string;
  path?: string;
  note: string;
  from?: string;
}

export interface OpenResultJson {
  /** the story of a story branch (aihub 1.1+) */
  story?: number;
  group?: string;
  branch: string;
  mode: "worktree" | "switch";
  folder: string;
  workspace?: string;
  repos: OpenRepoJson[];
  opened: boolean;
  /** aihub 1.5.1+: run inside a set for some of its repositories, they changed in this window; nothing to open */
  stays?: string;
}

export interface PrJson {
  id: number;
  title: string;
  repo: string;
  source: string;
  target: string;
}

export type HowMode = "worktree" | "switch";
export type HowWindow = "new" | "this";

export type BranchChoice = { kind: "existing"; branch: string } | { kind: "new-story" } | { kind: "pr" } | { kind: "typed" } | { kind: "plain" };

export interface PickItem<T> {
  label: string;
  description?: string;
  detail?: string;
  value?: T;
  separator?: boolean;
}

export function groupItems(groups: GroupJson[]): PickItem<{ group: GroupJson } | { tick: true }>[] {
  const items: PickItem<{ group: GroupJson } | { tick: true }>[] = groups.map((g) => ({
    label: `$(repo-forked) ${g.name}`,
    description: `${g.repos.length} repos${g.source === "team" ? " (team.yaml)" : ""}`,
    detail: g.repos.map((r) => r.name).join(", ") + (g.missing?.length ? `   [not on this PC: ${g.missing.join(", ")}]` : ""),
    value: { group: g },
  }));
  if (groups.length) items.push({ label: "", separator: true });
  items.push({ label: "$(checklist) Choose repositories...", description: "tick the repositories, optionally save them as a group", value: { tick: true } });
  return items;
}

/**
 * The branch to offer first: the one the window's own repository is on, else the one most repositories are on.
 * Nothing when no repository is on a branch (all detached, or an older CLI without `current`).
 */
export function preferredBranch(rows: BranchJson[], current: Record<string, string> | undefined, here: string | undefined): string | undefined {
  const on = Object.entries(current ?? {}).filter(([, b]) => !!b);
  if (!on.length) return undefined;
  const mine = on.find(([r]) => r === here)?.[1];
  if (mine) return mine;
  const count = new Map<string, number>();
  for (const [, b] of on) count.set(b, (count.get(b) ?? 0) + 1);
  const best = Math.max(...count.values());
  // ties: the branch that comes first in the list (most recent commit)
  return rows.map((r) => r.name).find((n) => count.get(n) === best) ?? on.find(([, b]) => count.get(b) === best)?.[1];
}

const existsIn = (b: BranchJson, total: number) => (b.missing.length === 0 ? `exists in ${total}/${total}` : `exists in ${b.in.length}/${total}`);

/** The preferred branch first (one Enter), then the three ways to make or find another, then the other existing branches. */
export function branchItems(rows: BranchJson[], total: number, preferred?: string): PickItem<BranchChoice>[] {
  const items: PickItem<BranchChoice>[] = [];
  const top = preferred ? (rows.find((b) => b.name === preferred) ?? { name: preferred, in: [], missing: [] }) : undefined;
  if (top) items.push({ label: `$(check) ${top.name}`, description: `current branch · ${existsIn(top, total)}`, detail: top.missing.length && top.in.length ? `will be created in ${top.missing.join(", ")} from its target branch` : undefined, value: { kind: "existing", branch: top.name } });
  items.push(
    { label: "$(add) New branch for a story...", description: "created in every repository from its target branch", value: { kind: "new-story" } },
    { label: "$(git-pull-request) Branch of a pull request...", description: "your pull requests", value: { kind: "pr" } },
    { label: "$(edit) Type a branch name...", value: { kind: "typed" } },
  );
  const rest = rows.filter((b) => b.name !== top?.name);
  if (rest.length) items.push({ label: "Existing branches", separator: true });
  for (const b of rest) {
    items.push({
      label: `$(git-branch) ${b.name}`,
      description: existsIn(b, total),
      detail: b.missing.length === 0 ? undefined : `will be created in ${b.missing.join(", ")} from its target branch`,
      value: { kind: "existing", branch: b.name },
    });
  }
  return items;
}

/** "Open Repo Set · stap 2/3 · pipeline": the step and what was already chosen. */
export function stepTitle(step: 1 | 2 | 3, chosen: string[], flow = "Open Repo Set"): string {
  return [flow, `stap ${step}/3`, ...chosen.filter(Boolean)].join(" · ");
}

export function prItems(prs: PrJson[]): PickItem<PrJson>[] {
  return prs.map((p) => ({ label: `!${p.id} ${p.title}`, description: p.repo, detail: `${p.source} -> ${p.target}`, value: p }));
}

export interface OpenWay {
  mode: HowMode;
  window: HowWindow;
}

/** Step 3: how (worktrees or switch the checkouts) and where (new window or this one) in one choice. */
export function openWays(): PickItem<OpenWay>[] {
  return [
    { label: "$(repo-forked) Worktrees, new window (recommended)", description: "a worktree per repository; your normal checkouts stay as they are", value: { mode: "worktree", window: "new" } },
    { label: "$(repo-forked) Worktrees, this window", description: "this window becomes the set (its folders are replaced)", value: { mode: "worktree", window: "this" } },
    { label: "$(arrow-swap) Switch the checkouts, this window", description: "git switch in each repository; one with uncommitted changes is skipped and reported", value: { mode: "switch", window: "this" } },
    { label: "$(arrow-swap) Switch the checkouts, new window", description: "git switch in each repository, opened together in a new window", value: { mode: "switch", window: "new" } },
  ];
}

export interface OpenRequest {
  group?: string;
  repos?: string[];
  branch: string;
  from?: string;
  mode: HowMode;
  /** the story the new set is for (links it, gives the star and the story folder) */
  story?: number;
}

/**
 * The `aihub worktree open` command line (the runner adds --json). `--window none`: the extension opens the window
 * itself with vscode.openFolder; a `code -r` from the CLI reaches whichever VS Code is on PATH and its last active
 * window, not necessarily this one.
 */
export function openArgs(r: OpenRequest): string[] {
  const a = ["worktree", "open", ...(r.group ? ["--group", r.group] : ["--repos", (r.repos ?? []).join(",")]), "--branch", r.branch, "--mode", r.mode, "--window", "none"];
  if (r.from) a.push("--from", r.from);
  if (r.story) a.push("--story", String(r.story));
  return a;
}

export function branchesArgs(o: { group?: string; repos?: string[] }): string[] {
  return ["worktree", "branches", ...(o.group ? ["--group", o.group] : ["--repos", (o.repos ?? []).join(",")])];
}

export interface OpenSummary {
  ok: boolean;
  failed: number;
  title: string;
  lines: string[];
}

export function summarizeOpen(r: OpenResultJson): OpenSummary {
  const failed = r.repos.filter((x) => !x.ok).length;
  const lines = r.repos.map((x) => `${x.ok ? "ok" : "FAIL"}  ${x.repo}: ${x.state} - ${x.note}`);
  const title = failed
    ? `${r.repos.length - failed} of ${r.repos.length} repositories are open on ${r.branch}; ${failed} need attention`
    : `${r.repos.length} repositories on ${r.branch} (${r.mode})`;
  return { ok: failed === 0, failed, title, lines };
}

/**
 * What the extension opens after the CLI did the git work: the set's workspace file, in this window or a new one;
 * nothing when the repositories switched inside the set this window already shows (`stays`).
 */
export function openTarget(r: OpenResultJson, window: HowWindow): { file: string; options: { forceReuseWindow: true } | { forceNewWindow: true } } | { error: string } | { stays: string } {
  if (r.stays) return { stays: r.stays };
  if (!r.workspace || !r.repos.some((x) => x.ok)) return { error: `No repository could be opened on ${r.branch}, so the window was not changed.` };
  return { file: r.workspace, options: window === "this" ? { forceReuseWindow: true } : { forceNewWindow: true } };
}

export interface SetModel {
  story: number;
  branch: string;
  group?: string;
  repos: string[];
  total?: number;
}

/** A set's `.aihub-set.json` (written by `aihub worktree open`) as the status bar's set; the repositories whose folder is gone are left out. */
export function setFromMeta(meta: unknown, exists: (p: string) => boolean): SetModel | null {
  const m = meta as { story?: number; group?: string; branch?: string; repos?: { name: string; path: string }[] } | null;
  if (!m?.branch || !Array.isArray(m.repos)) return null;
  return { story: m.story ?? 0, group: m.group, branch: m.branch, total: m.repos.length, repos: m.repos.filter((r) => exists(r.path)).map((r) => r.name) };
}

/** The chip of a window that is a set: "Set: pipeline · 3/3 op feature/x". */
export function setChip(s: SetModel | null | undefined): { label: string; title: string } | undefined {
  if (!s) return undefined;
  const total = s.total ?? s.repos.length;
  const name = s.group ?? (s.story ? `story ${s.story}` : "set");
  return { label: `Set: ${name} · ${s.repos.length}/${total} op ${s.branch}`, title: `Repositories of this set: ${s.repos.join(", ")}\nBranch ${s.branch}\nClick for the actions of the set` };
}

/** The status bar item next to the built-in branch item: the set's branch and repo count, else the entry itself. */
export function reposetStatus(s: SetModel | null | undefined): { text: string; tooltip: string } {
  const NL = String.fromCharCode(10);
  if (!s) return { text: "$(repo-forked) Worktree Sets", tooltip: ["Open several repositories on the same branch in one window.", "", "Click for New Worktree Set, Open Worktree Set and the recent stories and sets."].join(NL) };
  const total = s.total ?? s.repos.length;
  const rows = s.repos.map((r) => `- ${r}: ${s.branch}`);
  return { text: `$(repo-forked) ${s.branch} · ${total} repos`, tooltip: [`**${s.group ?? "Set"}** on ${s.branch} (${s.repos.length}/${total} repositories)`, "", ...rows, "", "Click to open repositories on another branch."].join(NL) };
}

/** The branch name offered for a new set of a story: feature/<id>-<slug of the title>. */
export function storyBranchSuggestion(story: { id: number; title?: string } | undefined): string {
  if (!story) return "feature/";
  const slug = (story.title ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `feature/${story.id}-${slug}`;
}

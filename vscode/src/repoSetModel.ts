/**
 * "Repos op branch openen": the pure parts of the quick-pick flow. The CLI does the work (`aihub worktree open`);
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
  group?: string;
  branch: string;
  mode: "worktree" | "switch";
  folder: string;
  workspace?: string;
  repos: OpenRepoJson[];
  opened: boolean;
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

export type BranchChoice = { kind: "existing"; branch: string } | { kind: "new-story" } | { kind: "pr" } | { kind: "typed" };

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

/** Existing branches first-class: "exists in 2/3" and where it will be created; then the three ways to make or find another. */
export function branchItems(rows: BranchJson[], total: number): PickItem<BranchChoice>[] {
  const items: PickItem<BranchChoice>[] = [
    { label: "$(add) New branch for a story...", description: "created in every repository from its target branch", value: { kind: "new-story" } },
    { label: "$(git-pull-request) Branch of a pull request...", description: "your pull requests", value: { kind: "pr" } },
    { label: "$(edit) Type a branch name...", value: { kind: "typed" } },
  ];
  if (rows.length) items.push({ label: "Existing branches", separator: true });
  for (const b of rows) {
    const all = b.missing.length === 0;
    items.push({
      label: `$(git-branch) ${b.name}`,
      description: all ? `exists in ${total}/${total}` : `exists in ${b.in.length}/${total}`,
      detail: all ? undefined : `will be created in ${b.missing.join(", ")} from its target branch`,
      value: { kind: "existing", branch: b.name },
    });
  }
  return items;
}

export function prItems(prs: PrJson[]): PickItem<PrJson>[] {
  return prs.map((p) => ({ label: `!${p.id} ${p.title}`, description: p.repo, detail: `${p.source} -> ${p.target}`, value: p }));
}

export function howItems(): PickItem<HowMode>[] {
  return [
    { label: "$(repo-forked) Worktrees (recommended)", description: "a worktree per repository; your normal checkouts stay as they are", value: "worktree" },
    { label: "$(arrow-swap) Switch the checkouts", description: "git switch in each repository; one with uncommitted changes is skipped and reported", value: "switch" },
  ];
}

export function windowItems(): PickItem<HowWindow>[] {
  return [
    { label: "$(multiple-windows) New window", value: "new" },
    { label: "$(window) This window", description: "reuse the window you are in", value: "this" },
  ];
}

export interface OpenRequest {
  group?: string;
  repos?: string[];
  branch: string;
  from?: string;
  mode: HowMode;
  window: HowWindow;
}

/** The `aihub worktree open` command line (the runner adds --json). */
export function openArgs(r: OpenRequest): string[] {
  const a = ["worktree", "open", ...(r.group ? ["--group", r.group] : ["--repos", (r.repos ?? []).join(",")]), "--branch", r.branch, "--mode", r.mode, "--window", r.window];
  if (r.from) a.push("--from", r.from);
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
    : `${r.repos.length} repositories on ${r.branch} (${r.mode})${r.opened ? "" : ", but VS Code could not be started: open " + (r.workspace ?? "the workspace file") + " yourself"}`;
  return { ok: failed === 0, failed, title, lines };
}

export interface SetModel {
  story: number;
  branch: string;
  group?: string;
  repos: string[];
  total?: number;
}

/** The chip of a window that is a set: "Set: pipeline · 3/3 op feature/x". */
export function setChip(s: SetModel | null | undefined): { label: string; title: string } | undefined {
  if (!s) return undefined;
  const total = s.total ?? s.repos.length;
  const name = s.group ?? (s.story ? `story ${s.story}` : "set");
  return { label: `Set: ${name} · ${s.repos.length}/${total} op ${s.branch}`, title: `Repositories of this set: ${s.repos.join(", ")}\nBranch ${s.branch}\nClick for the actions of the set` };
}

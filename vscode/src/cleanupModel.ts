/** What `aihub worktree cleanup --json` gives per worktree, and the decisions of the clean-up UI (pure, tested). */

export interface CleanupRow {
  repo: string;
  path: string;
  branch: string;
  sizeBytes?: number;
  lastActive?: number;
  uncommitted: number;
  unpushed: number;
  merged?: boolean;
  /** false: PR and story state unknown (not signed in) */
  remote?: boolean;
  pr?: { id: number; status: string };
  story?: { id: number; state?: string; title?: string; done?: boolean };
  reasons: string[];
  warning?: string;
  preselected: boolean;
}

export const size = (b: number | undefined) => (b === undefined ? "" : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
const ago = (t: number | undefined, now: number) => {
  if (t === undefined) return "";
  const d = Math.round((now - t) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`;
};

/** One pick-list item per worktree: finished and clean ones ticked, local work never ticked and marked. */
export function pickItems(rows: CleanupRow[], now: number) {
  return rows.map((r) => ({
    label: `${r.warning ? "$(warning) " : ""}${r.branch}`,
    description: [r.repo, size(r.sizeBytes), ago(r.lastActive, now)].filter(Boolean).join(" · "),
    detail: [
      r.pr ? `PR !${r.pr.id} ${r.pr.status}` : r.remote === false ? "PR unknown (not signed in)" : "no PR",
      r.story ? `story ${r.story.id}${r.story.state ? ` ${r.story.state}` : ""}${r.story.title ? `: ${r.story.title}` : ""}` : "",
      r.merged ? "merged" : "",
      r.warning ?? "clean",
    ]
      .filter(Boolean)
      .join(" · "),
    picked: r.preselected,
    path: r.path,
  }));
}

export interface ReminderState {
  lastAsked?: number;
  snoozeUntil?: number;
  never?: boolean;
}

const DAY = 86_400_000;

/** Ask at most once a day: once a week when something can go, sooner when three or more can go; never after "Don't ask again". */
export function shouldAsk(s: ReminderState, removable: number, now: number): boolean {
  if (s.never || removable < 1) return false;
  if (s.snoozeUntil && now < s.snoozeUntil) return false;
  const since = s.lastAsked === undefined ? Infinity : now - s.lastAsked;
  return removable >= 3 ? since >= DAY : since >= 7 * DAY;
}

/** Whether a background read is worth it now (the read itself costs a few git calls and one request per branch). */
export const mayCheck = (s: ReminderState, now: number) => !s.never && !(s.snoozeUntil && now < s.snoozeUntil) && (s.lastAsked === undefined || now - s.lastAsked >= DAY);

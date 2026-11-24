import { describe, expect, it } from "vitest";
import { mayCheck, pickItems, shouldAsk, type CleanupRow } from "../src/cleanupModel";

const DAY = 86_400_000;
const row = (over: Partial<CleanupRow>): CleanupRow => ({ repo: "test-project", path: "/wt/x", branch: "feature/7-x", uncommitted: 0, unpushed: 0, reasons: [], preselected: false, ...over });

describe("clean up worktrees", () => {
  it("ticks finished clean worktrees and marks local work", () => {
    const now = 100 * DAY;
    const [done, wip] = pickItems(
      [
        row({ path: "/wt/a", branch: "feature/7-done", sizeBytes: 1.5 * 1024 ** 3, lastActive: now - 12 * DAY, pr: { id: 41, status: "completed" }, story: { id: 7, state: "Closed", title: "Export", done: true }, reasons: ["PR !41 completed"], preselected: true }),
        row({ path: "/wt/b", branch: "feature/8-wip", sizeBytes: 300 * 1024 ** 2, uncommitted: 3, warning: "local work: 3 uncommitted", pr: { id: 42, status: "completed" }, reasons: ["PR !42 completed"] }),
      ],
      now,
    );
    expect(done).toMatchObject({ label: "feature/7-done", picked: true, path: "/wt/a", description: "test-project · 1.5 GB · 12 days ago", detail: "PR !41 completed · story 7 Closed: Export · clean" });
    expect(wip).toMatchObject({ label: "$(warning) feature/8-wip", picked: false, detail: "PR !42 completed · local work: 3 uncommitted" });
  });

  it("asks at most once a day: weekly, sooner with three or more, never after Don't ask again or while snoozed", () => {
    const now = 100 * DAY;
    expect(shouldAsk({}, 0, now)).toBe(false);
    expect(shouldAsk({}, 1, now)).toBe(true);
    expect(shouldAsk({ lastAsked: now - 3 * DAY }, 1, now)).toBe(false);
    expect(shouldAsk({ lastAsked: now - 8 * DAY }, 1, now)).toBe(true);
    expect(shouldAsk({ lastAsked: now - 2 * DAY }, 3, now)).toBe(true);
    expect(shouldAsk({ lastAsked: now - 3_600_000 }, 5, now)).toBe(false);
    expect(shouldAsk({ never: true }, 9, now)).toBe(false);
    expect(shouldAsk({ snoozeUntil: now + DAY }, 9, now)).toBe(false);
    expect(mayCheck({ lastAsked: now - 3_600_000 }, now)).toBe(false); // no background read the same day
    expect(mayCheck({}, now)).toBe(true);
  });
});

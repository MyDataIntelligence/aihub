import { describe, expect, it } from "vitest";
import { buildModel, countVotes, itemsForHead, statusItems, toFabric, unwrap, votesFromPolicies } from "../src/model";
import { fx } from "./helpers";

describe("model", () => {
  it("counts Azure DevOps votes", () => {
    expect(countVotes([{ name: "a", vote: 10 }, { name: "b", vote: 5 }, { name: "c", vote: -5 }, { name: "d", vote: 0 }]).summary).toBe("2 approved, 1 waiting");
    expect(countVotes(undefined).summary).toBe("no votes");
    expect(countVotes([{ name: "a", vote: -10 }]).rejected).toBe(1);
  });

  it("falls back to the reviewers policy for the votes", () => {
    expect(votesFromPolicies(fx("pr-checks").policies)?.summary).toBe("needs approval");
    expect(votesFromPolicies([{ name: "r", kind: "reviewers", status: "approved" }])?.summary).toBe("approved");
    expect(votesFromPolicies([])).toBeUndefined();
  });

  it("unwraps the identity envelope", () => {
    expect(unwrap<{ a: number }>({ identity: {}, result: { a: 1 } }).a).toBe(1);
    expect(unwrap<{ a: number }>({ a: 2 }).a).toBe(2);
  });

  it("builds the fabric section from failures and logs", () => {
    const f = toFabric(fx("fabric-failures"), fx("fabric-logs"))!;
    expect(f.workspace).toBe("FEAT 1234 add export");
    expect(f.failed).toHaveLength(1);
    expect(f.active).toBe(1);
    expect(f.runs.map((r) => r.status)).toEqual(["Failed", "InProgress", "Completed"]);
    expect(f.cause).toContain("orders_raw");
    expect(toFabric(undefined, undefined)).toBeNull();
  });

  it("shows story, PR with votes, pipeline, threads, fabric and events", () => {
    const m = buildModel({ status: fx("status"), checks: fx("pr-checks"), fabric: toFabric(fx("fabric-failures"), fx("fabric-logs")), events: [{ id: "1", message: "new comment on PR !45", at: 1 }] });
    const items = statusItems(m);
    expect(items.map((i) => i.id)).toEqual(["story", "pr", "pipeline", "threads", "fabric", "events"]);
    expect(items[0].text).toContain("#1234 Add the order export");
    expect(items[1].text).toContain("!45");
    expect(items[1].text).toContain("1✓ 1⏳");
    expect(items[2]).toMatchObject({ tone: "bad", text: expect.stringContaining("red") });
    expect(items[3].text).toContain("2");
    expect(items[4].text).toContain("1 failed, 1 running");
  });

  it("falls back to the reviewers policy when the CLI lists no reviewers", () => {
    const { reviewers: _r, ...pr } = fx("status").pr;
    const m = buildModel({ status: { ...fx("status"), pr }, checks: fx("pr-checks") });
    expect(m.pr?.votes.summary).toBe("needs approval");
  });

  it("keeps a quiet repository down to one item", () => {
    const items = statusItems(buildModel({ status: fx("status-quiet") }));
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain("main");
  });

  it("survives a status with missing fields", () => {
    const m = buildModel({ status: {} });
    expect(statusItems(m)[0].text).toContain("no branch");
  });
});

describe("not signed in", () => {
  it("shows one status bar item that says how to sign in", () => {
    const items = statusItems(buildModel({ status: { branch: "feature/7-x", signedIn: false, story: { id: 7, title: "(unknown)", state: "?" } } }));
    expect(items.find((i) => i.id === "signin")).toMatchObject({ text: "$(account) not signed in", tone: "warn" });
    expect(statusItems(buildModel({ status: { branch: "x" } })).some((i) => i.id === "signin")).toBe(false);
  });
});

describe("itemsForHead: the items of the last read while another branch is checked out", () => {
  const items = [
    { id: "story", text: "$(git-branch) feature/bench-1", tooltip: "t", tone: "muted", command: "aihub.showBar" },
    { id: "pr", text: "PR 12", tooltip: "t", tone: "ok", command: "c" },
    { id: "fabric", text: "$(database) no failures", tooltip: "Fabric workspace team dev bench-1", tone: "ok", command: "c" },
    { id: "events", text: "1 event", tooltip: "t", tone: "muted", command: "c" },
  ] as const;
  it("drops the pull request and the Fabric workspace of the old branch after a checkout (live 28-11: bench-1 on bench-1-nows)", () => {
    const shown = itemsForHead([...items], "feature/bench-1", "feature/bench-1-nows");
    expect(shown.map((i) => i.id)).toEqual(["story", "events"]);
    expect(shown[0].text).toBe("$(git-branch) feature/bench-1-nows");
    expect(shown.some((i) => /bench-1"|team dev bench-1$/.test(i.tooltip))).toBe(false);
  });
  it("changes nothing while the branch is the one that was read, or HEAD is not known", () => {
    expect(itemsForHead([...items], "feature/bench-1", "feature/bench-1")).toEqual(items);
    expect(itemsForHead([...items], "feature/bench-1", undefined)).toEqual(items);
  });
});

import { describe, expect, it } from "vitest";
import { buildModel, countVotes, statusItems, toFabric, unwrap, votesFromPolicies } from "../src/model";
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
    expect(items[1].text).toContain("!45 active");
    expect(items[1].text).toContain("needs approval");
    expect(items[2]).toMatchObject({ tone: "bad", text: expect.stringContaining("red") });
    expect(items[3].text).toContain("2");
    expect(items[4].text).toContain("1 failed, 1 running");
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

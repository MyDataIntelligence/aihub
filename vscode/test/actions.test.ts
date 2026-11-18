import { describe, expect, it } from "vitest";
import { actionById, actionsFor, ACTIONS, pickTarget, primaryActionId } from "../src/actions";
import { buildModel, toFabric } from "../src/model";
import { fx } from "./helpers";

const base = () => buildModel({ status: fx("status") });

describe("actions", () => {
  it("never runs anything: every action is text for the chat", () => {
    for (const a of ACTIONS) expect(typeof a.text).toBe("string");
    expect(actionById("pr")?.text).toBe("/pr");
  });

  it("picks the next action from the state", () => {
    expect(primaryActionId(buildModel({ status: fx("status-quiet") }))).toBe("start");
    expect(primaryActionId(base())).toBe("pipeline-fix");
    expect(primaryActionId(buildModel({ status: { ...fx("status"), checks: "green" } }))).toBe("review");
    expect(primaryActionId(buildModel({ status: { ...fx("status"), checks: "green", openThreads: 0 } }))).toBe("watch");
    expect(primaryActionId(buildModel({ status: { ...fx("status"), pr: null, pipeline: [] } }))).toBe("pr");
    expect(primaryActionId(buildModel({ status: { ...fx("status"), dirty: true, openThreads: 0, checks: "green" } }))).toBe("commit");
  });

  it("puts a Fabric failure first", () => {
    const m = buildModel({ status: fx("status"), fabric: toFabric(fx("fabric-failures"), fx("fabric-logs")) });
    expect(actionsFor(m)[0].id).toBe("fabric-failures");
    expect(actionsFor(base())[0].id).toBe("pipeline-fix");
  });

  it("offers no PR actions without a PR", () => {
    const ids = actionsFor(buildModel({ status: fx("status-quiet") })).map((a) => a.id);
    expect(ids).not.toContain("review");
    expect(ids).not.toContain("pr-update");
  });

  it("detects the chat: an opencode terminal wins in auto", () => {
    expect(pickTarget("auto", true)).toBe("opencode");
    expect(pickTarget("auto", false)).toBe("copilot");
    expect(pickTarget("copilot", true)).toBe("copilot");
    expect(pickTarget("opencode", false)).toBe("opencode");
  });
});

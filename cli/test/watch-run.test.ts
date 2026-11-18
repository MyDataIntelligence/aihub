import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEvent, eventFromUrl } from "../src/lib/open.js";
import { listWatches, readSpecs, startWatch, type WatchSpec } from "../src/lib/watch.js";
import { parseFabricJob, runTargetWatch } from "../src/lib/watchRun.js";
import { ctxFor, fakeFetch, makeRepo, write, type Route } from "./helpers.js";

const build = (status: string, result: string | undefined, branch = "feature/12-export") => ({
  id: 77,
  buildNumber: "20260101.7",
  status,
  result,
  sourceBranch: `refs/heads/${branch}`,
  definition: { name: "ci" },
  _links: { web: { href: "https://dev.azure.com/ferron-org/test-project/_build/results?buildId=77" } },
});

function setup(routes: Route[], team = "") {
  const { dir } = makeRepo();
  if (team) write(dir, ".agents/skills/_shared/references/team.yaml", team);
  const c = ctxFor(dir, fakeFetch(routes).fn);
  const toasts: { message: string; label?: string; url?: string }[] = [];
  const notifier = (_t: string, message: string, a?: { label?: string; url?: string }) => (toasts.push({ message, label: a?.label, url: a?.url }), true);
  let t = 0;
  c.ctx.now = () => (t += 1000);
  return { dir, ...c, toasts, notifier };
}

const spec = (target: WatchSpec["target"], over: Partial<WatchSpec> = {}): WatchSpec => ({ id: "w1", until: "done", target, notify: true, timeoutMs: 3_600_000, intervalMs: 1000, started: 0, ...over });

describe("watch --run / --robot / --fabric-job", () => {
  it("a run that succeeds ends with an Open toast and a stored event", async () => {
    let n = 0;
    const s = setup([{ match: /build\/builds\/77\?/, respond: () => ({ body: n++ < 2 ? build("inProgress", undefined) : build("completed", "succeeded") }) }]);
    const r = await runTargetWatch(s.ctx, spec({ kind: "run", build: 77 }), { notifier: s.notifier });
    expect(r.reason).toBe("done");
    expect(n).toBe(3);
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0].label).toBe("Open");
    expect(s.toasts[0].message).toBe("run 77 (ci) succeeded on feature/12-export");
    expect(readFileSync(join(s.dir, ".git", "aihub", "events.log"), "utf8")).toContain("run 77");
  });

  it("a failed run on a feature branch gets the Fix button: /fix <run url> for the aihub agent", async () => {
    const s = setup([{ match: /build\/builds\/77\?/, respond: () => ({ body: build("completed", "failed") }) }]);
    const r = await runTargetWatch(s.ctx, spec({ kind: "run", build: 77 }), { notifier: s.notifier });
    expect(r.reason).toBe("failed");
    expect(s.toasts[0].label).toBe("Fix");
    const ev = readEvent(s.ctx.env, eventFromUrl(s.toasts[0].url!));
    expect(ev.prompt).toBe("/fix https://dev.azure.com/ferron-org/test-project/_build/results?buildId=77");
    expect(ev.agent).toBe("aihub");
  });

  it("no Fix for a protected branch, a PR merge build or a cancelled run", async () => {
    for (const [branch, result, sourceBranch] of [["staging", "failed", undefined], ["x", "failed", "refs/pull/5/merge"], ["feature/1-a", "canceled", undefined]] as const) {
      const s = setup([{ match: /build\/builds\/77\?/, respond: () => ({ body: { ...build("completed", result, branch), ...(sourceBranch ? { sourceBranch } : {}) } }) }]);
      await runTargetWatch(s.ctx, spec({ kind: "run", build: 77 }), { notifier: s.notifier });
      expect(s.toasts[0].label, `${branch} ${result}`).toBe("Open");
    }
  });

  it("a Robot build adds the test counts to the toast", async () => {
    const s = setup([
      { match: /test\/runs\?/, respond: () => ({ body: { value: [{ name: "robot", totalTests: 10, passedTests: 8 }] } }) },
      { match: /build\/builds\/77\/timeline/, respond: () => ({ body: { records: [{ name: "Run robot", type: "Task", result: "failed", issues: [{ type: "error", message: "2 tests failed" }] }] } }) },
      { match: /build\/builds\/77\?/, respond: () => ({ body: build("completed", "failed") }) },
    ]);
    await runTargetWatch(s.ctx, spec({ kind: "robot", build: 77 }), { notifier: s.notifier });
    expect(s.toasts[0].message).toContain("tests robot: 8/10 passed, 2 failed");
    expect(s.toasts[0].message).toContain("failed: Run robot: 2 tests failed");
    expect(s.toasts[0].label).toBe("Fix");
  });

  it("a Fabric job: waits for a final status; Failed gives /fix fabric <ws/item/job>", async () => {
    const seq = [{ status: "InProgress" }, { status: "Failed", failure: "Notebook raised ValueError" }];
    let i = 0;
    const s = setup([]);
    const r = await runTargetWatch(s.ctx, spec({ kind: "fabric", workspace: "ws-dev", item: "load_orders", job: "j-1" }), { notifier: s.notifier, fabricJob: async () => seq[Math.min(i++, 1)] });
    expect(r.reason).toBe("failed");
    expect(s.toasts[0].message).toBe("Fabric job ws-dev/load_orders/j-1 failed: Notebook raised ValueError");
    expect(readEvent(s.ctx.env, eventFromUrl(s.toasts[0].url!)).prompt).toBe("/fix fabric ws-dev/load_orders/j-1");
    const ok = setup([]);
    await runTargetWatch(ok.ctx, spec({ kind: "fabric", workspace: "w", item: "i", job: "j" }), { notifier: ok.notifier, fabricJob: async () => ({ status: "Completed" }) });
    expect(ok.toasts[0]).toMatchObject({ label: "Open", message: "Fabric job w/i/j completed" });
  });

  it("stops with a message when the run is still going after the timeout", async () => {
    const s = setup([{ match: /build\/builds\/77\?/, respond: () => ({ body: build("inProgress", undefined) }) }]);
    const r = await runTargetWatch(s.ctx, spec({ kind: "run", build: 77 }, { timeoutMs: 5000 }), { notifier: s.notifier });
    expect(r.reason).toBe("timeout");
    expect(s.toasts[0].message).toContain("still running");
  });
});

describe("starting the background follow", () => {
  it("writes a spec with the target, starts the detached process once, lists it and refuses a duplicate", () => {
    const s = setup([]);
    const started: string[] = [];
    const spawner = (_root: string, id: string) => (started.push(id), 4242);
    const out = startWatch(s.ctx, { run: "https://dev.azure.com/o/p/_build/results?buildId=77&view=logs", notify: true }, spawner, () => true);
    expect(out).toContain("following run 77 in the background");
    expect(started).toHaveLength(1);
    const specs = readSpecs(s.dir);
    expect(specs[0]).toMatchObject({ target: { kind: "run", build: 77 }, notify: true, pid: 4242 });
    expect(startWatch(s.ctx, { run: "77" }, spawner, () => true)).toContain("already following run 77");
    expect(started).toHaveLength(1);
    expect(listWatches(s.ctx, {}, () => true)).toContain("run 77");
    expect(startWatch(s.ctx, { robot: "78" }, spawner, () => true)).toContain("following Robot build 78");
    expect(startWatch(s.ctx, { fabricJob: "ws/item/job1" }, spawner, () => true)).toContain("following Fabric job ws/item/job1");
  });

  it("refuses combinations and malformed targets", () => {
    const s = setup([]);
    const nop = () => 1;
    expect(() => startWatch(s.ctx, { run: "1", robot: "2" }, nop)).toThrow(/one of/);
    expect(() => startWatch(s.ctx, { run: "1", pr: "5" }, nop)).toThrow(/do not combine/);
    expect(() => startWatch(s.ctx, { run: "abc" }, nop)).toThrow(/not a run id/);
    expect(() => parseFabricJob("ws/item")).toThrow(/needs <workspace>/);
    expect(parseFabricJob("a/b/c")).toEqual({ kind: "fabric", workspace: "a", item: "b", job: "c" });
  });
});

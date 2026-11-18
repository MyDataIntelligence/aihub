import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BarLoader } from "../src/data";
import { stubRunner } from "./helpers";

const scratch = () => mkdtempSync(join(tmpdir(), "aihub-ext-"));
const calls = (file: string) => readFileSync(file, "utf8").trim().split("\n");
const opts = (dir: string, fabric = true, ttl = 60_000) => ({ cwd: dir, fabric, fabricTtlMs: ttl });

describe("BarLoader", () => {
  it("reads the whole bar through aihub --json calls only", async () => {
    const dir = scratch();
    const log = join(dir, "calls.txt");
    writeFileSync(log, "");
    const m = await new BarLoader(stubRunner({ FAKE_AIHUB_CALLS: log }), opts(dir)).load();
    expect(m.story?.id).toBe(1234);
    expect(m.pr).toMatchObject({ id: 45, votes: { summary: "1 approved, 1 waiting" } });
    expect(m.pr?.reviewers.map((r) => r.name)).toEqual(["Bob", "Ann"]);
    expect(m.events.map((e) => e.message)).toEqual(["New comment on PR !45", "Build (ci) failed on your PR !45"]);
    expect(m.openThreads).toBe(2);
    expect(m.fabric?.failed).toHaveLength(1);
    expect(m.watching).toBe(true);
    const c = calls(log);
    expect(c).toHaveLength(6);
    expect(c).toEqual(expect.arrayContaining(["status", "pr checks --pr 45", "fabric failures", "fabric logs --workspace FEAT 1234 add export --since 24h --top 8", "watch list", "watch events --limit 5"]));
    rmSync(dir, { recursive: true, force: true });
  });

  it("caches the slow Fabric reads between refreshes", async () => {
    const dir = scratch();
    const log = join(dir, "calls.txt");
    writeFileSync(log, "");
    const loader = new BarLoader(stubRunner({ FAKE_AIHUB_CALLS: log }), opts(dir));
    await loader.load();
    await loader.load();
    expect(calls(log).filter((c) => c.startsWith("fabric"))).toHaveLength(2);
    expect(calls(log).filter((c) => c === "status")).toHaveLength(2);
    loader.invalidate();
    await loader.load();
    expect(calls(log).filter((c) => c.startsWith("fabric"))).toHaveLength(4);
  });

  it("hides the Fabric section when the branch has no workspace, and keeps the rest", async () => {
    const dir = scratch();
    const m = await new BarLoader(stubRunner({ FAKE_AIHUB_FAIL: "fabric" }), opts(dir)).load();
    expect(m.fabric).toBeNull();
    expect(m.pr?.id).toBe(45);
  });

  it("does not call Fabric when it is switched off", async () => {
    const dir = scratch();
    const log = join(dir, "calls.txt");
    writeFileSync(log, "");
    await new BarLoader(stubRunner({ FAKE_AIHUB_CALLS: log }), opts(dir, false)).load();
    expect(calls(log).some((c) => c.startsWith("fabric"))).toBe(false);
  });

  it("still shows the bar when pr checks fails", async () => {
    const dir = scratch();
    const m = await new BarLoader(stubRunner({ FAKE_AIHUB_FAIL: "pr" }), opts(dir, false, 1)).load();
    expect(m.pr?.id).toBe(45);
    expect(m.pr?.blockers).toEqual([]);
  });
});

describe("events", () => {
  it("come from aihub watch events, and are empty for a CLI without that command", async () => {
    const dir = scratch();
    expect((await new BarLoader(stubRunner(), opts(dir, false)).load()).events).toHaveLength(2);
    expect((await new BarLoader(stubRunner({ FAKE_AIHUB_FAIL: "watch" }), opts(dir, false)).load()).events).toEqual([]);
  });
});

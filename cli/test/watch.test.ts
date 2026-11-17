import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { diffSnapshots, listWatches, notifyCommand, readSpecs, runWatch, startWatch, stopWatches, type Snapshot, type WatchSpec } from "../src/lib/watch.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const build = (id: number, status: string, result?: string) => ({
  id,
  buildNumber: `1.${id}`,
  status,
  result,
  queueTime: "2026-01-01T10:00:00Z",
  definition: { id: 3, name: "ci" },
});

/** A PR whose state is driven by the test: each poll of the builds endpoint advances `tick`. */
function world(script: { builds: object[][]; comments?: number[]; votes?: number[]; status?: string[] }) {
  let tick = 0;
  const at = <T>(a: T[] | undefined, d: T): T => (a ? a[Math.min(tick, a.length - 1)] : d);
  const routes: Route[] = [
    { match: /pullrequests\/5\/threads/, respond: () => ({ body: { value: Array.from({ length: at(script.comments, 0) }, (_, i) => ({ id: i + 1, status: "active", comments: [{ id: 1, author: { displayName: "A" }, content: "c" }] })) } }) },
    {
      match: /pullrequests\/5\?/,
      respond: () => ({
        body: { pullRequestId: 5, status: at(script.status, "active"), sourceRefName: "refs/heads/f", targetRefName: "refs/heads/main", reviewers: [{ displayName: "Anna", vote: at(script.votes, 0) }] },
      }),
    },
    { match: /build\/builds\?/, respond: () => ({ body: { value: at(script.builds, [] as object[]) } }) },
  ];
  // tick advances when a poll finishes: the sleep hook below
  return { routes, next: () => tick++ };
}

function spec(over: Partial<WatchSpec> = {}): WatchSpec {
  return { id: "t1", pr: 5, until: "done", notify: true, timeoutMs: 600_000, intervalMs: 1000, started: 0, ...over };
}

function run(script: Parameters<typeof world>[0], s: WatchSpec) {
  const { dir } = makeRepo();
  const w = world(script);
  const { ctx, lines } = ctxFor(dir, fakeFetch(w.routes).fn);
  let t = 0;
  ctx.now = () => t;
  ctx.sleep = async (ms) => {
    t += ms;
    w.next();
  };
  const notes: string[] = [];
  return { dir, ctx, lines, notes, go: () => runWatch(ctx, s, { notifier: (title, m) => (notes.push(`${title}|${m}`), true) }) };
}

describe("watch poller (fake clock)", () => {
  it("ends with a notification and an events.log line when the build finishes", async () => {
    const r = run({ builds: [[build(1, "inProgress")], [build(1, "inProgress")], [build(1, "completed", "succeeded")]] }, spec());
    const res = await r.go();
    expect(res.reason).toContain("ci #1.1 finished: succeeded");
    expect(r.notes).toEqual(["aihub|PR !5: ci #1.1 finished: succeeded"]);
    const log = readFileSync(join(r.dir, ".git", "aihub", "events.log"), "utf8");
    expect(log).toMatch(/\tpr\/5\tPR !5: ci #1\.1 finished: succeeded\n$/);
  });

  it("until comment: ignores the build, stops at the first new comment", async () => {
    const r = run({ builds: [[build(1, "inProgress")], [build(1, "completed", "failed")], [build(1, "completed", "failed")]], comments: [1, 1, 3] }, spec({ until: "comment" }));
    const res = await r.go();
    expect(res.events.map((e) => e.kind)).toEqual(["build", "comment"]);
    expect(res.reason).toBe("PR !5: 2 new comment(s)");
  });

  it("until vote: reports who voted what", async () => {
    const r = run({ builds: [[build(1, "inProgress")]], votes: [0, 0, 10] }, spec({ until: "vote", notify: false }));
    const res = await r.go();
    expect(res.reason).toBe("PR !5: Anna voted approved");
    expect(r.notes).toEqual([]);
  });

  it("stops when the PR is closed and when the timeout passes", async () => {
    const closed = run({ builds: [[build(1, "inProgress")]], status: ["active", "completed"] }, spec());
    expect((await closed.go()).reason).toBe("PR !5 is now completed");
    const slow = run({ builds: [[build(1, "inProgress")]] }, spec({ timeoutMs: 5000 }));
    const res = await slow.go();
    expect(res.reason).toBe("timeout");
    expect(slow.notes[0]).toContain("timed out");
  });

  it("an already finished pipeline counts at once", async () => {
    const r = run({ builds: [[build(1, "completed", "succeeded")]] }, spec());
    expect((await r.go()).reason).toContain("already finished");
  });

  it("prints when no OS notification can be shown", async () => {
    const { dir } = makeRepo();
    const w = world({ builds: [[build(1, "completed", "succeeded")]] });
    const { ctx, lines } = ctxFor(dir, fakeFetch(w.routes).fn);
    await runWatch(ctx, spec(), { notifier: () => false });
    expect(lines.join("\n")).toContain("already finished");
  });
});

describe("diffSnapshots", () => {
  const base: Snapshot = { prId: 5, prStatus: "active", builds: [], comments: 0, votes: {} };
  it("reports votes and comments only after the first look", () => {
    expect(diffSnapshots(undefined, { ...base, comments: 4, votes: { A: -10 } })).toEqual([]);
    const ev = diffSnapshots(base, { ...base, comments: 1, votes: { A: -5 } });
    expect(ev.map((e) => e.message)).toEqual(["PR !5: 1 new comment(s)", "PR !5: A voted waiting for the author"]);
  });
});

describe("notification commands", () => {
  it("uses the platform's own tool and quotes the text", () => {
    expect(notifyCommand("darwin", 'a "t"', "m")!.args[1]).toBe('display notification "m" with title "a \\"t\\""');
    expect(notifyCommand("linux", "t", "m")).toEqual({ cmd: "notify-send", args: ["t", "m"] });
    const w = notifyCommand("win32", "t", "it's done")!;
    expect(w.cmd).toBe("powershell.exe");
    expect(w.args.at(-1)).toContain("'it''s done'");
    expect(notifyCommand("aix", "t", "m")).toBeUndefined();
  });
});

describe("aihub watch start, list, stop", () => {
  it("starts one detached watcher per target, lists and stops it", async () => {
    const { dir } = makeRepo();
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    const spawned: string[] = [];
    const spawner = (_root: string, id: string) => (spawned.push(id), 4242);
    const alive = () => true;
    const first = startWatch(ctx, { pr: "5", notify: true, timeout: "30m" }, spawner, alive);
    expect(first).toContain("watching PR !5 in the background");
    expect(startWatch(ctx, { pr: "5" }, spawner, alive)).toContain("already watching PR !5");
    expect(spawned).toHaveLength(1);
    const [s] = readSpecs(dir);
    expect(s).toMatchObject({ pr: 5, until: "done", notify: true, timeoutMs: 1_800_000, pid: 4242 });
    expect(listWatches(ctx, {}, alive)).toContain(`${s.id}  PR !5  until done  notify  pid 4242`);
    const killed: number[] = [];
    expect(stopWatches(ctx, { id: s.id }, (p) => killed.push(p))).toContain(`stopped 1 watch(es): ${s.id}`);
    expect(killed).toEqual([4242]);
    expect(readSpecs(dir)).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("drops entries of watchers that are gone and rejects bad flags", async () => {
    const { dir } = makeRepo();
    const { ctx, errs } = ctxFor(dir, fakeFetch([]).fn);
    startWatch(ctx, { branch: "feature/1-x" }, () => 99, () => true);
    expect(listWatches(ctx, {}, () => false)).toBe("no running watches");
    expect(existsSync(join(dir, ".git", "aihub", "watches"))).toBe(true);
    expect(readSpecs(dir)).toEqual([]);
    expect(await main(["watch", "--pr", "5", "--until", "never"], ctx)).toBe(1);
    expect(errs[0]).toContain("--until must be one of");
    expect(await main(["watch", "stop", "--id", "nope"], ctx)).toBe(1);
  });
});

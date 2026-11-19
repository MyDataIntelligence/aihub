import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSpecs } from "../src/lib/watch.js";
import { listWatches, stopWatches } from "../src/lib/watch.js";
import {
  LOGON_KEY,
  LOGON_NAME,
  logonCommand,
  mentionsMe,
  newEvents,
  pollMine,
  readState,
  registerAtLogon,
  removeAtLogon,
  runMine,
  startMine,
  type MineState,
} from "../src/lib/watchMine.js";
import { AdoClient, parseRemote } from "../src/lib/ado.js";
import { setNotifyMode } from "../src/lib/notifyPolicy.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const ME = { id: "me-guid", name: "Ferron Test" };
const ANNA = { id: "anna-guid", displayName: "Anna" };
const REPO = { id: "repo-1", name: "test-project", project: { id: "proj-1" } };

const pr = (id: number, over: Record<string, unknown> = {}) => ({
  pullRequestId: id,
  title: `Title ${id}`,
  status: "active",
  createdBy: { id: ME.id, displayName: ME.name },
  reviewers: [],
  repository: REPO,
  ...over,
});
const comment = (id: number, who: { id: string; displayName: string }, content: string, extra: object = {}) => ({ id, content, author: who, commentType: "text", ...extra });
const mine = { id: ME.id, displayName: ME.name };

interface World {
  created?: object[];
  reviewing?: object[];
  threads?: Record<number, object[]>;
  evals?: Record<number, object[]>;
  prs?: Record<string, object>;
  workItems?: number[];
  wiComments?: Record<number, object[]>;
}

function routes(w: () => World): Route[] {
  return [
    { match: /^https:\/\/dev\.azure\.com\/[^/]+\/_apis\/connectionData\?/, respond: () => ({ body: { authenticatedUser: { id: ME.id, customDisplayName: ME.name } } }) },
    { match: /\/_apis\/git\/pullrequests\?/, respond: (c) => ({ body: { value: c.url.includes("creatorId") ? (w().created ?? []) : c.url.includes("reviewerId") ? (w().reviewing ?? []) : [] } }) },
    { match: /\/pullRequests\/(\d+)\/threads\?/i, respond: (c) => ({ body: { value: w().threads?.[Number(/pullRequests\/(\d+)\//i.exec(c.url)![1])] ?? [] } }) },
    { match: /\/policy\/evaluations\?/, respond: (c) => ({ body: { value: w().evals?.[Number(/CodeReviewId%2F[^%]+%2F(\d+)|CodeReviewId\/[^/]+\/(\d+)/.exec(c.url)?.slice(1).find(Boolean))] ?? [] } }) },
    { match: /\/git\/repositories\/[^/]+\/pullrequests\/(\d+)\?/i, respond: (c) => ({ body: w().prs?.[/pullrequests\/(\d+)\?/i.exec(c.url)![1]] ?? { status: "active" } }) },
    { method: "POST", match: /\/wit\/wiql\?/, respond: () => ({ body: { workItems: (w().workItems ?? []).map((id) => ({ id })) } }) },
    { match: /\/wit\/workItems\/(\d+)\/comments\?/i, respond: (c) => ({ body: { comments: w().wiComments?.[Number(/workItems\/(\d+)\//i.exec(c.url)![1])] ?? [] } }) },
  ];
}

const emptyState = (): MineState => ({ version: 1, seen: {}, prs: {}, started: 0 });

function client(w: World | (() => World)) {
  const get = typeof w === "function" ? w : () => w;
  const f = fakeFetch(routes(get));
  return { c: new AdoClient(parseRemote("https://ferron@dev.azure.com/ferron-org/test-project/_git/test-project"), async () => "Basic x", f.fn), calls: f.calls };
}

const kinds = (events: { kind: string }[]) => events.map((e) => e.kind).sort();

describe("mentionsMe", () => {
  it("finds a PR comment guid mention, a work item html mention and @Name", () => {
    expect(mentionsMe("hi @<ME-GUID> look", ME)).toBe(true);
    expect(mentionsMe('<a href="#" data-vss-mention="version:2.0,me-guid">@Ferron Test</a> please', ME)).toBe(true);
    expect(mentionsMe("cc @ferron test", ME)).toBe(true);
    expect(mentionsMe("nothing here", ME)).toBe(false);
  });
});

describe("pollMine events", () => {
  it("new thread on my PR by someone else, not answered by me yet", async () => {
    const { c } = client({ created: [pr(7)], threads: { 7: [{ id: 1, status: "active", comments: [comment(1, ANNA, "Waarom deze wijziging?")] }] } });
    const { events } = await pollMine(c, ME, emptyState());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "thread", id: "thread:repo-1:7:1:1" });
    expect(events[0].message).toContain("Anna commented on PR !7");
    expect(events[0].message).toContain("Waarom deze wijziging?");
  });

  it("a thread whose last comment is mine, a closed thread and a system comment raise nothing", async () => {
    const { c } = client({
      created: [pr(7)],
      threads: {
        7: [
          { id: 1, status: "active", comments: [comment(1, ANNA, "q"), comment(2, mine, "a")] },
          { id: 2, status: "fixed", comments: [comment(1, ANNA, "done")] },
          { id: 3, status: "active", comments: [comment(1, ANNA, "x", { commentType: "system" })] },
        ],
      },
    });
    expect((await pollMine(c, ME, emptyState())).events).toEqual([]);
  });

  it("a reply by someone else after my comment is reported as a reply, with a new id", async () => {
    const { c } = client({ created: [pr(7)], threads: { 7: [{ id: 1, status: "active", comments: [comment(1, ANNA, "q"), comment(2, mine, "a"), comment(3, ANNA, "nog een vraag")] }] } });
    const { events } = await pollMine(c, ME, emptyState());
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("thread:repo-1:7:1:3");
    expect(events[0].message).toContain("replied to your comment");
  });

  it("@mention in a thread of a PR I only review; reply to my own comment there; plain comment there stays quiet", async () => {
    const other = pr(8, { createdBy: ANNA, reviewers: [{ ...mine, vote: 10 }] });
    const { c } = client({
      reviewing: [other],
      threads: {
        8: [
          { id: 1, status: "active", comments: [comment(1, ANNA, `@<${ME.id}> kun je kijken?`)] },
          { id: 2, status: "active", comments: [comment(1, mine, "mijn opmerking"), comment(2, ANNA, "antwoord")] },
          { id: 3, status: "active", comments: [comment(1, ANNA, "los commentaar")] },
        ],
      },
    });
    const { events } = await pollMine(c, ME, emptyState());
    expect(kinds(events)).toEqual(["mention", "thread"]);
    expect(events.find((e) => e.kind === "mention")!.id).toBe("mention:repo-1:8:1:1");
    expect(events.find((e) => e.kind === "thread")!.id).toBe("thread:repo-1:8:2:2");
  });

  it("a mention in the last comment of my own PR is one event, not two", async () => {
    const { c } = client({ created: [pr(7)], threads: { 7: [{ id: 1, status: "active", comments: [comment(1, ANNA, `@<${ME.id}> ping`)] }] } });
    expect(kinds((await pollMine(c, ME, emptyState())).events)).toEqual(["mention"]);
  });

  it("review requested from me: only while my vote is 0", async () => {
    const asked = pr(9, { createdBy: ANNA, reviewers: [{ ...mine, vote: 0 }] });
    const done = pr(10, { createdBy: ANNA, reviewers: [{ ...mine, vote: 10 }] });
    const { c } = client({ reviewing: [asked, done] });
    const { events } = await pollMine(c, ME, emptyState());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "review", id: "review:repo-1:9" });
    expect(events[0].message).toContain("Anna requested your review on PR !9");
  });

  it("vote change on my PR: approved and rejected; no vote and my own vote stay quiet", async () => {
    const p = pr(7, { reviewers: [{ ...ANNA, vote: 10 }, { id: "bob", displayName: "Bob", vote: -10 }, { id: "carl", displayName: "Carl", vote: 0 }, { ...mine, vote: 10 }] });
    const { c } = client({ created: [p], reviewing: [p] });
    const { events } = await pollMine(c, ME, emptyState());
    expect(events.map((e) => e.id).sort()).toEqual(["vote:repo-1:7:anna-guid:10", "vote:repo-1:7:bob:-10"]);
    expect(events.find((e) => e.id.endsWith("bob:-10"))!.message).toContain("Bob rejected on your PR");
  });

  it("failed build policy on my PR (not on a PR I only review); a passing one is quiet", async () => {
    const ev = (id: string, status: string) => ({ evaluationId: id, status, completedDate: "2026-11-17T10:00:00Z", configuration: { isEnabled: true, type: { displayName: "Build" }, settings: { displayName: "ruff" } } });
    const other = pr(8, { createdBy: ANNA, reviewers: [{ ...mine, vote: 10 }] });
    const { c } = client({ created: [pr(7)], reviewing: [other], evals: { 7: [ev("e1", "rejected"), ev("e2", "approved")], 8: [ev("e3", "rejected")] } });
    const { events } = await pollMine(c, ME, emptyState());
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("policy");
    expect(events[0].message).toBe('Build (ruff) failed on your PR !7 "Title 7" (test-project)');
  });

  it("my PR that was active and is now completed or abandoned", async () => {
    const state = emptyState();
    state.prs = { "repo-1/7": "active", "repo-1/8": "active", "repo-1/9": "active" };
    const { c } = client({ created: [pr(9)], prs: { 7: pr(7, { status: "completed" }), 8: pr(8, { status: "abandoned" }) } });
    const { events, prs } = await pollMine(c, ME, state);
    expect(events.map((e) => e.id).sort()).toEqual(["pr:repo-1/7:completed", "pr:repo-1/8:abandoned"]);
    expect(events[0].message).toMatch(/^Your PR !\d "Title \d" \(test-project\) is now (completed|abandoned)$/);
    expect(prs).toEqual({ "repo-1/9": "active" });
  });

  it("work item comments that mention me, on my items, by someone else", async () => {
    const { c } = client({
      workItems: [55],
      wiComments: {
        55: [
          { id: 1, text: `<div><a href="#" data-vss-mention="version:2.0,${ME.id}">@Ferron Test</a> kun je dit nakijken?</div>`, createdBy: ANNA },
          { id: 2, text: `<a data-vss-mention="version:2.0,${ME.id}">@x</a> zelf`, createdBy: mine },
          { id: 3, text: "geen mention", createdBy: ANNA },
        ],
      },
    });
    const { events } = await pollMine(c, ME, emptyState());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "workitem-mention", id: "wimention:55:1" });
    expect(events[0].message).toContain("Anna mentioned you on work item 55: @Ferron Test kun je dit nakijken?");
  });

  it("only the repositories of team.yaml when given", async () => {
    const elsewhere = pr(11, { repository: { id: "repo-2", name: "other", project: { id: "proj-1" } } });
    const { c } = client({ created: [pr(7), elsewhere], threads: { 7: [], 11: [{ id: 1, status: "active", comments: [comment(1, ANNA, "x")] }] } });
    expect((await pollMine(c, ME, emptyState(), { repos: ["test-project"] })).events).toEqual([]);
    expect(kinds((await pollMine(c, ME, emptyState(), { repos: [] })).events)).toEqual(["thread"]);
  });
});

describe("dedupe", () => {
  it("reports an event id once; the first look only records", () => {
    const st = emptyState();
    const e = [{ id: "a", kind: "thread" as const, message: "m" }];
    expect(newEvents(st, e, 1000, true)).toEqual([]); // backlog
    expect(newEvents(st, e, 2000, false)).toEqual([]); // already recorded
    expect(newEvents(st, [...e, { id: "b", kind: "vote" as const, message: "n" }], 3000, false).map((x) => x.id)).toEqual(["b"]);
    expect(newEvents(st, [{ id: "b", kind: "vote" as const, message: "n" }], 4000, false)).toEqual([]);
  });

  it("forgets ids after 30 days", () => {
    const st = emptyState();
    st.seen = { old: 0 };
    newEvents(st, [], 31 * 24 * 3_600_000, false);
    expect(st.seen).toEqual({});
  });
});

describe("runMine", () => {
  const spec = { id: "mine", mine: true, until: "done" as const, notify: true, timeoutMs: Number.MAX_SAFE_INTEGER, intervalMs: 1000, started: 0 };

  function setup(world: () => World) {
    const { dir } = makeRepo();
    const f = fakeFetch(routes(world));
    const { ctx, lines } = ctxFor(dir, f.fn);
    const toasts: { title: string; message: string; url?: string }[] = [];
    const notifier = (title: string, message: string, a?: { url: string }) => (toasts.push({ title, message, url: a?.url }), true);
    setNotifyMode(ctx.env, "all"); // these tests are about the poller; the notify levels have their own tests (notify-policy.test.ts)
    return { dir, ctx, lines, toasts, notifier };
  }

  it("first poll is silent (existing backlog), a later new comment raises one toast with an aihub:// Open link and is not repeated", async () => {
    let step = 0;
    const world = (): World => ({
      created: [pr(7)],
      threads: { 7: step === 0 ? [{ id: 1, status: "active", comments: [comment(1, ANNA, "oude vraag")] }] : [{ id: 1, status: "active", comments: [comment(1, ANNA, "oude vraag")] }, { id: 2, status: "active", comments: [comment(1, ANNA, "nieuwe vraag")] }] },
    });
    const s = setup(world);
    s.ctx.sleep = async () => void step++;
    const r = await runMine(s.ctx, spec, { notifier: s.notifier, maxPolls: 4 });
    expect(r.polls).toBe(4);
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0].title).toBe("aihub");
    expect(s.toasts[0].message).toContain("nieuwe vraag");
    expect(s.toasts[0].url).toMatch(/^aihub:\/\/open\?event=mine-/);
    expect(readFileSync(join(s.dir, ".git", "aihub", "events.log"), "utf8")).toContain("mine/thread\tAnna commented on PR !7");
    // the dedupe state is persisted in .git/aihub/watch-state
    expect(Object.keys(readState(s.dir)!.seen).sort()).toEqual(["thread:repo-1:7:1:1", "thread:repo-1:7:2:1"]);
  });

  it("a second run (new process) does not repeat what the state file already knows", async () => {
    const world = (): World => ({ created: [pr(7)], threads: { 7: [{ id: 1, status: "active", comments: [comment(1, ANNA, "q")] }] } });
    const s = setup(world);
    await runMine(s.ctx, spec, { notifier: s.notifier, maxPolls: 1, includeExisting: true });
    expect(s.toasts).toHaveLength(1);
    await runMine(s.ctx, spec, { notifier: s.notifier, maxPolls: 2 });
    expect(s.toasts).toHaveLength(1);
  });

  it("--include-existing reports the backlog once", async () => {
    const s = setup(() => ({ created: [pr(7)], threads: { 7: [{ id: 1, status: "active", comments: [comment(1, ANNA, "q")] }] } }));
    const r = await runMine(s.ctx, spec, { notifier: s.notifier, maxPolls: 2, includeExisting: true });
    expect(r.reported).toHaveLength(1);
  });

  it("without --notify nothing is shown, but the event is still logged and stored", async () => {
    const s = setup(() => ({ created: [pr(7)], threads: { 7: [{ id: 1, status: "active", comments: [comment(1, ANNA, "q")] }] } }));
    await runMine(s.ctx, { ...spec, notify: false }, { notifier: s.notifier, maxPolls: 1, includeExisting: true });
    expect(s.toasts).toEqual([]);
    expect(readFileSync(join(s.dir, ".git", "aihub", "events.log"), "utf8")).toContain("mine/thread");
  });

  it("a toast that cannot be shown is printed with the open command", async () => {
    const s = setup(() => ({ created: [pr(7)], threads: { 7: [{ id: 1, status: "active", comments: [comment(1, ANNA, "q")] }] } }));
    await runMine(s.ctx, spec, { notifier: () => false, maxPolls: 1, includeExisting: true });
    expect(s.lines.join("\n")).toContain("open it with: aihub open --event mine-");
  });
});

describe("start, list, stop, logon", () => {
  it("starts one detached poller named mine, lists it and stops it by id", () => {
    const { dir } = makeRepo();
    const { ctx } = ctxFor(dir, fakeFetch([]).fn);
    const spawned: string[] = [];
    const spawner = (_r: string, id: string) => (spawned.push(id), 777);
    const alive = () => true;
    expect(startMine(ctx, { notify: true, interval: "2m" }, spawner, alive)).toContain("watching your pull requests and mentions");
    expect(startMine(ctx, { notify: true }, spawner, alive)).toContain("already watching everything that needs you");
    expect(spawned).toEqual(["mine"]);
    const [s] = readSpecs(dir);
    expect(s).toMatchObject({ id: "mine", mine: true, notify: true, intervalMs: 120_000, pid: 777 });
    expect(listWatches(ctx, {}, alive)).toContain("mine  all my PRs, mentions and reviews, every 120 s  notify  pid 777");
    const killed: number[] = [];
    expect(stopWatches(ctx, { id: "mine" }, (p) => killed.push(p))).toContain("stopped 1 watch(es): mine");
    expect(killed).toEqual([777]);
    expect(readSpecs(dir)).toEqual([]);
  });

  it("refuses an interval without a unit", () => {
    const { dir } = makeRepo();
    const { ctx } = ctxFor(dir, fakeFetch([]).fn);
    expect(() => startMine(ctx, { interval: "2" }, () => 1, () => false)).toThrow(/--interval '2' needs a unit/);
  });

  it("registers and removes the HKCU Run entry (Windows only)", () => {
    const { dir } = makeRepo();
    const { ctx } = ctxFor(dir, fakeFetch([]).fn);
    const calls: string[][] = [];
    const reg = (a: string[]) => (calls.push(a), { status: 0 });
    expect(registerAtLogon(ctx, "2m", "win32", "C:\\node\\node.exe", "C:\\aihub\\cli.js", reg)).toContain("will start at logon");
    expect(calls[0].slice(0, 6)).toEqual(["add", LOGON_KEY, "/v", LOGON_NAME, "/t", "REG_SZ"]);
    expect(calls[0][7]).toContain("& 'C:\\node\\node.exe' 'C:\\aihub\\cli.js' watch --mine");
    expect(logonCommand("R", "N", "C", "2m")).toBe(`conhost.exe --headless powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "Set-Location -LiteralPath 'R'; & 'N' 'C' watch --mine --notify --interval 2m"`);
    expect(calls[0][7]).toContain("watch --mine --notify --interval 2m");
    expect(removeAtLogon("win32", reg)).toBe(`removed the Run entry ${LOGON_NAME}`);
    expect(calls[1]).toEqual(["delete", LOGON_KEY, "/v", LOGON_NAME, "/f"]);
    expect(removeAtLogon("win32", () => ({ status: 1 }))).toContain("no Run entry");
    expect(() => registerAtLogon(ctx, "2m", "linux")).toThrow(/Windows Run entry/);
  });
});

import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { detectClient, eventFromUrl, eventUrl, openEvent, planOpen, protocolCommands, readEvent, storeEvent, type LaunchPlan, type OpenEvent } from "../src/lib/open.js";
import { notifyCommand, readSpecs, runWatch, startWatch, type WatchSpec } from "../src/lib/watch.js";
import { ctxFor, fakeFetch, makeRepo } from "./helpers.js";

const ev = (over: Partial<OpenEvent> = {}): OpenEvent => ({
  id: "e1",
  repo: "C:/work/test-repo",
  client: "opencode",
  message: "PR !553: ci #7 finished: failed in Test / Run tests",
  prompt: "PR 553: pipeline rood in stap Tests — ga verder",
  at: 1,
  ...over,
});

describe("launch plan per client (nothing is launched)", () => {
  it("opencode continues the last session, or the named one, with the first message", () => {
    expect(planOpen(ev(), "linux").text).toBe("cd 'C:/work/test-repo' && 'opencode' '--continue' '--prompt' 'PR 553: pipeline rood in stap Tests — ga verder'");
    expect(planOpen(ev({ session: "ses_1" }), "linux").text).toContain("'--session' 'ses_1' '--prompt'");
  });

  it("codex and claude resume their session", () => {
    expect(planOpen(ev({ client: "codex" }), "linux").text).toContain("'codex' 'resume' '--last' 'PR 553");
    expect(planOpen(ev({ client: "codex", session: "abc" }), "linux").text).toContain("'codex' 'resume' 'abc' 'PR 553");
    expect(planOpen(ev({ client: "claude" }), "linux").text).toContain("'claude' '--continue' 'PR 553");
    expect(planOpen(ev({ client: "claude", session: "s9" }), "linux").text).toContain("'claude' '--resume' 's9' 'PR 553");
  });

  it("copilot (and an unknown client) opens VS Code in the repository", () => {
    const p = planOpen(ev({ client: "copilot" }), "linux");
    expect(p).toMatchObject({ cmd: "code", args: ["C:/work/test-repo"] });
    expect(planOpen(ev({ client: undefined }), "win32").shell).toBe(true);
  });

  it("windows uses Windows Terminal when present, else a PowerShell window in the repo", () => {
    const wt = planOpen(ev({ message: "it's red", prompt: "it's red — ga verder" }), "win32", true);
    expect(wt.cmd).toBe("wt.exe");
    expect(wt.args.slice(0, 5)).toEqual(["-d", "C:/work/test-repo", "powershell.exe", "-NoExit", "-Command"]);
    expect(wt.args[5]).toBe("& 'opencode' '--continue' '--prompt' 'it''s red — ga verder'");
    const plain = planOpen(ev(), "win32", false);
    expect(plain.cmd).toBe("cmd.exe");
    expect(plain.args.slice(0, 5)).toEqual(["/c", "start", "", "/D", "C:/work/test-repo"]);
  });

  it("macOS and Linux open a terminal", () => {
    expect(planOpen(ev(), "darwin").cmd).toBe("osascript");
    expect(planOpen(ev(), "linux").cmd).toBe("x-terminal-emulator");
  });
});

describe("aihub open", () => {
  it("opens an event by id, by link and the newest one", async () => {
    const { dir } = makeRepo();
    const { ctx } = ctxFor(dir, fakeFetch([]).fn);
    storeEvent(ctx.env, ev({ id: "w1-1" }));
    await new Promise((r) => setTimeout(r, 20));
    storeEvent(ctx.env, ev({ id: "w1-2", client: "claude", message: "newer" }));
    const plans: LaunchPlan[] = [];
    const launcher = (p: LaunchPlan) => (plans.push(p), true);
    expect(openEvent(ctx, { event: "w1-1" }, launcher, "linux")).toContain("opened opencode in C:/work/test-repo");
    expect(openEvent(ctx, { url: eventUrl("w1-2") }, launcher, "linux")).toContain("opened claude");
    expect(openEvent(ctx, { last: true }, launcher, "linux")).toContain("newer");
    expect(plans.map((p) => p.cmd)).toEqual(["x-terminal-emulator", "x-terminal-emulator", "x-terminal-emulator"]);
    expect(openEvent(ctx, { event: "w1-1", print: true }, launcher, "linux")).toContain("'--continue'");
    expect(plans).toHaveLength(3);
    expect(openEvent(ctx, { last: true }, () => false, "linux")).toContain("could not launch a terminal here; run: cd");
  });

  it("answers clearly for unknown events and bad links", async () => {
    const { dir } = makeRepo();
    const { ctx, errs } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["open", "--event", "nope"], ctx)).toBe(1);
    expect(errs[0]).toContain("no event 'nope'");
    expect(await main(["open", "--last"], ctx)).toBe(1);
    expect(errs[1]).toContain("no watch events recorded");
    expect(await main(["open", "--url", "https://x"], ctx)).toBe(1);
    expect(await main(["open"], ctx)).toBe(1);
    expect(eventFromUrl("aihub://open?event=a-1")).toBe("a-1");
  });
});

describe("client detection and protocol", () => {
  it("takes the flag, else the environment", () => {
    expect(detectClient({}, "Codex")).toBe("codex");
    expect(detectClient({ OPENCODE: "1" })).toBe("opencode");
    expect(detectClient({ CLAUDECODE: "1" })).toBe("claude");
    expect(detectClient({ TERM_PROGRAM: "vscode" })).toBe("copilot");
    expect(detectClient({})).toBeUndefined();
    expect(() => detectClient({}, "emacs")).toThrow(/--client must be one of/);
  });

  it("registers aihub:// under HKCU only", () => {
    const cmds = protocolCommands("C:\\node.exe", "C:\\aihub\\cli.js");
    expect(cmds.every((c) => c[1].startsWith("HKCU\\Software\\Classes\\aihub"))).toBe(true);
    expect(cmds[1]).toContain("URL Protocol");
    expect(cmds[2][4]).toBe('"C:\\node.exe" "C:\\aihub\\cli.js" open --url "%1"');
  });

  it("the toast gets an Open button that activates the protocol link", () => {
    const c = notifyCommand("win32", "aihub", "red <&>", { label: "Open", url: eventUrl("w1-1") })!;
    const script = c.args.at(-1)!;
    expect(script).toContain('activationType="protocol"');
    expect(script).toContain('<action content="Open" arguments="aihub://open?event=w1-1"');
    expect(script).toContain("red &lt;&amp;&gt;");
  });
});

describe("watch records where to come back to", () => {
  it("stores repo, client and session in the spec, registers the link when notifying, and stores events", async () => {
    const { dir } = makeRepo();
    const { ctx } = ctxFor(dir, fakeFetch([]).fn);
    let registered = 0;
    startWatch(ctx, { pr: "5", notify: true, client: "codex", session: "sess-1" }, () => 1, () => true, () => (registered++, true));
    const [s] = readSpecs(dir);
    expect(registered).toBe(1);
    expect(s).toMatchObject({ client: "codex", session: "sess-1" });
    expect(s.repo?.replace(/\\/g, "/")).toBe(dir.replace(/\\/g, "/"));

    const routes = [
      { match: /pullrequests\/5\/threads/, respond: () => ({ body: { value: [] } }) },
      { match: /pullrequests\/5\?/, respond: () => ({ body: { pullRequestId: 5, status: "active", sourceRefName: "refs/heads/f", targetRefName: "refs/heads/main" } }) },
      { match: /build\/builds\/9\/timeline/, respond: () => ({ body: { records: [{ id: "s", type: "Stage", name: "Test" }, { id: "t", parentId: "s", type: "Task", name: "Run tests", result: "failed", order: 1 }] } }) },
      { match: /build\/builds\?/, respond: () => ({ body: { value: [{ id: 9, buildNumber: "1.9", status: "completed", result: "failed", definition: { id: 1, name: "ci" } }] } }) },
    ];
    const c2 = ctxFor(dir, fakeFetch(routes).fn);
    const seen: { m: string; url?: string }[] = [];
    const spec: WatchSpec = { ...s, until: "done", notify: true, timeoutMs: 1000, intervalMs: 10 };
    await runWatch(c2.ctx, spec, { notifier: (_t, m, a) => (seen.push({ m, url: a?.url }), true) });
    expect(seen[0].m).toContain("ci failed in Test / Run tests");
    expect(seen[0].url).toBe(eventUrl(`${s.id}-1`));
    const stored = readEvent(c2.ctx.env, `${s.id}-1`);
    expect(stored).toMatchObject({ client: "codex", session: "sess-1" });
    expect(stored.prompt).toContain("— ga verder");
  });
});

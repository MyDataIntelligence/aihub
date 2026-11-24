import { describe, expect, it } from "vitest";
import { planOpen, resumeArgs } from "../src/lib/open.js";
import { parseRunRef } from "../src/lib/pipeline.js";
import { AdoClient, parseRemote } from "../src/lib/ado.js";
import { buildEvents } from "../src/lib/watchMine.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const ME = { id: "me-guid", name: "Test User" };
const BUILDS = "/ferron-org/test-project/_apis/build/builds";

const build = (id: number, branch: string, extra: object = {}) => ({
  id,
  buildNumber: `20260101.${id}`,
  status: "completed",
  result: "failed",
  sourceBranch: `refs/heads/${branch}`,
  definition: { id: 3, name: "ci" },
  ...extra,
});

function client(routes: Route[]) {
  return new AdoClient(parseRemote("https://dev.azure.com/ferron-org/test-project/_git/test-repo"), async () => "t", fakeFetch(routes).fn);
}

describe("watch --mine: a failed build on my own branch", () => {
  it("raises a Fix event with /fix <run url> for the aihub agent, never for a protected branch or a PR merge build", async () => {
    const c = client([
      {
        match: /build\/builds\?/,
        respond: (call) => {
          expect(call.url).toContain(`requestedFor=${ME.id}`);
          expect(call.url).toContain("resultFilter=failed");
          return { body: { value: [build(11, "feature/12-export", { _links: { web: { href: "https://dev.azure.com/ferron-org/test-project/_build/results?buildId=11" } } }), build(12, "main"), build(13, "release/1.0"), build(14, "x", { sourceBranch: "refs/pull/5/merge" }), build(15, "feature/9-search")] } };
        },
      },
    ]);
    const events = await buildEvents(c, { id: ME.id, name: ME.name });
    expect(events.map((e) => e.id)).toEqual(["build:11", "build:15"]);
    expect(events[0]).toMatchObject({ kind: "build", label: "Fix", agent: "aihub", prompt: "/fix https://dev.azure.com/ferron-org/test-project/_build/results?buildId=11" });
    expect(events[0].message).toBe("Build ci #20260101.11 failed on your branch feature/12-export");
    expect(events[1].prompt).toContain("buildId=15");
  });

  it("the stored event starts opencode and Claude Code with --agent aihub", () => {
    const ev = { id: "e1", repo: "/r", client: "opencode" as const, message: "m", prompt: "/fix https://x/_build/results?buildId=1", agent: "aihub", at: 1 };
    expect(resumeArgs(ev)).toEqual(["opencode", "--agent", "aihub", "--prompt", ev.prompt]);
    expect(resumeArgs({ ...ev, client: "claude" })).toEqual(["claude", "--continue", "--agent", "aihub", ev.prompt]);
    expect(resumeArgs({ ...ev, agent: undefined })).toEqual(["opencode", "--prompt", ev.prompt]);
    expect(planOpen(ev, "linux").text).toContain("'--agent' 'aihub'");
  });
});

describe("aihub pipeline logs --failed", () => {
  const TIMELINE = { records: [{ id: "t2", type: "Task", name: "Run tests", result: "failed", order: 2, log: { id: 2 } }] };
  const LOG = "2026-01-01T10:01:02.0000000Z FAILED test_export\n2026-01-01T10:01:03.0000000Z ##[error]Bash exited with code 1\n";

  function world(branch: string, history: object[]) {
    const { dir } = makeRepo();
    const routes: Route[] = [
      { match: /build\/builds\/12\/timeline/, respond: () => ({ body: TIMELINE }) },
      { match: /build\/builds\/12\/logs\/2/, respond: () => ({ text: LOG }) },
      { match: /build\/builds\/12\?/, respond: () => ({ body: build(12, branch) }) },
      { match: /build\/builds\?/, respond: () => ({ body: { value: history } }) },
    ];
    const f = fakeFetch(routes);
    return ctxFor(dir, f.fn);
  }

  it("accepts a build link and leads with branch, protected flag and red rounds", async () => {
    const { ctx, lines } = world("feature/12-export", [build(12, "feature/12-export"), build(11, "feature/12-export"), build(10, "feature/12-export", { result: "succeeded" })]);
    expect(await main(["pipeline", "logs", "--failed", "--run", "https://dev.azure.com/ferron-org/test-project/_build/results?buildId=12&view=logs"], ctx)).toBe(0);
    const out = lines.join("\n");
    expect(out.split("\n")[0]).toBe("run 12 failed on feature/12-export; protected: no; red runs in a row: 2");
    expect(out).toContain("Run tests");
    expect(out).toContain("FAILED test_export");
    expect(out).not.toContain("STOP");
  });

  it("puts the real error line of the log right under line 1, without the generic 'exited with code'", async () => {
    const { dir } = makeRepo();
    const log = "2026-01-01T10:01:02.0000000Z ##[error]BENCH-abc123-PIPE: tabel klanten mist de kolom klantnummer\n2026-01-01T10:01:03.0000000Z ##[error]Bash exited with code '1'.\n";
    const routes: Route[] = [
      { match: /build\/builds\/12\/timeline/, respond: () => ({ body: TIMELINE }) },
      { match: /build\/builds\/12\/logs\/2/, respond: () => ({ text: log }) },
      { match: /build\/builds\/12\?/, respond: () => ({ body: build(12, "feature/12-export") }) },
      { match: /build\/builds\?/, respond: () => ({ body: { value: [build(12, "feature/12-export")] } }) },
    ];
    const { ctx, lines } = ctxFor(dir, fakeFetch(routes).fn);
    expect(await main(["pipeline", "logs", "--failed", "--run", "12"], ctx)).toBe(0);
    expect(lines.join("\n").split("\n")[1]).toBe("error (quote it as is): BENCH-abc123-PIPE: tabel klanten mist de kolom klantnummer");
    const j = ctxFor(dir, fakeFetch(routes).fn);
    await main(["pipeline", "logs", "--failed", "--run", "12", "--json"], j.ctx);
    expect(JSON.parse(j.lines.join("")).errors).toEqual(["BENCH-abc123-PIPE: tabel klanten mist de kolom klantnummer"]);
  });

  it("says STOP after three red rounds and on a protected branch", async () => {
    const three = world("feature/x", [build(12, "feature/x"), build(11, "feature/x"), build(10, "feature/x")]);
    expect(await main(["pipeline", "logs", "--failed", "--run", "12"], three.ctx)).toBe(0);
    expect(three.lines.join("\n")).toContain("STOP after 3 red rounds");
    const prot = world("staging", [build(12, "staging")]);
    expect(await main(["pipeline", "logs", "--failed", "--run", "12", "--json"], prot.ctx)).toBe(0);
    const j = JSON.parse(prot.lines.join(""));
    expect(j).toMatchObject({ run: 12, branch: "staging", protected: true });
    expect(j.stop).toContain("protected branch");
  });

  it("parseRunRef reads ids and links and refuses the rest", () => {
    expect(parseRunRef("42")).toBe(42);
    expect(parseRunRef("https://dev.azure.com/o/p/_build/results?buildId=7&view=logs")).toBe(7);
    expect(() => parseRunRef("https://x/y")).toThrow(/not a run id/);
    expect(BUILDS).toContain("build/builds");
  });
});

describe("runMine with a failed own build", () => {
  it("toasts with the Fix label and stores /fix <url> for the aihub agent", async () => {
    const { dir } = makeRepo();
    const routes: Route[] = [
      { match: /_apis\/connectionData\?/, respond: () => ({ body: { authenticatedUser: { id: ME.id, customDisplayName: ME.name } } }) },
      { match: /\/_apis\/git\/pullrequests\?/, respond: () => ({ body: { value: [] } }) },
      { method: "POST", match: /\/wit\/wiql\?/, respond: () => ({ body: { workItems: [] } }) },
      { match: /build\/builds\?/, respond: () => ({ body: { value: [build(21, "feature/3-api", { _links: { web: { href: "https://dev.azure.com/ferron-org/test-project/_build/results?buildId=21" } } })] } }) },
    ];
    const { ctx } = ctxFor(dir, fakeFetch(routes).fn);
    const toasts: { label?: string; url?: string; message: string }[] = [];
    const { runMine } = await import("../src/lib/watchMine.js");
    const { readEvent, eventFromUrl } = await import("../src/lib/open.js");
    const spec = { id: "mine", mine: true, until: "done" as const, notify: true, timeoutMs: Number.MAX_SAFE_INTEGER, intervalMs: 1000, started: 0 };
    await runMine(ctx, spec, { includeExisting: true, maxPolls: 1, notifier: (_t, message, a) => (toasts.push({ message, label: a?.label, url: a?.url }), true) });
    expect(toasts).toHaveLength(1);
    expect(toasts[0].label).toBe("Fix");
    const ev = readEvent(ctx.env, eventFromUrl(toasts[0].url!));
    expect(ev.prompt).toBe("/fix https://dev.azure.com/ferron-org/test-project/_build/results?buildId=21");
    expect(ev.agent).toBe("aihub");
  });
});

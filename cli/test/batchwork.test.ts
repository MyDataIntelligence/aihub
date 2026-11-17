import { describe, expect, it } from "vitest";
import { batch, runBatch, splitCommand, type Runner } from "../src/lib/batch.js";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo } from "./helpers.js";

describe("splitCommand", () => {
  it("honours quotes", () => {
    expect(splitCommand(`pr update --pr {target} --title "a b" 'c d'`)).toEqual(["pr", "update", "--pr", "{target}", "--title", "a b", "c d"]);
  });
});

describe("batch", () => {
  it("runs targets in parallel (max 4 at once), continues on errors, stores a batch for retry", async () => {
    const { dir } = makeRepo();
    const { ctx, lines, errs } = ctxFor(dir, fakeFetch([]).fn);
    let active = 0;
    let peak = 0;
    const seen: string[][] = [];
    let failTwo = true;
    const runner: Runner = async (argv) => {
      seen.push(argv);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      const t = argv[argv.length - 1];
      if (t === "2" && failTwo) return { code: 1, output: "aihub: conflict in a.txt" };
      return { code: 0, output: `done ${t}` };
    };
    await expect(batch(ctx, { select: "ids:1,2,3,4,5,6", run: "aihub cherry-pick --from {target}" }, runner)).rejects.toThrow(/1 of 6 failed; retry with: aihub batch --retry-failed (b\w+)/);
    expect(peak).toBe(4);
    expect(seen).toHaveLength(6);
    expect(seen[0]).toEqual(["cherry-pick", "--from", "1"]);
    expect(lines[0]).toMatch(/^batch b\w+: 5\/6 ok/);
    expect(lines.join("\n")).toMatch(/2 +FAILED +aihub: conflict in a\.txt/);
    expect(lines.join("\n")).toMatch(/3 +ok +done 3/);
    const id = /^batch (b\w+):/.exec(lines[0])![1];

    failTwo = false;
    seen.length = 0;
    lines.length = 0;
    await batch(ctx, { retryFailed: id }, runner);
    expect(seen).toEqual([["cherry-pick", "--from", "2"]]);
    expect(lines[0]).toBe(`batch ${id}: 6/6 ok`);
    lines.length = 0;
    await batch(ctx, { retryFailed: id }, runner);
    expect(lines[0]).toContain("nothing failed");
    void errs;
  });

  it("validates --run and --parallel, and runBatch survives a throwing runner", async () => {
    const { dir } = makeRepo();
    const { ctx } = ctxFor(dir, fakeFetch([]).fn);
    const ok: Runner = async () => ({ code: 0, output: "" });
    await expect(batch(ctx, { select: "ids:1", run: "pr update" }, ok)).rejects.toThrow(/\{target\}/);
    await expect(batch(ctx, { select: "ids:1", run: "batch x {target}" }, ok)).rejects.toThrow(/not batch/);
    await expect(batch(ctx, { select: "ids:1", run: "x {target}", parallel: 9 }, ok)).rejects.toThrow(/1\.\.8/);
    await expect(batch(ctx, { select: "wat:1", run: "x {target}" }, ok)).rejects.toThrow(/unknown query/);
    const r = await runBatch(["a", "b"], ["x", "{target}"], 2, async (argv) => {
      if (argv[1] === "a") throw new Error("boom");
      return { code: 0, output: "fine" };
    });
    expect(r).toEqual([
      { target: "a", ok: false, summary: "boom" },
      { target: "b", ok: true, summary: "fine" },
    ]);
  });

  it("asks connectionData at organization level, not under the project (live: 404 otherwise)", async () => {
    const { dir } = makeRepo();
    const f = fakeFetch([
      { match: /^https:\/\/dev\.azure\.com\/[^/]+\/_apis\/connectionData\?/, respond: () => ({ body: { authenticatedUser: { id: "me-guid" } } }) },
      { match: /pullrequests\?/, respond: () => ({ body: { value: [{ pullRequestId: 7 }] } }) },
    ]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    const runner: Runner = async (argv) => ({ code: 0, output: argv.join(" ") });
    await batch(ctx, { select: "prs:mine", run: "pr changes --pr {target}" }, runner);
    expect(lines.join("\n")).toContain("7  ok");
    expect(f.calls.find((c) => c.url.includes("connectionData"))?.url).not.toMatch(/\/test-project\/_apis\/connectionData/);
  });

  it("selects PRs and branches through the ADO API", async () => {
    const { dir } = makeRepo();
    const f = fakeFetch([
      { match: /connectionData/, respond: () => ({ body: { authenticatedUser: { id: "me-guid" } } }) },
      { match: /pullrequests\?/, respond: (c) => ({ body: { value: c.url.includes("creatorId=me-guid") ? [{ pullRequestId: 7 }] : [{ pullRequestId: 7 }, { pullRequestId: 8 }] } }) },
      { match: /\/refs\?/, respond: () => ({ body: { value: [{ name: "refs/heads/release/1.2" }, { name: "refs/heads/release/1.3" }, { name: "refs/heads/main" }] } }) },
    ]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    const runner: Runner = async (argv) => ({ code: 0, output: argv.join(" ") });
    await batch(ctx, { select: "prs:mine", run: "pr changes --pr {target}" }, runner);
    expect(lines.join("\n")).toContain("7  ok      pr changes --pr 7");
    lines.length = 0;
    await batch(ctx, { select: "prs:active", run: "pr changes --pr {target}" }, runner);
    expect(lines[0]).toContain("2/2 ok");
    lines.length = 0;
    await batch(ctx, { select: "branches:release/*", run: "branch update --branch {target}" }, runner);
    expect(lines[0]).toContain("2/2 ok");
    expect(lines.join("\n")).toContain("release/1.3");
  });
});

describe("work", () => {
  it("lists my stories, PRs with open threads and the latest pipeline per PR", async () => {
    const { dir } = makeRepo();
    const f = fakeFetch([
      { match: /connectionData/, respond: () => ({ body: { authenticatedUser: { id: "me" } } }) },
      { method: "POST", match: /wit\/wiql/, respond: () => ({ body: { workItems: [{ id: 55 }] } }) },
      { match: /wit\/workitems\?/, respond: () => ({ body: { value: [{ id: 55, fields: { "System.State": "Active", "System.Title": "Zoeken" } }] } }) },
      { match: /pullrequests\?/, respond: () => ({ body: { value: [{ pullRequestId: 5, title: "t", status: "active", sourceRefName: "refs/heads/feature/5-x", targetRefName: "refs/heads/main" }] } }) },
      {
        match: /pullrequests\/5\/threads/,
        respond: () => ({
          body: {
            value: [
              { id: 1, status: "active", comments: [{ commentType: "text" }] },
              { id: 2, status: "fixed", comments: [{ commentType: "text" }] },
              { id: 3, status: "active", comments: [{ commentType: "system" }] },
            ],
          },
        }),
      },
      { match: /build\/builds\?/, respond: () => ({ body: { value: [{ id: 9, buildNumber: "9", status: "completed", result: "succeeded", definition: { id: 3, name: "test-project-ci" } }] } }) },
    ]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    expect(await main(["work"], ctx, commands)).toBe(0);
    expect(lines.join("\n")).toBe(
      ["My open stories (1)", "  55 [Active] Zoeken", "My pull requests (1)", "  !5 active feature/5-x -> main  open threads: 1  pipeline: test-project-ci #9: succeeded"].join("\n"),
    );
  });
});

import { describe, expect, it } from "vitest";
import { pipelineRerun } from "../src/lib/pipeline.js";
import { ctxFor, fakeFetch, makeRepo, sh, write, type Route } from "./helpers.js";

function world() {
  const { dir } = makeRepo();
  sh(dir, ["checkout", "-b", "feature/7-fix"]);
  write(dir, "fix.txt", "fixed\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "fix: schema"]);
  return { dir, head: sh(dir, ["rev-parse", "HEAD"]) };
}

const failed = { id: 40, status: "completed", result: "failed", sourceBranch: "refs/heads/feature/7-fix", sourceVersion: "0".repeat(40), definition: { id: 3, name: "ci-red" } };

describe("aihub pipeline rerun: the run of the pushed fix in one command", () => {
  it("queues the pipeline of the failed run again on this branch when the push started nothing", async () => {
    const { dir, head } = world();
    const routes: Route[] = [
      { match: /build\/builds\?/, respond: () => ({ body: { value: [failed] } }) },
      { method: "POST", match: /build\/builds\?/, respond: (c) => ({ body: { id: 41, definition: c.body.definition } }) },
    ];
    const f = fakeFetch(routes);
    const r = await pipelineRerun(ctxFor(dir, f.fn).ctx, {});
    expect(r).toEqual({ id: 41, pipeline: "ci-red", branch: "feature/7-fix", queued: true });
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ definition: { id: 3 }, sourceBranch: "refs/heads/feature/7-fix", sourceVersion: head });
  });

  it("preserves template parameters and skips a run with different inputs at the same revision", async () => {
    const { dir, head } = world();
    const templateParameters = { scope: ["component"], deploy: false };
    const original = { ...failed, templateParameters };
    const other = { ...failed, id: 41, sourceVersion: head };
    const f = fakeFetch([
      { match: /build\/builds\/40/, respond: () => ({ body: original }) },
      { match: /build\/builds\?/, respond: () => ({ body: { value: [other, original] } }) },
      { method: "POST", match: /build\/builds\?/, respond: () => ({ body: { id: 42 } }) },
    ]);
    expect(await pipelineRerun(ctxFor(dir, f.fn).ctx, { run: "40" })).toMatchObject({ queued: true });
    expect(f.calls.find((c) => c.method === "POST")?.body).toMatchObject({ sourceVersion: head, templateParameters });
  });

  it("returns the run the push already started for this commit, and queues nothing", async () => {
    const { dir, head } = world();
    const started = { id: 42, status: "inProgress", sourceBranch: "refs/heads/feature/7-fix", sourceVersion: head, definition: { id: 3, name: "ci-red" } };
    const f = fakeFetch([{ match: /build\/builds\?/, respond: () => ({ body: { value: [started, failed] } }) }]);
    const r = await pipelineRerun(ctxFor(dir, f.fn).ctx, {});
    expect(r).toMatchObject({ id: 42, queued: false });
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("waits a moment for the run a CI trigger creates after the push instead of queuing a second one", async () => {
    const { dir, head } = world();
    const started = { id: 43, status: "notStarted", sourceBranch: "refs/heads/feature/7-fix", sourceVersion: head, definition: { id: 3, name: "ci-red" } };
    let reads = 0;
    const f = fakeFetch([{ match: /build\/builds\?/, respond: () => ({ body: { value: ++reads === 1 ? [failed] : [started, failed] } }) }]);
    const r = await pipelineRerun(ctxFor(dir, f.fn).ctx, {});
    expect(r).toMatchObject({ id: 43, queued: false });
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("without a failed run it says so and queues nothing", async () => {
    const { dir } = world();
    const f = fakeFetch([{ match: /build\/builds\?/, respond: () => ({ body: { value: [] } }) }]);
    await expect(pipelineRerun(ctxFor(dir, f.fn).ctx, {})).rejects.toThrow(/no failed run on feature\/7-fix/);
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

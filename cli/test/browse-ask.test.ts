import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { browseOf } from "../src/lib/browse/core.js";
import { askAllow, askApply, askDiscard, askList, askPropose, askRead, askReport, askStart, askState, parseReport } from "../src/lib/browse/ask.js";
import { changeDiff } from "../src/lib/browse/change.js";
import { ctxFor, fakeFetch, tmp, type Route } from "./helpers.js";

const C1 = "1".repeat(40);
const NOW = Date.parse("2026-11-28T10:00:00Z");
const FILES: Record<string, Record<string, string>> = {
  "repo-a": { "/src/load.py": "orders = read()\nwrite(orders)\n", "/src/b.py": "b\n", "/src/c.py": "c\n" },
  "repo-b": { "/etl/load.py": "rows = read()\nwrite(rows)\n" },
};

function world() {
  const routes: Route[] = [
    { match: /\/_apis\/connectionData/, respond: () => ({ body: { authenticatedUser: { id: "me-id", providerDisplayName: "Test User" } } }) },
    { match: /^https:\/\/dev\.azure\.com\/ferron-test\/_apis\/projects\?/, respond: () => ({ body: { value: [{ id: "p1", name: "test-project" }, { id: "p2", name: "other" }] } }) },
    {
      match: /^https:\/\/dev\.azure\.com\/ferron-test\/_apis\/git\/repositories\?/,
      respond: () => ({ body: { value: ["repo-a", "repo-b"].map((n) => ({ id: n, name: n, defaultBranch: "refs/heads/main", project: { id: "p1", name: "test-project" } })).concat([{ id: "x", name: "repo-x", defaultBranch: "refs/heads/main", project: { id: "p2", name: "other" } }]) } }),
    },
    { match: /repositories\/repo-[ab]\?api-version/, respond: () => ({ body: { defaultBranch: "refs/heads/main" } }) },
    { match: /refs\?filter=heads%2Fmain/, respond: () => ({ body: { value: [{ name: "refs/heads/main", objectId: C1 }] } }) },
    { match: /refs\?filter=heads%2Ffeature/, respond: () => ({ body: { value: [] } }) },
    { match: /blobs\//, respond: () => ({ status: 404, body: { message: "not found" } }) },
    {
      match: /repositories\/(repo-[ab])\/items\?path=/,
      respond: (c) => {
        const repo = /repositories\/(repo-[ab])\//.exec(c.url)![1];
        const path = decodeURIComponent(/path=([^&]+)/.exec(c.url)![1]);
        const content = FILES[repo][path];
        if (content === undefined) return { status: 404, body: { message: `TF401174: The item '${path}' could not be found` } };
        return { body: { objectId: `${repo}${path}`, gitObjectType: "blob", commitId: C1, path, ...(c.url.includes("includeContent=true") ? { content } : {}) } };
      },
    },
  ];
  const f = fakeFetch(routes);
  const { ctx, lines } = ctxFor(tmp(), f.fn);
  ctx.env.AIHUB_ADO_ORG = "ferron-test";
  ctx.env.AIHUB_COMMON_ROOTS = "none";
  ctx.now = () => NOW;
  return { ctx, lines, calls: f.calls, b: () => browseOf(ctx, {}) };
}

const SCOPE = [{ project: "test-project", repo: "repo-a" }, { project: "test-project", repo: "repo-b" }];

describe("ask agent about selected", () => {
  it("starts a read-only question with its scope, the read limit and a task", () => {
    const w = world();
    const s = askStart(w.b(), { scope: SCOPE, prompt: "Where are inactive customers loaded?" });
    const task = readFileSync(s.taskFile, "utf8");
    expect(task).toContain("--scope test-project/repo-a,test-project/repo-b");
    expect(task).toContain(`aihub browse ask read --id ${s.id}`);
    expect(task).toContain("Read only: never change, commit, push or clone anything");
    expect(s.limit).toBe(200);
    expect(() => askStart(w.b(), { scope: [], prompt: "x" })).toThrow(/which repositories/);
  });

  it("counts the files read, stops at the limit until the user allows more, and keeps to the scope", async () => {
    const w = world();
    const s = askStart(w.b(), { scope: SCOPE, prompt: "x", limit: 2 });
    expect(await askRead(w.b(), s.id, { project: "test-project", repo: "repo-a", path: "/src/load.py" })).toMatchObject({ read: 1, commit: C1, content: FILES["repo-a"]["/src/load.py"] });
    // the agent reads several files at once: every read counts once
    await Promise.all([askRead(w.b(), s.id, { project: "test-project", repo: "repo-a", path: "/src/load.py" }), askRead(w.b(), s.id, { project: "test-project", repo: "repo-a", path: "/src/b.py" })]);
    expect((await askState(w.b(), s.id)).reads).toEqual({ count: 2, limit: 2 });
    await expect(askRead(w.b(), s.id, { project: "test-project", repo: "repo-a", path: "/src/c.py" })).rejects.toMatchObject({ kind: "readLimit" });
    expect((await askState(w.b(), s.id)).needsApproval).toBe(true);
    expect(askAllow(w.ctx.env, s.id, 5)).toEqual({ id: s.id, read: 2, limit: 7 });
    expect(await askRead(w.b(), s.id, { project: "test-project", repo: "repo-a", path: "/src/c.py" })).toMatchObject({ read: 3 });
    await expect(askRead(w.b(), s.id, { project: "other", repo: "repo-x", path: "/a" })).rejects.toMatchObject({ kind: "badInput" });
  });

  it("keeps proposals and the report apart from the repositories, with a diff per repository", async () => {
    const w = world();
    const s = askStart(w.b(), { scope: [{ project: "test-project" }], prompt: "x" });
    await askPropose(w.b(), s.id, { project: "test-project", repo: "repo-a", path: "/src/load.py", content: "orders = [o for o in read() if o.active]\nwrite(orders)\n" });
    await expect(askPropose(w.b(), s.id, { project: "test-project", repo: "repo-a", path: "/.env", content: "A=1\n" })).rejects.toMatchObject({ kind: "forbiddenFile" });
    await expect(askPropose(w.b(), s.id, { project: "test-project", repo: "repo-b", path: "/k.py", content: 'api_key = "abcdefgh12345678"\n' })).rejects.toMatchObject({ kind: "secret" });
    expect(() => parseReport("{}", s.scope as never)).toThrow(/report needs/);
    expect(() => parseReport(JSON.stringify({ summary: "s", repos: [{ project: "other", repo: "repo-x", finding: "f" }] }), [{ project: "test-project" }])).toThrow(/not in the scope/);
    askReport(w.ctx.env, s.id, JSON.stringify({ summary: "Two loaders keep inactive customers.", repos: [{ project: "test-project", repo: "repo-a", finding: "No filter on active.", refs: [{ path: "src/load.py", line: 1 }] }, { project: "test-project", repo: "repo-b", finding: "Nothing found." }] }));
    const st = await askState(w.b(), s.id);
    expect(st).toMatchObject({ status: "answered", summary: "Two loaders keep inactive customers.", reads: { count: 0, limit: 200 }, needsApproval: false });
    const a = st.repos.find((r) => r.repo === "repo-a")!;
    expect(a).toMatchObject({ finding: "No filter on active.", refs: [{ path: "/src/load.py", line: 1 }], base: { branch: "main", commit: C1 }, change: null });
    expect(a.proposals.map((p) => [p.path, p.status, p.additions, p.deletions])).toEqual([["/src/load.py", "modified", 1, 1]]);
    expect(st.repos.find((r) => r.repo === "repo-b")?.proposals).toEqual([]);
  });

  it("applies the proposals per repository as a change, one branch name for every repository; nothing is pushed", async () => {
    const w = world();
    const s = askStart(w.b(), { scope: SCOPE, prompt: "Filter inactive customers", story: 4711 });
    await askPropose(w.b(), s.id, { project: "test-project", repo: "repo-a", path: "/src/load.py", content: "orders = active(read())\nwrite(orders)\n" });
    await askPropose(w.b(), s.id, { project: "test-project", repo: "repo-b", path: "/etl/load.py", content: "rows = active(read())\nwrite(rows)\n" });
    const a = await askApply(w.b(), s.id, { project: "test-project", repo: "repo-a" });
    expect(a).toMatchObject({ branch: "feature/4711-filter-inactive-customers", applied: ["/src/load.py"] });
    const b = await askApply(w.b(), s.id, { project: "test-project", repo: "repo-b" });
    expect(b.branch).toBe(a.branch);
    expect((await changeDiff(w.b(), b.id)).files.map((f) => [f.path, f.status])).toEqual([["/etl/load.py", "modified"]]);
    await expect(askApply(w.b(), s.id, { project: "test-project", repo: "repo-a" })).rejects.toMatchObject({ kind: "badInput" });
    expect((await askState(w.b(), s.id)).repos.map((r) => [r.repo, r.change])).toEqual([
      ["repo-a", a.id],
      ["repo-b", b.id],
    ]);
    expect(w.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(askList(w.ctx.env).asks.map((x) => x.id)).toEqual([s.id]);
    expect(askDiscard(w.ctx.env, s.id)).toEqual({ id: s.id, discarded: true });
  });

  it("runs as aihub browse ask ...", async () => {
    const w = world();
    const f = `${tmp()}/q.txt`;
    require("node:fs").writeFileSync(f, "Where?");
    expect(await main(["browse", "ask", "start", "--scope", "test-project/repo-a", "--prompt-file", f], w.ctx)).toBe(0);
    const s = JSON.parse(w.lines[0]);
    expect(await main(["browse", "ask", "read", "--id", s.id, "--project", "test-project", "--repo", "repo-a", "--path", "/src/b.py"], w.ctx)).toBe(0);
    expect(JSON.parse(w.lines[1])).toMatchObject({ read: 1, content: "b\n" });
  });
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { browseOf } from "../src/lib/browse/core.js";
import { branchFromTemplate, changeApply, changeDiff, changeDiscard, changeList, changePush, changeRead, changeStart, changeSummary, changeWrite, forbiddenFile, readMeta, secretIn, slugOf } from "../src/lib/browse/change.js";
import { ctxFor, fakeFetch, tmp, type Route } from "./helpers.js";

const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);
const NOW = Date.parse("2026-11-27T10:00:00Z");
const BASE_A = "line 1\nline 2\nline 3\nline 4\nline 5\n";
const BASE_B = "remove me\n";

/** repo-a in test-project: src/a.py and src/b.py on main; `head` is where main is now, `headA` a.py there. */
function world(o: { head?: string; headA?: string; branchExists?: boolean; config?: string } = {}) {
  const head = o.head ?? C1;
  const pushes: any[] = [];
  const prs: any[] = [];
  const file = (path: string, at: string) => {
    if (path === "/src/a.py") return { content: at === C2 ? (o.headA ?? BASE_A) : BASE_A, objectId: at === C2 && o.headA ? "a-new" : "a-old" };
    if (path === "/src/b.py") return { content: BASE_B, objectId: "b-old" };
    return undefined;
  };
  const routes: Route[] = [
    { match: /\/_apis\/connectionData/, respond: () => ({ body: { authenticatedUser: { id: "me-id", providerDisplayName: "Test User", properties: { Account: { $value: "test.user@example.test" } } } } }) },
    { match: /^https:\/\/dev\.azure\.com\/ferron-test\/_apis\/projects\?/, respond: () => ({ body: { value: [{ id: "p1", name: "test-project" }] } }) },
    { match: /^https:\/\/dev\.azure\.com\/ferron-test\/_apis\/git\/repositories\?/, respond: () => ({ body: { value: [{ id: "r1", name: "repo-a", defaultBranch: "refs/heads/main", project: { id: "p1", name: "test-project" } }] } }) },
    { match: /repo-a\?api-version/, respond: () => ({ body: { id: "r1", defaultBranch: "refs/heads/main" } }) },
    { match: /refs\?filter=heads%2Fmain/, respond: () => ({ body: { value: [{ name: "refs/heads/main", objectId: head }] } }) },
    { match: /refs\?filter=heads%2Ffeature/, respond: (c) => ({ body: { value: o.branchExists ? [{ name: decodeURIComponent(/filter=heads%2F([^&]+)/.exec(c.url)![1]).replace(/^/, "refs/heads/"), objectId: C3 }] : [] } }) },
    { match: /blobs\//, respond: () => ({ status: 404, body: { message: "not found" } }) },
    {
      match: /repo-a\/items\?path=/,
      respond: (c) => {
        const path = decodeURIComponent(/path=([^&]+)/.exec(c.url)![1]);
        const at = /versionDescriptor\.version=([^&]+)/.exec(c.url)?.[1] ?? C1;
        const f = file(path, at === "main" ? head : at);
        if (!f) return { status: 404, body: { message: `TF401174: The item '${path}' could not be found` } };
        return { body: { objectId: f.objectId, gitObjectType: "blob", commitId: at, path, ...(c.url.includes("includeContent=true") ? { content: f.content } : {}) } };
      },
    },
    { match: /repo-a\/commits\?/, respond: () => ({ body: { value: [{ commitId: C2, comment: "Their change", author: { name: "Tom Bakker", email: "tom.bakker@example.test", date: "2026-11-27T09:00:00Z" } }] } }) },
    { match: /wit\/workitems\/4711/, respond: () => ({ body: { fields: { "System.Title": "Orderexport" } } }) },
    { method: "POST", match: /repo-a\/pushes/, respond: (c) => (pushes.push(c.body), { status: 201, body: { commits: [{ commitId: C3 }] } }) },
    { method: "POST", match: /repo-a\/pullrequests/, respond: (c) => (prs.push(c.body), { status: 201, body: { pullRequestId: 77, title: c.body.title } }) },
  ];
  const f = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(tmp(), f.fn);
  if (o.config) ctx.env.AIHUB_CONFIG_HOME = o.config; // the same PC: the change made in another world is here
  ctx.env.AIHUB_ADO_ORG = "ferron-test";
  ctx.env.AIHUB_COMMON_ROOTS = "none";
  ctx.now = () => NOW;
  return { ctx, lines, errs, calls: f.calls, pushes, prs, b: () => browseOf(ctx, {}) };
}

describe("change with agent: names and limits", () => {
  it("makes the branch from the team template and the prompt", () => {
    expect(slugOf("Only load orders of active customers.")).toBe("only-load-orders-active-customers");
    expect(slugOf("Filter actieve klanten")).toBe("filter-actieve-klanten");
    expect(branchFromTemplate(undefined, 4711, "filter-actieve-klanten")).toBe("feature/4711-filter-actieve-klanten");
    expect(branchFromTemplate("feature/{story}/{slug}", undefined, "x")).toBe("feature/x");
    expect(branchFromTemplate("users/<slug>", 12, "fix")).toBe("users/fix");
  });
  it("knows secrets and the files a change never touches", () => {
    expect(secretIn('password = "Sup3rS3cret!"')).toBe("a password or key in quotes");
    expect(secretIn("conn = 'DefaultEndpointsProtocol=https;AccountKey=abcdefghijklmnopqrstuvwxyz0123456789=='")).toBe("a storage or service bus key");
    expect(secretIn("-----BEGIN PRIVATE KEY-----")).toBe("a private key");
    expect(secretIn("password = os.environ['DB_PASSWORD']")).toBeUndefined();
    expect(forbiddenFile("/.env")).toBe("a secrets file");
    expect(forbiddenFile("/azure-pipelines.yml")).toBe("a pipeline definition");
    expect(forbiddenFile("/pipelines/deploy.yml")).toBe("a pipeline definition");
    expect(forbiddenFile("/config/variable-groups.json")).toBe("a variable group");
    expect(forbiddenFile("/notebooks/pipelines_overview.py")).toBeUndefined();
  });
});

describe("change with agent: the workspace", () => {
  it("starts a change with the files it names, the base commit and a branch; nothing is pushed", async () => {
    const w = world();
    const s = await changeStart(w.b(), { project: "test-project", repo: "repo-a", story: 4711, paths: ["/src/a.py", "/nope.py"], prompt: "Filter actieve klanten" });
    expect(s).toMatchObject({ project: "test-project", repo: "repo-a", base: { branch: "main", commit: C1 }, branch: "feature/4711-filter-actieve-klanten", story: 4711, materialized: ["/src/a.py"] });
    expect(readFileSync(join(s.filesDir, "src", "a.py"), "utf8")).toBe(BASE_A);
    const task = readFileSync(s.taskFile, "utf8");
    expect(task).toContain("Filter actieve klanten");
    expect(task).toContain(`aihub browse change read --id ${s.id}`);
    expect(task).toContain("Do not push, commit, merge or run git");
    expect(s.agentPrompt).toContain(s.taskFile);
    expect(w.pushes).toEqual([]);
    const sel = await changeStart(w.b(), { project: "test-project", repo: "repo-a", prompt: "x", selection: { path: "/src/a.py", startLine: 2, endLine: 3 } });
    expect(sel.materialized).toEqual(["/src/a.py"]);
    expect(readFileSync(sel.taskFile, "utf8")).toContain("lines 2-3:\n\n```\nline 2\nline 3\n```");
    await expect(changeStart(w.b(), { project: "test-project", repo: "repo-a", branch: "staging" })).rejects.toMatchObject({ kind: "protectedBranch" });
    expect(changeList(w.ctx.env).changes.map((c) => c.id).sort()).toEqual([s.id, sel.id].sort());
  });

  it("sees what the agent changed with its own tools, a new file and a removed one, with hunks and the summary", async () => {
    const w = world();
    const s = await changeStart(w.b(), { project: "test-project", repo: "repo-a", paths: ["/src/a.py"], prompt: "x" });
    writeFileSync(join(s.filesDir, "src", "a.py"), BASE_A.replace("line 2", "LINE 2"));
    await changeWrite(w.b(), s.id, "/tests/test_new.py", { content: "def test_x():\n    assert True\n" });
    const read = await changeRead(w.b(), s.id, "/src/b.py");
    expect(read).toMatchObject({ content: BASE_B, modified: false });
    await changeWrite(w.b(), s.id, "/src/b.py", { delete: true });
    changeSummary(w.ctx.env, s.id, "Line 2 in capitals.\n");
    const d = await changeDiff(w.b(), s.id);
    expect(d.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["/src/a.py", "modified", 1, 1],
      ["/src/b.py", "deleted", 0, 1],
      ["/tests/test_new.py", "added", 2, 0],
    ]);
    expect(d.files[0].hunks[0].lines.filter((l) => l.kind !== "ctx").map((l) => `${l.kind}:${l.text}`)).toEqual(["del:line 2", "add:LINE 2"]);
    expect(d.summary).toBe("Line 2 in capitals.");
    expect(d.problems).toEqual([]);
  });

  it("refuses secrets and forbidden files when written, names them in the diff when the agent wrote them itself, and stops at 20 files", async () => {
    const w = world();
    const s = await changeStart(w.b(), { project: "test-project", repo: "repo-a", prompt: "x" });
    await expect(changeWrite(w.b(), s.id, "/src/c.py", { content: 'api_key = "abcdefgh12345678"\n' })).rejects.toMatchObject({ kind: "secret" });
    await expect(changeWrite(w.b(), s.id, "/azure-pipelines.yml", { content: "trigger: none\n" })).rejects.toMatchObject({ kind: "forbiddenFile" });
    mkdirSync(join(s.filesDir, "gen"), { recursive: true });
    for (let i = 0; i < 21; i++) writeFileSync(join(s.filesDir, "gen", `f${i}.py`), `x = ${i}\n`);
    writeFileSync(join(s.filesDir, ".env"), "A=1\n");
    const d = await changeDiff(w.b(), s.id);
    expect(d.problems.map((p) => p.kind)).toEqual(["tooManyFiles", "forbiddenFile"]);
    await expect(changePush(w.b(), s.id, {})).rejects.toMatchObject({ kind: "tooManyFiles" });
    expect(w.pushes).toEqual([]);
  });
});

describe("change with agent: push", () => {
  it("pushes one commit on a new branch from the base commit (edit, add, delete) and opens the pull request", async () => {
    const w = world();
    const s = await changeStart(w.b(), { project: "test-project", repo: "repo-a", story: 4711, paths: ["/src/a.py"], prompt: "Filter actieve klanten" });
    writeFileSync(join(s.filesDir, "src", "a.py"), BASE_A.replace("line 2", "LINE 2"));
    await changeWrite(w.b(), s.id, "/tests/test_new.py", { content: "x = 1\n" });
    await changeRead(w.b(), s.id, "/src/b.py");
    await changeWrite(w.b(), s.id, "/src/b.py", { delete: true });
    const r = await changePush(w.b(), s.id, { pr: true });
    expect(r).toMatchObject({ status: "pushed", branch: "feature/4711-filter-actieve-klanten", startedFrom: C1, rebased: false, pr: { id: 77, title: "4711 Orderexport" } });
    expect(w.pushes).toHaveLength(1);
    expect(w.pushes[0].refUpdates).toEqual([{ name: "refs/heads/feature/4711-filter-actieve-klanten", oldObjectId: "0".repeat(40) }]);
    expect(w.pushes[0].commits[0].parents).toEqual([C1]);
    expect(w.pushes[0].commits[0].comment).toBe("#4711 Filter actieve klanten");
    expect(w.pushes[0].commits[0].changes).toEqual([
      { changeType: "edit", item: { path: "/src/a.py" }, newContent: { content: BASE_A.replace("line 2", "LINE 2"), contentType: "rawtext" } },
      { changeType: "delete", item: { path: "/src/b.py" } },
      { changeType: "add", item: { path: "/tests/test_new.py" }, newContent: { content: "x = 1\n", contentType: "rawtext" } },
    ]);
    expect(w.prs[0]).toMatchObject({ sourceRefName: "refs/heads/feature/4711-filter-actieve-klanten", targetRefName: "refs/heads/main", workItemRefs: [{ id: "4711" }] });
    expect(readMeta(w.ctx.env, s.id).meta.status).toBe("pushed");
    await expect(changePush(w.b(), s.id, {})).rejects.toMatchObject({ kind: "badInput" });
  });

  it("refuses a branch that exists, and gives a conflict when the file changed on main (rebase when the lines do not overlap)", async () => {
    const exists = world({ branchExists: true });
    const s0 = await changeStart(exists.b(), { project: "test-project", repo: "repo-a", paths: ["/src/a.py"], prompt: "x" });
    writeFileSync(join(s0.filesDir, "src", "a.py"), BASE_A.replace("line 1", "LINE 1"));
    await expect(changePush(exists.b(), s0.id, {})).rejects.toMatchObject({ kind: "branchExists" });

    const first = world();
    const config = first.ctx.env.AIHUB_CONFIG_HOME;
    const overlap = world({ head: C2, headA: BASE_A.replace("line 1", "line one"), config });
    const s1 = await changeStart(first.b(), { project: "test-project", repo: "repo-a", paths: ["/src/a.py"], prompt: "x" });
    writeFileSync(join(s1.filesDir, "src", "a.py"), BASE_A.replace("line 1", "LINE 1"));
    const c = await changePush(overlap.b(), s1.id, {});
    expect(c).toMatchObject({ status: "conflict", files: [{ path: "/src/a.py", overlap: true, latest: { id: C2, message: "Their change" } }] });
    expect(overlap.pushes).toEqual([]);

    const apart = world({ head: C2, headA: BASE_A.replace("line 5", "line five"), config });
    const r = await changePush(apart.b(), s1.id, { rebase: true });
    expect(r).toMatchObject({ status: "pushed", startedFrom: C2, rebased: true });
    expect(apart.pushes[0].commits[0].changes[0].newContent.content).toBe("LINE 1\nline 2\nline 3\nline 4\nline five\n");
  });
});

describe("change with agent: working copy, discard, the command", () => {
  it("applies the change to a working copy, skipping a file with local work there", async () => {
    const w = world();
    const s = await changeStart(w.b(), { project: "test-project", repo: "repo-a", paths: ["/src/a.py", "/src/b.py"], prompt: "x" });
    writeFileSync(join(s.filesDir, "src", "a.py"), BASE_A.replace("line 2", "LINE 2"));
    writeFileSync(join(s.filesDir, "src", "b.py"), "changed\n");
    const wc = tmp();
    mkdirSync(join(wc, "src"), { recursive: true });
    writeFileSync(join(wc, "src", "a.py"), BASE_A);
    writeFileSync(join(wc, "src", "b.py"), "my own work\n");
    const r = await changeApply(w.b(), s.id, wc);
    expect(r.applied).toEqual(["/src/a.py"]);
    expect(r.skipped).toEqual([{ path: "/src/b.py", why: "the working copy has its own change in this file" }]);
    expect(readFileSync(join(wc, "src", "a.py"), "utf8")).toContain("LINE 2");
    expect(readFileSync(join(wc, "src", "b.py"), "utf8")).toBe("my own work\n");
    expect(changeDiscard(w.ctx.env, s.id)).toEqual({ id: s.id, discarded: true });
    expect(existsSync(s.dir)).toBe(false);
  });

  it("runs as aihub browse change ... with JSON, and the org of a change comes from the change", async () => {
    const w = world();
    const code = await main(["browse", "change", "start", "--project", "test-project", "--repo", "repo-a", "--paths", "/src/a.py"], w.ctx);
    expect(w.errs.join("\n")).toBe("");
    expect(code).toBe(0);
    const s = JSON.parse(w.lines[0]);
    delete w.ctx.env.AIHUB_ADO_ORG;
    expect(await main(["browse", "change", "diff", "--id", s.id], w.ctx)).toBe(0);
    expect(JSON.parse(w.lines[1])).toMatchObject({ id: s.id, files: [], totals: { files: 0 } });
    expect(JSON.parse(w.lines[1]).contents).toBeUndefined();
    expect(await main(["browse", "change", "read", "--id", "nope"], w.ctx)).toBe(1);
  });
});

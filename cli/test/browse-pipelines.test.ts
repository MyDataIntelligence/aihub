import { rmSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { browseOf } from "../src/lib/browse/core.js";
import {
  artifactDir,
  browseArtifactFiles,
  browseArtifactOpen,
  browseArtifacts,
  browseDraftCreate,
  browseDraftDelete,
  browseDrafts,
  browsePipeline,
  browsePipelines,
  browseRun,
  browseRunPlan,
  draftName,
  emptyDraftYaml,
  foldersOf,
  isDraftDef,
  kindOfFile,
  runnableOn,
} from "../src/lib/browse/pipelines.js";
import { zipEntries, zipRead } from "../src/lib/browse/zip.js";
import { ctxFor, fakeFetch, tmp, write, type Route } from "./helpers.js";

const NOW = Date.parse("2026-11-27T10:00:00Z");
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const ME = { id: "me-id", providerDisplayName: "Test User", properties: { Account: { $value: "test.user@example.test" } } };
const P = "https://dev.azure.com/ferron-test/test-project/_apis/";

const build = (id: number, extra: object = {}) => ({
  id,
  buildNumber: `20261127.${id}`,
  status: "completed",
  result: "succeeded",
  queueTime: "2026-11-27T09:00:00Z",
  startTime: "2026-11-27T09:00:05Z",
  finishTime: "2026-11-27T09:05:05Z",
  sourceBranch: "refs/heads/main",
  sourceVersion: C1,
  requestedFor: { id: "me-id", displayName: "Test User" },
  ...extra,
});

const def = (id: number, name: string, path: string, extra: object = {}) => ({
  id,
  name,
  path,
  repository: { id: "r1", name: "repo-a", type: "TfsGit", defaultBranch: "refs/heads/main" },
  process: { type: 2, yamlFilename: `pipelines/${name}.yml` },
  authoredBy: { id: "me-id", displayName: "Test User" },
  queue: { id: 9, name: "Azure Pipelines" },
  ...extra,
});

const YAML = `
parameters:
  - name: greeting
    type: string
    default: hello
    values: [hello, hoi]
  - name: failTests
    type: boolean
    default: false
stages:
  - stage: Draft
  - stage: Check
    dependsOn: Draft
`;

/** A zip like Azure DevOps hands out: the artifact's folder, a deflated and a stored file. */
function zipOf(files: Record<string, string>, method: 0 | 8 = 8): Buffer {
  const locals: Buffer[] = [];
  const cens: Buffer[] = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(data.length, 18);
    loc.writeUInt32LE(raw.length, 22);
    loc.writeUInt16LE(n.length, 26);
    locals.push(loc, n, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(n.length, 28);
    cen.writeUInt32LE(off, 42);
    cens.push(cen, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(cens);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

function setup(routes: Route[]) {
  const f = fakeFetch([...routes, { match: /\/_apis\/connectionData/, respond: () => ({ body: { authenticatedUser: ME } }) }]);
  const { ctx, lines, errs } = ctxFor(tmp(), f.fn);
  ctx.env.AIHUB_ADO_ORG = "ferron-test";
  ctx.now = () => NOW;
  return { ctx, lines, errs, calls: f.calls, b: (refresh = false) => browseOf(ctx, { refresh }) };
}

describe("pipeline browser: pure parts", () => {
  it("folders with their parents and counts; drafts are draft-* in \\Drafts", () => {
    expect(foldersOf([{ folder: "\\orders\\ci" }, { folder: "\\orders\\ci" }, { folder: "\\Drafts" }, { folder: "\\" }])).toEqual([
      { path: "\\", name: "", parent: null, pipelines: 4 },
      { path: "\\Drafts", name: "Drafts", parent: "\\", pipelines: 1 },
      { path: "\\orders", name: "orders", parent: "\\", pipelines: 2 },
      { path: "\\orders\\ci", name: "ci", parent: "\\orders", pipelines: 2 },
    ]);
    expect(isDraftDef({ name: "draft-x", path: "\\Drafts" })).toBe(true);
    expect(isDraftDef({ name: "draft-x", path: "\\ci" })).toBe(false);
    expect(isDraftDef({ name: "orders-ci", path: "\\Drafts" })).toBe(false);
  });

  it("draft names get the prefix once and only simple characters", () => {
    expect(draftName("orders-ci-py312")).toBe("draft-orders-ci-py312");
    expect(draftName("draft-Orders")).toBe("draft-orders");
    expect(() => draftName("a b")).toThrow(/not a draft name/);
    expect(emptyDraftYaml("draft-x")).toContain('script: echo "Hello from draft-x"');
  });

  it("zip: lists and reads stored and deflated files", () => {
    for (const m of [0, 8] as const) {
      const z = zipOf({ "robot-report/report.html": "<h1>hi</h1>", "robot-report/log.txt": "line 1\n" }, m);
      const e = zipEntries(z);
      expect(e.map((x) => [x.path, x.bytes])).toEqual([
        ["robot-report/report.html", 11],
        ["robot-report/log.txt", 7],
      ]);
      expect(zipRead(z, e[1]).toString()).toBe("line 1\n");
    }
    expect(() => zipEntries(Buffer.from("nope"))).toThrow(/not a zip/);
  });

  it("file kinds", () => {
    expect(kindOfFile("report.html", Buffer.from("x"))).toBe("html");
    expect(kindOfFile("robot-debug.log", Buffer.from("x"))).toBe("log");
    expect(kindOfFile("output.xml", Buffer.from("x"))).toBe("text");
    expect(kindOfFile("shot.png", Buffer.from([137, 80, 0, 1]))).toBe("binary");
  });
});

describe("pipeline browser: reads", () => {
  it("pipelines of a project in one call, kept, with the latest run (a PR run by number)", async () => {
    const s = setup([
      {
        match: /test-project\/_apis\/build\/definitions\?/,
        respond: () => ({
          body: {
            value: [
              def(1, "orders-ci", "\\orders\\ci", { latestBuild: build(2049, { status: "inProgress", result: undefined, finishTime: undefined }) }),
              def(2, "orders-pr-check", "\\orders\\ci", { latestBuild: build(2050, { sourceBranch: "refs/pull/812/merge" }) }),
              def(3, "draft-lint", "\\Drafts", { authoredBy: { id: "other" } }),
              def(4, "classic", "\\", { process: { type: 1 } }),
            ],
          },
        }),
      },
    ]);
    const r = await browsePipelines(s.b(), "test-project");
    expect(r.cached).toBe(false);
    expect(r.pipelines.map((p) => [p.id, p.folder, p.yamlPath, p.isDraft, p.mine, p.latestRun?.state ?? null, p.latestRun?.pr ?? null])).toEqual([
      [1, "\\orders\\ci", "pipelines/orders-ci.yml", false, true, "running", null],
      [2, "\\orders\\ci", "pipelines/orders-pr-check.yml", false, true, "succeeded", 812],
      [3, "\\Drafts", "pipelines/draft-lint.yml", true, false, null, null],
      [4, "\\", null, false, true, null, null],
    ]);
    expect(r.pipelines[0]).toMatchObject({ repo: "repo-a", defaultBranch: "main", webUrl: "https://dev.azure.com/ferron-test/test-project/_build?definitionId=1" });
    expect(r.folders.find((f) => f.path === "\\orders")?.pipelines).toBe(2);
    const again = await browsePipelines(s.b(), "test-project");
    expect(again.cached).toBe(true);
    expect(s.calls.filter((c) => /build\/definitions\?/.test(c.url))).toHaveLength(1);
    await browsePipelines(s.b(true), "test-project");
    expect(s.calls.filter((c) => /build\/definitions\?/.test(c.url))).toHaveLength(2);
  });

  it("one pipeline: the latest runs with commit messages (one batch call), PR number, who, duration, the YAML to open", async () => {
    const s = setup([
      { match: /build\/definitions\/1\?/, respond: () => ({ body: def(1, "orders-ci", "\\orders\\ci") }) },
      { match: /build\/builds\?/, respond: () => ({ body: { value: [build(2049, { sourceVersion: C2, triggerInfo: { "pr.number": "812", "pr.sourceBranch": "refs/heads/feature/4711-x" }, sourceBranch: "refs/pull/812/merge" }), build(2048, { requestedFor: { id: "x", displayName: "Other Person" } })] } }) },
      { method: "POST", match: /git\/repositories\/r1\/commitsbatch/, respond: () => ({ body: { value: [{ commitId: C1, comment: "Rename customer_nr\n\nbody" }, { commitId: C2, comment: "Guard empty customer number" }] } }) },
    ]);
    const r = await browsePipeline(s.b(), "test-project", 1, 3);
    expect(r.runs.map((x) => [x.id, x.branch, x.pr, x.message, x.requestedFor.isMe, x.durationSeconds])).toEqual([
      [2049, "feature/4711-x", 812, "Guard empty customer number", true, 300],
      [2048, "main", null, "Rename customer_nr", false, 300],
    ]);
    expect(r.pipeline.yaml).toEqual({ project: "test-project", repo: "repo-a", path: "/pipelines/orders-ci.yml", defaultBranch: "main" });
    expect(s.calls.find((c) => /build\/builds\?/.test(c.url))!.url).toContain("%24top=3");
  });
});

describe("pipeline browser: run form and run", () => {
  const routes = (): Route[] => [
    { match: /build\/definitions\/21\?/, respond: () => ({ body: def(21, "draft-x", "\\Drafts", { repository: { id: "r1", name: "repo-a", defaultBranch: "refs/heads/feature/draft-x" }, variables: { debugLogging: { value: "false", allowOverride: true } } }) }) },
    { match: /git\/repositories\/r1\/items\?/, respond: () => ({ body: { content: YAML, commitId: C2 } }) },
    { match: /git\/repositories\/r1\/commits\/2/, respond: () => ({ body: { comment: "ci: draft\n" } }) },
  ];

  it("the form comes from the YAML on the pipeline's default branch (or the ref given)", async () => {
    const s = setup(routes());
    const plan = await browseRunPlan(s.b(), "test-project", 21);
    expect(plan.ref).toEqual({ name: "feature/draft-x", kind: "branch", commit: C2, message: "ci: draft" });
    expect(plan.parameters.map((p) => [p.name, p.type, p.value])).toEqual([
      ["greeting", "string", "hello"],
      ["failTests", "boolean", "false"],
    ]);
    expect(plan.stages.map((x) => [x.identifier, x.canSkip])).toEqual([
      ["Draft", false],
      ["Check", true],
    ]);
    await browseRunPlan(s.b(), "test-project", 21, "tag:v1");
    expect(s.calls.filter((c) => /items\?/.test(c.url))[1].url).toContain("versionDescriptor.versionType=tag");
  });

  it("a run sends only what changed, on the branch, with the skipped stage; a wrong value queues nothing", async () => {
    const s = setup([...routes(), { method: "POST", match: /pipelines\/21\/runs\?/, respond: () => ({ body: { id: 339, name: "20261127.1" } }) }]);
    const dir = tmp();
    write(dir, "c.json", JSON.stringify({ parameters: { greeting: "hoi" }, variables: { debugLogging: "true" }, skipStages: ["Check"] }));
    const r = await browseRun(s.b(), "test-project", 21, { branch: "feature/draft-x-v2", changesFile: join(dir, "c.json") });
    expect(r).toMatchObject({ id: 339, branch: "feature/draft-x-v2", skipped: ["Check"], changed: { parameters: ["greeting"], variables: ["debugLogging"] }, webUrl: "https://dev.azure.com/ferron-test/test-project/_build/results?buildId=339" });
    expect(s.calls.find((c) => c.method === "POST")!.body).toEqual({
      resources: { repositories: { self: { refName: "refs/heads/feature/draft-x-v2" } } },
      templateParameters: { greeting: "hoi" },
      variables: { debugLogging: { value: "true" } },
      stagesToSkip: ["Check"],
    });
    write(dir, "bad.json", JSON.stringify({ parameters: { greeting: "hey" } }));
    await expect(browseRun(s.b(), "test-project", 21, { branch: "b", changesFile: join(dir, "bad.json") })).rejects.toMatchObject({ kind: "badInput" });
    expect(s.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("after a push: runnable when the pipeline reads that file from that repository", async () => {
    const s = setup(routes());
    expect(await runnableOn(s.b(), "test-project", 21, "repo-a", "/pipelines/draft-x.yml")).toEqual({ id: 21, name: "draft-x", runnable: true, reason: null });
    expect((await runnableOn(s.b(), "test-project", 21, "repo-b", "/pipelines/draft-x.yml")).runnable).toBe(false);
    expect((await runnableOn(s.b(), "test-project", 21, "repo-a", "/other.yml")).reason).toMatch(/not this file/);
  });
});

describe("pipeline browser: artifacts", () => {
  it("list, files on demand, open one file into a temporary folder; the zip is downloaded once", async () => {
    const zip = zipOf({ "robot-report/report.html": "<h1>report hoi</h1>", "robot-report/sub/robot-debug.log": "line 1\n", "robot-report/shot.png": "\u0089PNG\u0000x" });
    const s = setup([
      { match: /build\/builds\/339\/artifacts/, respond: () => ({ body: { value: [{ name: "robot-report", resource: { type: "PipelineArtifact", downloadUrl: "https://dev.azure.com/ferron-test/_apis/artifact/x?format=file", properties: { artifactsize: "120" } } }, { name: "huge", resource: { type: "Container", properties: { artifactsize: String(500 * 1024 * 1024) } } }] } }) },
      { match: /_apis\/artifact\/x/, respond: () => ({ bytes: zip }) },
    ]);
    rmSync(artifactDir(s.b(), "test-project", 339, "robot-report"), { recursive: true, force: true });
    expect((await browseArtifacts(s.b(), "test-project", 339)).artifacts).toEqual([
      { name: "robot-report", type: "PipelineArtifact", bytes: 120, files: null },
      { name: "huge", type: "Container", bytes: 500 * 1024 * 1024, files: null },
    ]);
    expect((await browseArtifactFiles(s.b(), "test-project", 339, "robot-report")).files).toEqual([
      { path: "report.html", bytes: 19 },
      { path: "sub/robot-debug.log", bytes: 7 },
      { path: "shot.png", bytes: 7 },
    ]);
    const html = await browseArtifactOpen(s.b(), "test-project", 339, "robot-report", "report.html");
    expect(html).toMatchObject({ kind: "html", content: "<h1>report hoi</h1>", bytes: 19 });
    expect((await browseArtifactOpen(s.b(), "test-project", 339, "robot-report", "sub/robot-debug.log")).kind).toBe("log");
    expect(await browseArtifactOpen(s.b(), "test-project", 339, "robot-report", "shot.png")).toMatchObject({ kind: "binary", content: null });
    expect((await browseArtifactOpen(s.b(), "test-project", 339, "robot-report")).kind).toBe("zip");
    expect(s.calls.filter((c) => /_apis\/artifact\/x/.test(c.url))).toHaveLength(1);
    expect(s.calls.find((c) => /_apis\/artifact\/x/.test(c.url))!.url).toContain("format=zip");
    expect(await browseArtifactFiles(s.b(), "test-project", 339, "huge")).toMatchObject({ files: null, tooLarge: true });
    await expect(browseArtifactOpen(s.b(), "test-project", 339, "robot-report", "nope.txt")).rejects.toMatchObject({ kind: "notFound" });
  });
});

describe("pipeline browser: drafts", () => {
  const repoRoutes = (branchExists = false): Route[] => [
    { match: /git\/repositories\/repo-a\?/, respond: () => ({ body: { id: "r1", name: "repo-a", defaultBranch: "refs/heads/main" } }) },
    { match: /git\/repositories\/repo-a\/refs\?.*filter=heads%2Fmain/, respond: () => ({ body: { value: [{ name: "refs/heads/main", objectId: C1 }] } }) },
    { match: /git\/repositories\/repo-a\/refs\?/, respond: () => ({ body: { value: branchExists ? [{ name: "refs/heads/feature/draft-x", objectId: C2 }] : [] } }) },
    { match: /build\/definitions\?.*name=draft-x/, respond: () => ({ body: { value: [] } }) },
    { match: /distributedtask\/queues\?/, respond: () => ({ body: { value: [{ id: 9 }] } }) },
    { method: "POST", match: /git\/repositories\/repo-a\/pushes\?/, respond: () => ({ body: { commits: [{ commitId: C2 }] } }) },
  ];

  it("create: the YAML on a new branch from the default branch, then the pipeline in \\Drafts pointing at it", async () => {
    const s = setup([...repoRoutes(), { method: "POST", match: /build\/definitions\?/, respond: (c) => ({ body: { id: 21, name: c.body.name } }) }]);
    const r = await browseDraftCreate(s.b(), { project: "test-project", repo: "repo-a", name: "x", branch: "feature/draft-x", empty: true });
    expect(r).toEqual({ pipeline: { id: 21, name: "draft-x", folder: "\\Drafts" }, repo: "repo-a", branch: "feature/draft-x", startedFrom: "main", yamlPath: "pipelines/draft-x.yml", commit: C2, webUrl: "https://dev.azure.com/ferron-test/test-project/_build?definitionId=21" });
    const push = s.calls.find((c) => /pushes/.test(c.url))!.body;
    expect(push.refUpdates).toEqual([{ name: "refs/heads/feature/draft-x", oldObjectId: "0".repeat(40) }]);
    expect(push.commits[0].parents).toEqual([C1]);
    expect(push.commits[0].changes[0]).toMatchObject({ changeType: "add", item: { path: "/pipelines/draft-x.yml" } });
    const d = s.calls.find((c) => c.method === "POST" && /build\/definitions/.test(c.url))!.body;
    expect(d).toMatchObject({ name: "draft-x", path: "\\Drafts", process: { type: 2, yamlFilename: "pipelines/draft-x.yml" }, repository: { id: "r1", defaultBranch: "refs/heads/feature/draft-x" }, queue: { id: 9 } });
  });

  it("create refuses main, an existing branch, and takes the branch back when the pipeline cannot be made", async () => {
    const s = setup(repoRoutes(true));
    await expect(browseDraftCreate(s.b(), { project: "test-project", repo: "repo-a", name: "x", branch: "main", empty: true })).rejects.toMatchObject({ kind: "protectedBranch" });
    await expect(browseDraftCreate(s.b(), { project: "test-project", repo: "repo-a", name: "x", branch: "feature/draft-x", empty: true })).rejects.toMatchObject({ kind: "branchExists" });
    const f = setup([...repoRoutes(), { method: "POST", match: /build\/definitions\?/, respond: () => ({ status: 400, body: { message: "queue not found" } }) }, { method: "POST", match: /git\/repositories\/repo-a\/refs\?/, respond: () => ({ body: { value: [] } }) }]);
    await expect(browseDraftCreate(f.b(), { project: "test-project", repo: "repo-a", name: "x", branch: "feature/draft-x", empty: true })).rejects.toThrow(/queue not found/);
    expect(f.calls.find((c) => /repo-a\/refs\?/.test(c.url) && c.method === "POST")!.body).toEqual([{ name: "refs/heads/feature/draft-x", oldObjectId: C2, newObjectId: "0".repeat(40) }]);
  });

  const draftDef = (extra: object = {}) => def(21, "draft-x", "\\Drafts", { repository: { id: "r1", name: "repo-a", defaultBranch: "refs/heads/feature/draft-x" }, ...extra });
  const delRoutes = (d: object): Route[] => [
    { match: /build\/definitions\/21\?/, respond: () => ({ body: d }) },
    { match: /build\/builds\?/, respond: () => ({ body: { value: [build(1), build(2)] } }) },
    { method: "DELETE", match: /build\/definitions\/21\?/, respond: () => ({ body: {} }) },
    // run 1 holds the pipeline's own lease (it goes with the run); run 2 is kept by a release
    { match: /build\/builds\/1\/leases/, respond: () => ({ body: { value: [{ leaseId: 121, ownerId: "Branch:r1:refs/heads/feature/draft-x", definitionId: 21 }, { leaseId: 122, ownerId: "Pipeline:21", definitionId: 21 }] } }) },
    { match: /build\/builds\/2\/leases/, respond: () => ({ body: { value: [{ leaseId: 123, ownerId: "RM:7" }] } }) },
    { method: "DELETE", match: /build\/retention\/leases\?/, respond: () => ({ body: {} }) },
    { method: "DELETE", match: /build\/builds\/1\?/, respond: () => ({ body: {} }) },
    { match: /git\/repositories\/r1\?/, respond: () => ({ body: { defaultBranch: "refs/heads/main" } }) },
    { match: /git\/repositories\/r1\/refs\?/, respond: () => ({ body: { value: [{ name: "refs/heads/feature/draft-x", objectId: C2 }] } }) },
    { method: "POST", match: /git\/repositories\/r1\/refs\?/, respond: () => ({ body: { value: [] } }) },
  ];

  it("delete: only my draft-* in \\Drafts; the pipeline and its draft branch go", async () => {
    const s = setup(delRoutes(draftDef()));
    expect(await browseDraftDelete(s.b(), "test-project", 21)).toEqual({ deleted: { pipeline: { id: 21, name: "draft-x" }, runs: 1, branch: "feature/draft-x", repo: "repo-a" }, runsKept: 1, branchKept: null });
    expect(s.calls.find((c) => c.method === "DELETE" && /retention\/leases/.test(c.url))!.url).toContain("ids=121%2C122");
    expect(s.calls.some((c) => c.method === "DELETE" && /build\/builds\/2\?/.test(c.url))).toBe(false);
    expect(s.calls.find((c) => c.method === "POST" && /refs/.test(c.url))!.body).toEqual([{ name: "refs/heads/feature/draft-x", oldObjectId: C2, newObjectId: "0".repeat(40) }]);
    const other = setup(delRoutes(draftDef({ authoredBy: { id: "someone", displayName: "Other Person" } })));
    await expect(browseDraftDelete(other.b(), "test-project", 21)).rejects.toMatchObject({ kind: "noAccess" });
    const notDraft = setup(delRoutes(def(21, "orders-ci", "\\ci")));
    await expect(browseDraftDelete(notDraft.b(), "test-project", 21)).rejects.toMatchObject({ kind: "badInput" });
    for (const x of [other, notDraft]) expect(x.calls.some((c) => c.method === "DELETE" || c.method === "POST")).toBe(false);
  });

  it("delete keeps a branch whose name does not say it was made for the draft", async () => {
    const s = setup(delRoutes(draftDef({ repository: { id: "r1", name: "repo-a", defaultBranch: "refs/heads/feature/4711-work" } })));
    const r = await browseDraftDelete(s.b(), "test-project", 21);
    expect(r.deleted.branch).toBeNull();
    expect(r.branchKept).toMatch(/is kept/);
    expect(s.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("drafts: my draft-* pipelines with runs and how far their branch is ahead", async () => {
    const s = setup([
      { match: /build\/definitions\?/, respond: () => ({ body: { value: [draftDef(), def(5, "orders-ci", "\\Drafts")] } }) },
      { match: /build\/builds\?/, respond: () => ({ body: { value: [build(1)] } }) },
      { match: /stats\/branches\?/, respond: () => ({ body: { aheadCount: 2 } }) },
    ]);
    const r = await browseDrafts(s.b(), "test-project");
    expect(r.drafts.map((d) => [d.id, d.branch, d.runs, d.branchAhead, d.mine])).toEqual([[21, "feature/draft-x", 1, 2, true]]);
  });

  it("the command line: errors are JSON with a kind", async () => {
    const s = setup([]);
    expect(await main(["browse", "draft-create", "--project", "test-project", "--repo", "repo-a", "--name", "x", "--branch", "staging", "--empty"], s.ctx)).toBe(1);
    expect(JSON.parse(s.lines[0])).toMatchObject({ error: { kind: "protectedBranch" } });
  });
});

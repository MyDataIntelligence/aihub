import { describe, expect, it } from "vitest";
import { chainNames } from "../src/commands/fabric-since-green.js";
import { deployEnvs, groupChanges, matchEnv, rank } from "../src/lib/sinceGreen.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, write, type Route } from "./helpers.js";

const TWS = "44444444-4444-4444-4444-444444444444";
const TEAM = `version: 1
repositories:
  - name: test-repo
    defaultTarget: main
fabric:
  environments:
    TST:
      branch: staging
      workspace: "Fabric {repo} test"
      deployedBy:
        pipeline: cd_pipeline
        stage: DeployTestEnvironment
    ACC:
      branch: release
      workspace: "Fabric {repo} acc"
`;
const ENV = { AIHUB_FABRIC_TOKEN: "ft", AIHUB_POLL_MS: "0" };
const WS_NAME = "Fabric test-repo test";

function repo(files: Record<string, string> = {}): string {
  const { dir } = makeRepo();
  write(dir, ".agents/skills/_shared/references/team.yaml", TEAM);
  for (const [f, c] of Object.entries(files)) write(dir, f, c);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "team"]);
  return dir;
}
async function go(routes: Route[], args: string[], dir = repo()) {
  const f = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(dir, f.fn);
  ctx.env = { ...ctx.env, ...ENV };
  const code = await main(["fabric", ...args], ctx);
  return { code, out: lines.join("\n"), errs, calls: f.calls };
}
const get = (re: RegExp, body: unknown): Route => ({ match: re, respond: () => ({ body }) });
const post = (re: RegExp, body: unknown): Route => ({ method: "POST", match: re, respond: () => ({ body }) });

// ---- Azure DevOps fakes -----------------------------------------------------------------------------------------------

const sha = (c: string) => c.padEnd(40, "0");
const C1 = sha("4e1a9b0");
const C2 = sha("9c2f771");
const C3 = sha("b7d3e05");
const C4 = sha("d00d123");
const stage = (result: string, finishTime?: string) => ({ records: [{ type: "Stage", name: "DeployTestEnvironment", identifier: "DeployTestEnvironment", result, finishTime }, { type: "Stage", name: "Build", result: "succeeded", finishTime }] });
interface B {
  id: number;
  queued: string;
  commit: string;
  result: string;
  finish?: string;
}
function cd(builds: B[], o: { repos?: Record<number, unknown> } = {}): Route[] {
  return [
    get(/_apis\/build\/definitions\?/, { value: [{ id: 7, name: "cd_pipeline" }] }),
    get(/_apis\/build\/builds\?/, { value: builds.map((b) => ({ id: b.id, buildNumber: `2026.${b.id}`, sourceVersion: b.commit, sourceBranch: "refs/heads/staging", queueTime: b.queued, reason: "individualCI", requestedFor: { displayName: "Dev One" } })) }),
    ...builds.map((b) => get(new RegExp(`_apis/build/builds/${b.id}/timeline`), stage(b.result, b.finish))),
    ...builds.map((b) => get(new RegExp(`_apis/pipelines/7/runs/${b.id}\\?`), o.repos?.[b.id] ?? {})),
  ];
}
const repos = (self: string, central: string) => ({ resources: { repositories: { self: { version: self }, central: { version: central } } } });
function git(commits: { sha: string; title: string; paths: string[]; pr?: number }[]): Route[] {
  const prs = [...new Set(commits.flatMap((c) => (c.pr ? [c.pr] : [])))];
  return [
    get(/_apis\/git\/repositories\/test-repo\/commits\?/, { value: commits.map((c) => ({ commitId: c.sha, comment: c.title })) }),
    ...commits.map((c) => get(new RegExp(`commits/${c.sha}/changes`), { changes: c.paths.map((p) => ({ item: { path: `/${p}` } })) })),
    ...commits.map((c) => get(new RegExp(`commits/${c.sha}\\?`), { comment: `${c.title}\n\nbody` })),
    post(/pullrequestquery/, { results: [Object.fromEntries(commits.filter((c) => c.pr).map((c) => [c.sha, [{ pullRequestId: c.pr }]]))] }),
    ...prs.map((id) => get(new RegExp(`pullrequests/${id}\\?`), { pullRequestId: id, title: `PR title ${id}` })),
    ...prs.map((id) => get(new RegExp(`pullrequests/${id}/workitems`), { value: [{ id: id * 10 }] })),
    get(/_apis\/wit\/workitems\/\d+\?/, { fields: { "System.Title": "Rename column" } }),
  ];
}

// ---- Fabric fakes -----------------------------------------------------------------------------------------------------

const RED = { id: "red-1", status: "Failed", startTimeUtc: "2026-03-04T02:00:00Z", endTimeUtc: "2026-03-04T02:05:00Z", failureReason: { message: "Activity RunStd failed" } };
const GREEN_RUN = { id: "green-1", status: "Completed", startTimeUtc: "2026-03-03T02:00:00Z", endTimeUtc: "2026-03-03T02:10:00Z" };
const OLD_GREEN = { id: "green-0", status: "Completed", startTimeUtc: "2026-03-02T02:00:00Z", endTimeUtc: "2026-03-02T02:10:00Z" };
function fabric(jobs: unknown[], activities: unknown[] = [{ activityName: "nb_standardize", activityType: "TridentNotebook", status: "Failed", error: { errorCode: "NotebookFailed", message: "KeyError: subscription_date" } }]): Route[] {
  return [
    get(/\/v1\/workspaces$/, { value: [{ id: TWS, displayName: WS_NAME }] }),
    get(new RegExp(`/workspaces/${TWS}/items$`), { value: [{ id: "pl-1", displayName: "pl_main", type: "DataPipeline" }, { id: "nb-1", displayName: "nb_other", type: "Notebook" }] }),
    get(/items\/pl-1\/jobs\/instances$/, { value: jobs }),
    get(/items\/nb-1\/jobs\/instances$/, { value: [] }),
    post(/pipelineruns\/red-1\/queryactivityruns$/, activities),
  ];
}

// newest first: 105 queued after the red run, 104 and 102 deployed in the window, 103 failed its stage, 101 was live during green
const WINDOW: B[] = [
  { id: 105, queued: "2026-03-04T03:00:00Z", commit: sha("ffff000"), result: "succeeded", finish: "2026-03-04T03:20:00Z" },
  { id: 104, queued: "2026-03-03T16:00:00Z", commit: C3, result: "succeeded", finish: "2026-03-03T16:45:00Z" },
  { id: 103, queued: "2026-03-03T15:00:00Z", commit: C2, result: "failed", finish: "2026-03-03T15:20:00Z" },
  { id: 102, queued: "2026-03-03T13:50:00Z", commit: C2, result: "succeeded", finish: "2026-03-03T14:10:00Z" },
  { id: 101, queued: "2026-03-02T11:00:00Z", commit: C1, result: "succeeded", finish: "2026-03-02T11:20:00Z" },
];
const CHANGES = [
  { sha: C3, title: "Governance roles", paths: ["governance/roles.yaml"], pr: 409 },
  { sha: C4, title: "Schedule", paths: ["jobs/pl_main.yaml"], pr: 415 },
  { sha: C2, title: "Rename subscription_date", paths: ["fabric/nb_standardize.Notebook/notebook-content.py"], pr: 412 },
];

describe("aihub fabric deployed", () => {
  it("picks the newest run whose deploy stage succeeded (skips a failed and a skipped stage)", async () => {
    const builds: B[] = [
      { id: 203, queued: "2026-03-05T10:00:00Z", commit: C3, result: "failed", finish: "2026-03-05T10:10:00Z" },
      { id: 202, queued: "2026-03-05T09:00:00Z", commit: C3, result: "skipped" },
      { id: 201, queued: "2026-03-05T08:00:00Z", commit: C2, result: "succeeded", finish: "2026-03-05T08:30:00Z" },
    ];
    const r = await go([...cd(builds, { repos: { 201: repos(C2, sha("3f9a1c2")) } }), ...git([{ sha: C2, title: "Rename subscription_date", paths: [], pr: 412 }])], ["deployed", "--workspace", WS_NAME]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("environment: TST");
    expect(r.out).toContain("commit: 9c2f771 Rename subscription_date");
    expect(r.out).toContain("run: 201 (2026.201) of cd_pipeline, stage DeployTestEnvironment finished 2026-03-05T08:30:00Z");
    expect(r.out).toContain("triggered: individualCI by Dev One");
    expect(r.out).toContain('pull request: 412 "PR title 412" (story 4120 "Rename column")');
    expect(r.out).toContain("other repositories: central 3f9a1c2");
    expect(r.calls.some((c) => /builds\?.*branchName=refs%2Fheads%2Fstaging/.test(c.url))).toBe(true);
    expect(r.calls.every((c) => c.method === "GET" || /pullrequestquery/.test(c.url))).toBe(true);
  });
  it("--json is a stable object; no other repositories when the run does not return them", async () => {
    const r = await go([...cd([{ id: 201, queued: "2026-03-05T08:00:00Z", commit: C2, result: "succeeded", finish: "2026-03-05T08:30:00Z" }]), ...git([{ sha: C2, title: "x", paths: [] }])], ["deployed", "--env", "tst", "--json"]);
    const j = JSON.parse(r.out).result;
    expect(j).toMatchObject({ environment: { name: "TST", branch: "staging", workspace: WS_NAME, pipeline: "cd_pipeline", stage: "DeployTestEnvironment" }, pipeline: { id: 7, name: "cd_pipeline" }, run: { id: 201, finished: "2026-03-05T08:30:00Z" }, commit: { sha: C2, title: "x" }, pullRequests: [], otherRepositories: [] });
  });
  it("says so in one sentence when no run deployed the stage", async () => {
    const r = await go(cd([{ id: 201, queued: "2026-03-05T08:00:00Z", commit: C2, result: "failed", finish: "2026-03-05T08:30:00Z" }]), ["deployed", "--workspace", WS_NAME]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no run of cd_pipeline on staging has a succeeded stage DeployTestEnvironment in the newest 1 run(s) looked at");
  });
  it("names the team.yaml lines when deployedBy is missing", async () => {
    const r = await go([], ["deployed", "--workspace", "Fabric test-repo acc"]);
    expect(r.code).not.toBe(0);
    expect(r.errs.join("\n")).toContain("fabric.environments.ACC in team.yaml has no deployedBy.pipeline, deployedBy.stage");
    expect(r.errs.join("\n")).toContain("stage: <stage that deploys ACC>");
  });
  it("matches the workspace with {repo} case-insensitively; a feature workspace points to git status", async () => {
    const envs = deployEnvs({ fabric: { environments: { tst: { branch: "staging", workspace: "Fabric {repo} test" } } } } as never, "test-repo");
    expect(matchEnv(envs, { workspace: "fabric TEST-REPO test" })?.name).toBe("TST");
    expect(matchEnv(envs, { workspace: "Fabric test-repo" })).toBeUndefined();
    const r = await go([], ["deployed", "--workspace", "Fabric test-repo 12-export"]);
    expect(r.errs.join("\n")).toContain('aihub fabric git status --workspace "Fabric test-repo 12-export"');
    expect(r.errs.join("\n")).toContain('TST = "Fabric test-repo test"');
  });
});

describe("aihub fabric failures --since-green", () => {
  const all = (jobs = [RED, GREEN_RUN, OLD_GREEN], builds = WINDOW, o: { repos?: Record<number, unknown> } = { repos: { 101: repos(C1, sha("3f9a1c2")), 104: repos(C3, sha("3f9a1c2")) } }) => [...fabric(jobs), ...cd(builds, o), ...git(CHANGES)];
  const args = ["failures", "--workspace", WS_NAME, "--item", "pl_main"];

  it("without the flag prints exactly what it printed before", async () => {
    const dir = repo();
    const plain = await go(all(), args, dir);
    const flagged = await go(all(), [...args, "--since-green"], dir);
    expect(plain.calls.some((c) => c.url.includes("dev.azure.com"))).toBe(false);
    expect(flagged.out.startsWith(`${plain.out}\n\n`)).toBe(true);
    expect(plain.out).not.toContain("since green");
  });

  it("window, deployments, before/after commits, other repositories and suspects first", async () => {
    const r = await go(all(), [...args, "--since-green"]);
    expect(r.code).toBe(0);
    const sg = r.out.split("since green")[1];
    expect(sg).toContain("red: job red-1 started 2026-03-04T02:00:00Z");
    expect(sg).toContain("last green: job green-1 ended 2026-03-03T02:10:00Z");
    expect(sg).toContain("environment: TST (branch staging, pipeline cd_pipeline, stage DeployTestEnvironment)");
    expect(sg).toContain("2026-03-03T14:10:00Z run 102 (2026.102) 4e1a9b0 -> 9c2f771");
    expect(sg).toContain("2026-03-03T16:45:00Z run 104 (2026.104) 9c2f771 -> b7d3e05");
    expect(sg).not.toContain("run 103");
    expect(sg).not.toContain("run 105");
    expect(sg).toContain("code during the green run: 4e1a9b0; during the red run: b7d3e05");
    expect(sg).toContain("other repositories of the run: central 3f9a1c2 unchanged");
    expect(sg).toMatch(/1\. PR 412 "PR title 412" \(story 4120 "Rename column"\)\n\s+touches nb_standardize \(the failing item in the root-cause chain\): fabric\/nb_standardize\.Notebook\/notebook-content\.py/);
    expect(sg).toMatch(/2\. PR 415 .*\n\s+touches a configuration file named like pl_main: jobs\/pl_main\.yaml/);
    expect(sg).toContain('not suspect: PR 409 "PR title 409" touches only governance/');
    expect(sg).toContain("outcome: suspects");
    expect(r.out.trimEnd().endsWith("next: aihub pr explain --pr 412")).toBe(true);
    // the commit range: compare from the green commit to the red commit
    const q = r.calls.find((c) => /commits\?/.test(c.url))!.url;
    expect(q).toContain(`searchCriteria.itemVersion.version=${C3}`);
    expect(q).toContain(`searchCriteria.compareVersion.version=${C1}`);
    // timeline of the run queued after the red run is never read
    expect(r.calls.some((c) => /builds\/105\/timeline/.test(c.url))).toBe(false);
  });

  it("the commit range is checked: when the first answer does not hold the red commit, the two versions are swapped once", async () => {
    // an Azure DevOps that reads itemVersion as the older side: the first query answers nothing, the swapped one the range
    const swappedApi: Route = { match: /_apis\/git\/repositories\/test-repo\/commits\?/, respond: (call) => ({ body: { value: call.url.includes(`searchCriteria.itemVersion.version=${C1}`) ? CHANGES.map((c) => ({ commitId: c.sha, comment: c.title })) : [] } }) };
    const r = await go([swappedApi, ...all()], [...args, "--since-green", "--json"]);
    const sg = JSON.parse(r.out).result.sinceGreen;
    expect(sg.outcome).toBe("suspects");
    expect(sg.commits.map((c: { commit: string }) => c.commit)).toEqual([C3, C4, C2]);
    expect(sg.notes.join("\n")).not.toContain("may not be the right range");
    expect(r.calls.filter((c) => /commits\?/.test(c.url)).length).toBe(2);
  });
  it("a commit list that never holds the red commit is used with a note, not trusted silently", async () => {
    const other: Route = { match: /_apis\/git\/repositories\/test-repo\/commits\?/, respond: () => ({ body: { value: [{ commitId: C2, comment: "Rename subscription_date" }] } }) };
    const r = await go([other, ...all()], [...args, "--since-green", "--json"]);
    const sg = JSON.parse(r.out).result.sinceGreen;
    expect(sg.notes.join("\n")).toContain("does not hold b7d3e05 itself: it may not be the right range");
  });

  it("--json: stable object with window, deployments, suspects and outcome", async () => {
    const r = await go(all(), [...args, "--since-green", "--json"]);
    const j = JSON.parse(r.out).result;
    expect(j.failed).toEqual([{ item: "pl_main", job: "red-1" }]);
    const sg = j.sinceGreen;
    expect(Object.keys(sg).sort()).toEqual(["after", "before", "commits", "deployments", "environment", "notes", "otherRepositories", "otherRepositoriesAvailable", "outcome", "suspects", "unrelated", "window"]);
    expect(sg.window).toEqual({ failed: { item: "pl_main", job: "red-1", start: RED.startTimeUtc }, green: { job: "green-1", end: GREEN_RUN.endTimeUtc } });
    expect(sg.deployments.map((d: { run: number }) => d.run)).toEqual([104, 102]);
    expect(sg.before).toEqual({ run: 101, finished: "2026-03-02T11:20:00Z", commit: C1 });
    expect(sg.after).toEqual({ run: 104, finished: "2026-03-03T16:45:00Z", commit: C3 });
    expect(sg.commits).toHaveLength(3);
    expect(sg.otherRepositories).toEqual([{ alias: "central", before: sha("3f9a1c2"), after: sha("3f9a1c2"), changed: false }]);
    expect(sg.suspects[0]).toMatchObject({ pr: 412, title: "PR title 412", stories: [{ id: 4120, title: "Rename column" }], paths: ["fabric/nb_standardize.Notebook/notebook-content.py"] });
    expect(sg.unrelated).toEqual([{ pr: 409, title: "PR title 409", stories: [{ id: 4090, title: "Rename column" }], paths: ["governance/roles.yaml"] }]);
    expect(sg.outcome).toBe("suspects");
  });

  it("other repositories not available when the run does not return them; a changed version is a -> b", async () => {
    const none = await go(all(undefined, undefined, {}), [...args, "--since-green"]);
    expect(none.out).toContain("other repositories of the run: not available");
    const changed = await go(all(undefined, undefined, { repos: { 101: repos(C1, sha("3f9a1c2")), 104: repos(C3, sha("5b5b5b5")) } }), [...args, "--since-green"]);
    expect(changed.out).toContain("other repositories of the run: central 3f9a1c2 -> 5b5b5b5");
  });

  it("nothingDeployed: the cause is outside the code", async () => {
    const r = await go(all(undefined, [WINDOW[4]]), [...args, "--since-green", "--json"]);
    const sg = JSON.parse(r.out).result.sinceGreen;
    expect(sg.outcome).toBe("nothingDeployed");
    expect(sg.before.run).toBe(101);
    expect(sg.after.run).toBe(101);
    expect(sg.notes.join(" ")).toContain("the cause is outside the code");
    const t = await go(all(undefined, [WINDOW[4]]), [...args, "--since-green"]);
    expect(t.out).toContain("nothing was deployed to TST between the green and the red run");
  });

  it("noGreenRun: the item never succeeded before the red run", async () => {
    const r = await go(all([RED, { ...GREEN_RUN, id: "later", startTimeUtc: "2026-03-05T02:00:00Z", endTimeUtc: "2026-03-05T02:10:00Z" }]), [...args, "--since-green"]);
    expect(r.out).toContain("no green run: pl_main never succeeded before this run in the history Fabric returns (2 run(s))");
    expect(r.out).toContain("outcome: noGreenRun");
    expect(r.calls.some((c) => c.url.includes("dev.azure.com"))).toBe(false);
  });

  it("notConfigured: a workspace without an environment, or without deployedBy", async () => {
    const other = [get(/\/v1\/workspaces$/, { value: [{ id: TWS, displayName: "Fabric test-repo acc" }] }), ...fabric([RED, GREEN_RUN]).slice(1)];
    const r = await go(other, ["failures", "--workspace", "Fabric test-repo acc", "--item", "pl_main", "--since-green"]);
    expect(r.out).toContain("last green: job green-1");
    expect(r.out).toContain("fabric.environments.ACC in team.yaml has no deployedBy.pipeline, deployedBy.stage");
    expect(r.out).toContain("outcome: notConfigured");
  });

  it("a read that fails degrades to one sentence, never a stack trace", async () => {
    const r = await go(fabric([RED, GREEN_RUN]), [...args, "--since-green"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/deployments not read: .*404/);
    expect(r.out).toContain("outcome: unavailable");
    expect(r.out).not.toMatch(/\n\s+at /);
  });

  it("history that does not reach back to the green run is said", async () => {
    const r = await go(all(undefined, WINDOW.slice(0, 4)), [...args, "--since-green", "--json"]);
    const sg = JSON.parse(r.out).result.sinceGreen;
    expect(sg.before).toBeNull();
    expect(sg.notes.join(" ")).toContain("do not reach back to the green run");
    expect(sg.notes.join(" ")).toContain("counted from the oldest deployment found");
  });
});

describe("ranking", () => {
  const PL = { metadata: { type: "DataPipeline", displayName: "pl_main" }, config: { logicalId: "aaaaaaaa-0000-0000-0000-000000000001" } };
  const NB = { metadata: { type: "Notebook", displayName: "nb_load" }, config: { logicalId: "bbbbbbbb-0000-0000-0000-000000000002" } };
  const files = {
    "fabric/pl_main.DataPipeline/.platform": JSON.stringify(PL),
    "fabric/pl_main.DataPipeline/pipeline-content.json": JSON.stringify({ properties: { activities: [{ name: "RunLoad", type: "TridentNotebook", typeProperties: { notebookId: NB.config.logicalId } }] } }),
    "fabric/nb_load.Notebook/.platform": JSON.stringify(NB),
    "fabric/nb_load.Notebook/notebook-content.py": "print(1)\n",
  };
  it("an item the failed pipeline calls is a suspect with a local clone, and skipped without one", () => {
    const dir = repo(files);
    const changes = groupChanges([{ commit: C2, title: "load", paths: ["fabric/nb_load.Notebook/notebook-content.py"] }, { commit: C3, title: "docs", paths: ["docs/x.md"] }], new Map(), new Map());
    const withClone = rank(changes, { failed: { name: "pl_main", type: "DataPipeline" }, chainNames: [], clone: { root: dir, files: Object.keys(files) } });
    expect(withClone.suspects).toHaveLength(1);
    expect(withClone.suspects[0].reason).toBe("touches nb_load, which pl_main calls (activity RunLoad)");
    expect(withClone.unrelated.map((u) => u.title)).toEqual(["docs"]);
    const without = rank(changes, { failed: { name: "pl_main", type: "DataPipeline" }, chainNames: [] });
    expect(without.suspects).toHaveLength(0);
  });
  it("the failed item itself ranks before a configuration file; commits group by pull request", () => {
    const changes = groupChanges(
      [
        { commit: C4, title: "cfg", paths: ["jobs/pl_main.yaml"] },
        { commit: C3, title: "a", paths: ["fabric/pl_main.DataPipeline/pipeline-content.json"] },
        { commit: C2, title: "b", paths: ["fabric/pl_main.DataPipeline/x.json"] },
      ],
      new Map([[7, { pr: 7, title: "PR 7", stories: [] }]]),
      new Map([
        [C3, [7]],
        [C2, [7]],
      ]),
    );
    expect(changes).toHaveLength(2);
    const r = rank(changes, { failed: { name: "pl_main", type: "DataPipeline" }, chainNames: [] });
    expect(r.suspects.map((s) => s.pr ?? s.commits[0])).toEqual([7, C4]);
    expect(r.suspects[0].reason).toBe("touches pl_main (the item that failed)");
  });
  it("chain names: deepest first, without session details", () => {
    expect(chainNames([{ level: 0, kind: "DataPipeline", name: "pl_main" }, { level: 1, kind: "activity TridentNotebook", name: "RunStd" }, { level: 2, kind: "spark session", name: "nb_std (LS, Failed)" }])).toEqual(["nb_std", "RunStd"]);
  });
});

describe("team.yaml keys", () => {
  it("team validate accepts fabric.environments.<ENV>.workspace and deployedBy for any environment name", async () => {
    const { validateTeamText } = await import("../src/lib/teamValidate.js");
    const r = validateTeamText(TEAM);
    expect(r.problems.filter((p) => p.code === "unknownKey")).toEqual([]);
  });
});

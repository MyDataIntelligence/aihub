import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { main } from "../src/router.js";
import { environmentsOf, releaseEnvPlan, releaseNotes, type EnvDiff, type StageReader } from "../src/lib/releaseEnv.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

const TEAM = (lang = "en", pipeline = true) =>
  [
    `language: ${lang}`,
    "repositories:",
    "  - name: test-repo",
    "    defaultTarget: main",
    "fabric:",
    ...(pipeline ? ["  deploymentPipeline: orders-pipe"] : []),
    "  environments:",
    "    DEV:",
    "      branch: develop",
    "      stage: Development",
    "    ACC:",
    "      branch: staging",
    "      stage: Acceptance",
    "",
  ].join("\n");

/** main = staging; develop has three first-parent commits: PR 11 (notebook), PR 12 (new lakehouse) and a direct push. */
function world(team = TEAM()) {
  const { dir } = makeRepo();
  sh(dir, ["config", "user.name", "T"]);
  sh(dir, ["config", "user.email", "t@e.com"]);
  write(dir, ".agents/skills/_shared/references/team.yaml", team);
  write(dir, "nb_load.Notebook/notebook-content.py", "print(1)\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "base"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["push", "origin", "main:staging"]);
  sh(dir, ["checkout", "-b", "develop"]);
  write(dir, "nb_load.Notebook/notebook-content.py", "print(2)\n");
  sh(dir, ["commit", "-am", "Merged PR 11: faster load"]);
  const c1 = sh(dir, ["rev-parse", "HEAD"]);
  write(dir, "lh_new.Lakehouse/.platform", "{}\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "Merged PR 12: new lakehouse"]);
  const c2 = sh(dir, ["rev-parse", "HEAD"]);
  write(dir, "README.md", "tweak\n");
  sh(dir, ["commit", "-am", "tweak readme"]);
  sh(dir, ["push", "origin", "develop"]);
  return { dir, c1, c2 };
}

const PR = "/ferron-org/test-project/_apis/git/repositories/test-repo";

function ado(c1: string, c2: string): Route[] {
  return [
    // only the first commit is known to the query: the second one must be found through its message
    { method: "POST", match: new RegExp(PR + "/pullrequestquery\\?"), respond: () => ({ body: { results: [{ [c1]: [{ pullRequestId: 11 }] }] } }) },
    { match: new RegExp(PR + "/pullrequests/11\\?"), respond: () => ({ body: { pullRequestId: 11, title: "Faster load", status: "completed", lastMergeCommit: { commitId: c1 }, workItemRefs: [{ id: "101" }], sourceRefName: "refs/heads/f", targetRefName: "refs/heads/develop" } }) },
    { match: new RegExp(PR + "/pullrequests/12\\?"), respond: () => ({ body: { pullRequestId: 12, title: "New lakehouse", status: "completed", lastMergeCommit: { commitId: c2 }, workItemRefs: [{ id: "102" }], sourceRefName: "refs/heads/g", targetRefName: "refs/heads/develop" } }) },
    { match: /_apis\/wit\/workitems\/101\?/, respond: () => ({ body: { fields: { "System.Title": "Sneller laden" } } }) },
    { match: /_apis\/wit\/workitems\/102\?/, respond: () => ({ body: { fields: { "System.Title": "Nieuw lakehouse" } } }) },
  ];
}

const stages: Record<string, { name: string; type: string }[]> = {
  Development: [{ name: "nb_load", type: "Notebook" }, { name: "nb_new", type: "Notebook" }, { name: "lh_new", type: "Lakehouse" }],
  Acceptance: [{ name: "nb_load", type: "Notebook" }, { name: "nb_old", type: "Notebook" }],
};
const reader: StageReader & { calls: string[] } = Object.assign(async (p: string, s: string) => (reader.calls.push(`${p}/${s}`), stages[s]), { calls: [] as string[] });

describe("environmentsOf", () => {
  it("reads fabric.environments with upper-case keys", () => {
    expect(environmentsOf({ fabric: { environments: { dev: { branch: "develop" } } } } as never)).toEqual({ DEV: { branch: "develop" } });
    expect(environmentsOf({})).toEqual({});
  });
});

describe("aihub release plan --from DEV --to ACC", () => {
  it("items new/changed/deleted with their PRs and stories, the cherry-pick list in merge order, the plan and the release notes", async () => {
    const { dir, c1, c2 } = world();
    const { ctx } = ctxFor(dir, fakeFetch(ado(c1, c2)).fn);
    const out = join(tmp("env-"), "plan.yaml");
    const notes = join(tmp("env-"), "notes.md");
    const text = await releaseEnvPlan(ctx, { from: "DEV", to: "ACC", out, notesOut: notes }, { stageItems: reader });
    expect(reader.calls).toEqual(["orders-pipe/Development", "orders-pipe/Acceptance"]);
    expect(text).toContain("Release DEV -> ACC: git origin/staging..origin/develop: 3 commit(s), 2 PR(s), 2 story(ies)");
    expect(text).toContain("Fabric stages Development -> Acceptance: compared");
    expect(text).toMatch(/new\s+Lakehouse lh_new\s+PRs !12\s+stories AB#102/);
    expect(text).toMatch(/new\s+Notebook nb_new\s*$/m);
    expect(text).toMatch(/changed\s+Notebook nb_load\s+PRs !11\s+stories AB#101/);
    expect(text).toMatch(/deleted\s+Notebook nb_old/);
    expect(text.indexOf("!11 Faster load")).toBeLessThan(text.indexOf("!12 New lakehouse")); // merge order
    expect(text).toMatch(/[0-9a-f]{8} tweak readme {2}\(no PR\)/);
    // the plan can go straight into `aihub release run`
    const plan = parse(readFileSync(out, "utf8"));
    expect(plan.targets).toEqual(["staging"]);
    expect(plan.items).toEqual([
      { pr: 11, title: "Faster load", commit: c1, story: 101 },
      { pr: 12, title: "New lakehouse", commit: c2, story: 102 },
      { commit: expect.stringMatching(/^[0-9a-f]{40}$/), title: "tweak readme" },
    ]);
    const md = readFileSync(notes, "utf8");
    expect(md).toContain("# Release notes DEV -> ACC (");
    expect(md).toContain("- AB#101 Sneller laden (!11)");
    expect(md).toContain("## Without a story\n\n- ");
    expect(md).toContain("- Notebook nb_load: changed (AB#101, !11)");
    expect(md).toContain("- Notebook nb_old: deleted");
  });

  it("--target for a release branch, --json, and the Dutch notes", async () => {
    const { dir, c1, c2 } = world(TEAM("nl"));
    const { ctx } = ctxFor(dir, fakeFetch(ado(c1, c2)).fn);
    const j = JSON.parse(await releaseEnvPlan(ctx, { from: "dev", to: "acc", target: "release/1.4", also: ["release/1.3"], json: true }, { stageItems: reader }));
    expect(j.plan.targets).toEqual(["release/1.4", "release/1.3"]);
    expect(j.plan.name).toMatch(/^release\/acc-\d{8}$/);
    expect(j.diff.items.map((i: any) => `${i.status}:${i.name}`)).toEqual(["new:lh_new", "new:nb_new", "changed:nb_load", "deleted:nb_old"]);
    expect(j.notes).toContain("# Release-notes DEV -> ACC");
    expect(j.notes).toContain("## Onderdelen");
    expect(j.notes).toContain("- Notebook nb_old: verwijderd");
  });

  it("without a deployment pipeline (or when Fabric fails) the plan is git only and says so", async () => {
    const a = world(TEAM("en", false));
    const none = await releaseEnvPlan(ctxFor(a.dir, fakeFetch(ado(a.c1, a.c2)).fn).ctx, { from: "DEV", to: "ACC" }, { stageItems: reader });
    expect(none).toContain("Fabric stage compare skipped: fabric.deploymentPipeline is not set in team.yaml (git only)");
    expect(none).toMatch(/changed\s+Notebook nb_load/);
    expect(none).not.toMatch(/deleted/);
    const b = world();
    const failing: StageReader = async () => {
      throw new Error("deployment pipeline 'orders-pipe' not found\nmore");
    };
    const git = await releaseEnvPlan(ctxFor(b.dir, fakeFetch(ado(b.c1, b.c2)).fn).ctx, { from: "DEV", to: "ACC" }, { stageItems: failing });
    expect(git).toContain("Fabric stage compare skipped: deployment pipeline 'orders-pipe' not found (git only)");
    expect(git).toMatch(/changed\s+Lakehouse lh_new/);
  });

  it("clear errors: missing branch mapping, same environment, from without to; nothing is written to Azure DevOps", async () => {
    const { dir, c1, c2 } = world(TEAM().replace("      branch: staging\n", ""));
    const f = fakeFetch(ado(c1, c2));
    const { ctx } = ctxFor(dir, f.fn);
    await expect(releaseEnvPlan(ctx, { from: "DEV", to: "ACC" }, { stageItems: reader })).rejects.toThrow(/fabric\.environments\.ACC\.branch is not set in team\.yaml/);
    await expect(releaseEnvPlan(ctx, { from: "DEV", to: "dev" }, { stageItems: reader })).rejects.toThrow(/same environment/);
    await expect(releaseEnvPlan(ctx, { from: "DEV" }, { stageItems: reader })).rejects.toThrow(/--from and --to go together/);
    expect(f.calls.filter((c) => c.method !== "GET" && !/pullrequestquery/.test(c.url))).toEqual([]);
  });

  it("the command: --from/--to reach the plan; --stories/--prs are not needed", async () => {
    const { dir, c1, c2 } = world(TEAM("en", false));
    const { ctx, lines } = ctxFor(dir, fakeFetch(ado(c1, c2)).fn);
    expect(await main(["release", "plan", "--from", "DEV", "--to", "ACC", "--json"], ctx)).toBe(0);
    expect(JSON.parse(lines.join("\n")).diff).toMatchObject({ from: "DEV", to: "ACC", commits: 3 });
    const { ctx: ctx2, errs } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["release", "plan", "--from", "DEV"], ctx2)).toBe(1);
    expect(errs.join("\n")).toContain("--from and --to go together");
  });
});

describe("releaseNotes", () => {
  it("an empty range says nothing changed", () => {
    const d: EnvDiff = { from: "DEV", to: "ACC", fromBranch: "develop", toBranch: "staging", commits: 0, items: [], prs: [], direct: [], stories: [], fabric: { used: false } };
    expect(releaseNotes(d, "en", "2026-11-18")).toBe("# Release notes DEV -> ACC (2026-11-18)\n\n## Items\n\n- nothing changed\n");
    expect(releaseNotes(d, "nl", "2026-11-18")).toContain("- niets gewijzigd");
  });
});

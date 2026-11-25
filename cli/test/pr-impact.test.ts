import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flattenKeys } from "../src/lib/prImpact.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

const TEAM = `repositories:
  - name: test-repo
    defaultTarget: main
pullRequest:
  userImpact:
    audience: developers who write job YAML for this platform
    contractPaths: ["schema/*.yaml", "templates/**"]
    userFiles:
      - repository: test-repo
        paths: ["jobs/*.yaml"]
      - repository: other-repo
        paths: ["jobs/*.yaml"]
`;
const TEMPLATE = "## Summary\n\n## Required user actions\n<!-- what must users change? -->\n";
const PR_BASE = "/ferron-org/test-project/_apis/git/repositories/test-repo/pullrequests";

function setup(contractChange = true) {
  const { dir } = makeRepo();
  write(dir, ".azuredevops/pull_request_template.md", TEMPLATE);
  write(dir, ".agents/skills/_shared/references/team.yaml", TEAM);
  write(dir, "schema/job.yaml", "name: x\ntarget_table: t\nschedule:\n  cron: '* * * * *'\n");
  write(dir, "jobs/orders_ingest.yaml", "name: orders\ntarget_table: orders\n");
  write(dir, "jobs/orders_export.yaml", "name: export\ndestination:\n  table: exp\n");
  write(dir, "README.md", "target_table is documented here\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "chore: base"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["checkout", "-b", "feature/77-jobs"]);
  if (contractChange) write(dir, "schema/job.yaml", "name: x\ndestination:\n  table: t\nschedule:\n  cron: '* * * * *'\n");
  else write(dir, "src/code.py", "print(1)\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "feat: change"]);
  return dir;
}

const routes = (): Route[] => [
  { match: /_apis\/wit\/workitems\/77\?.*fields=/, respond: () => ({ body: { fields: { "System.Title": "Contract" } } }) },
  { match: /_apis\/wit\/workitems\/77\?.*expand=relations|%24expand=relations/, respond: () => ({ body: { relations: [] } }) },
  { match: new RegExp(PR_BASE + "\\?.*searchCriteria"), respond: () => ({ body: { value: [] } }) },
  { method: "POST", match: new RegExp(PR_BASE + "\\?"), respond: () => ({ body: { pullRequestId: 9 } }) },
];

describe("flattenKeys", () => {
  it("walks objects and arrays", () => {
    expect([...flattenKeys({ a: 1, b: { c: [{ d: 1 }], e: {} } })].sort()).toEqual(["a", "b.c[].d", "b.e"]);
  });
});

describe("aihub pr impact", () => {
  it("names the changed contract keys and the user files that still use a removed one", async () => {
    const dir = setup();
    const { fn } = fakeFetch(routes());
    const { ctx, lines, errs } = ctxFor(dir, fn);
    expect(await main(["pr", "impact"], ctx)).toBe(0);
    expect(errs).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain("Audience: developers who write job YAML");
    expect(text).toContain("schema/job.yaml (modified): removed `target_table`; added `destination.table`");
    expect(text).toContain("(renamed?)");
    expect(text).toContain("Still used in test-repo: `target_table` in 1 file: `jobs/orders_ingest.yaml`");
    expect(text).not.toContain("orders_export");
    expect(text).not.toContain("README");
    expect(text).toContain("Not searched: other-repo (no local clone)");
    expect(Buffer.byteLength(text)).toBeLessThan(1500);
  });

  it("--json has the same facts", async () => {
    const dir = setup();
    const { ctx, lines } = ctxFor(dir, fakeFetch(routes()).fn);
    expect(await main(["pr", "impact", "--json"], ctx)).toBe(0);
    const j = JSON.parse(lines[0]);
    expect(j.contract[0]).toMatchObject({ file: "schema/job.yaml", removed: ["target_table"], added: ["destination.table"] });
    expect(j.uses[0].keys[0]).toMatchObject({ key: "target_table", files: ["jobs/orders_ingest.yaml"], count: 1 });
  });

  it("says so when the contract did not change", async () => {
    const dir = setup(false);
    const { ctx, lines } = ctxFor(dir, fakeFetch(routes()).fn);
    expect(await main(["pr", "impact"], ctx)).toBe(0);
    expect(lines.join("\n")).toContain("Contract unchanged");
  });

  it("without userImpact in team.yaml it says the contract is not defined", async () => {
    const { dir } = makeRepo();
    sh(dir, ["checkout", "-b", "feature/1-x"]);
    const { ctx, lines } = ctxFor(dir, fakeFetch(routes()).fn);
    expect(await main(["pr", "impact"], ctx)).toBe(0);
    expect(lines.join("\n")).toContain("not defined");
  });

  it("finds user files in a sibling clone of another repository", async () => {
    const dir = setup();
    const sibling = join(dir, "..", "other-repo");
    sh(tmp(), ["init", "-b", "main", sibling]);
    write(sibling, "jobs/b.yaml", "target_table: z\n");
    write(sibling, "jobs/c.yaml", "name: c\n");
    sh(sibling, ["add", "."]);
    sh(sibling, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "x"]);
    const { ctx, lines } = ctxFor(dir, fakeFetch(routes()).fn);
    await main(["pr", "impact"], ctx);
    const text = lines.join("\n");
    expect(text).toContain("Still used in other-repo: `target_table` in 1 file: `jobs/b.yaml`");
    expect(text).not.toContain("Not searched");
  });
});

describe("aihub pr create warns when the contract changed but the section says none", () => {
  const body = (t: string) => {
    const f = join(tmp(), "b.md");
    writeFileSync(f, t, "utf8");
    return f;
  };
  it("warns in the result line, does not refuse", async () => {
    const dir = setup();
    const { ctx, lines, errs } = ctxFor(dir, fakeFetch(routes()).fn);
    expect(await main(["pr", "create", "--body-file", body("## Summary\nx\n\n## Required user actions\nNone\n")], ctx)).toBe(0);
    expect(errs).toEqual([]);
    expect(lines[0]).toContain("warning: 'Required user actions' says there is nothing to do");
    expect(lines[0]).toContain("schema/job.yaml");
  });
  it("no warning when the contract did not change", async () => {
    const dir = setup(false);
    const { ctx, lines } = ctxFor(dir, fakeFetch(routes()).fn);
    expect(await main(["pr", "create", "--body-file", body("## Summary\nx\n\n## Required user actions\nNone\n")], ctx)).toBe(0);
    expect(lines[0]).not.toContain("warning");
  });
  it("no warning when the section lists actions", async () => {
    const dir = setup();
    const { ctx, lines } = ctxFor(dir, fakeFetch(routes()).fn);
    const t = "## Summary\nx\n\n## Required user actions\n- `jobs/orders_ingest.yaml`: rename `target_table` -> `destination.table`\n";
    expect(await main(["pr", "create", "--body-file", body(t)], ctx)).toBe(0);
    expect(lines[0]).not.toContain("warning");
  });
});

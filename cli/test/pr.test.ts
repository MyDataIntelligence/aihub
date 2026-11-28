import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, commands } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

const TEMPLATE = `## Beschrijving

## Story

## Tests

## Commits

## Gerelateerde PR's

## Screenshots (optioneel)
`;

function setup() {
  const { dir, bare } = makeRepo();
  write(dir, ".azuredevops/pull_request_template.md", TEMPLATE);
  write(dir, ".agents/skills/_shared/references/team.yaml", "language: nl\nrepositories:\n  - name: test-repo\n    defaultTarget: main\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "chore: sjablonen"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["checkout", "-b", "feature/1234-zoekfunctie"]);
  write(dir, "zoek.py", "print('zoë')\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "feat: zoekfunctie met ë"]);
  return { dir, bare };
}

const PR_BASE = "/ferron-org/test-project/_apis/git/repositories/test-repo/pullrequests";

function adoRoutes(extra: Route[] = [], opts: { existing?: any } = {}): Route[] {
  return [
    ...extra,
    { match: /_apis\/wit\/workitems\/1234\?.*fields=/, respond: () => ({ body: { fields: { "System.Title": "Zoekfunctie bouwen" } } }) },
    {
      match: /_apis\/wit\/workitems\/1234\?.*expand=relations|%24expand=relations/,
      respond: () => ({
        body: {
          relations: [
            { rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/proj%2Frepo%2F55" },
            { rel: "Hyperlink", url: "https://example.com" },
          ],
        },
      }),
    },
    { match: new RegExp(PR_BASE + "\\?.*searchCriteria"), respond: () => ({ body: { value: opts.existing ? [opts.existing] : [] } }) },
  ];
}

describe("aihub pr create", () => {
  it("creates a PR from the template, work item, commits and body file (UTF-8)", async () => {
    const { dir, bare } = setup();
    const bodyFile = join(tmp(), "body.md");
    writeFileSync(bodyFile, "## Beschrijving\nZoeken met diakrieten: ë, é, ü, ñ.\n\n## Tests\nHandmatig: ✓\n", "utf8");
    const { fn, calls } = fakeFetch(
      adoRoutes([{ method: "POST", match: new RegExp(PR_BASE + "\\?"), respond: () => ({ body: { pullRequestId: 42 } }) }]),
    );
    const { ctx, lines, errs } = ctxFor(dir, fn);
    const code = await main(["pr", "create", "--body-file", bodyFile], ctx);
    expect(errs).toEqual([]);
    expect(code).toBe(0);

    // pushed to the local bare remote
    expect(sh(bare, ["rev-parse", "feature/1234-zoekfunctie"])).toBe(sh(dir, ["rev-parse", "HEAD"]));

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.headers.Authorization).toMatch(/^Basic /);
    expect(post.body.sourceRefName).toBe("refs/heads/feature/1234-zoekfunctie");
    expect(post.body.targetRefName).toBe("refs/heads/main");
    expect(post.body.title).toBe("1234 Zoekfunctie bouwen");
    expect(post.body.isDraft).toBe(false);
    expect(post.body.workItemRefs).toEqual([{ id: "1234" }]);
    expect(post.body.description).toBe(
      [
        "## Beschrijving",
        "",
        "Zoeken met diakrieten: ë, é, ü, ñ.",
        "",
        "## Story",
        "",
        "AB#1234",
        "",
        "## Tests",
        "",
        "Handmatig: ✓",
        "",
        "## Commits",
        "",
        `- feat: zoekfunctie met ë (${sh(dir, ["rev-parse", "--short", "HEAD"])})`,
        "",
        "## Gerelateerde PR's",
        "",
        "- !55",
        "",
        "## Screenshots (optioneel)",
        "",
        "n.v.t.",
        "",
      ].join("\n"),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("https://dev.azure.com/ferron-org/test-project/_git/test-repo/pullrequest/42");
    expect(lines[0]).toContain("n.v.t.: Screenshots (optioneel)");
  });

  it("strips a BOM from the body file and honours --draft, --title, --work-item", async () => {
    const { dir } = setup();
    sh(dir, ["branch", "-m", "feature/zonder-id"]);
    const bodyFile = join(tmp(), "body.md");
    writeFileSync(bodyFile, "﻿## Beschrijving\nGoed\n", "utf8");
    const { fn, calls } = fakeFetch(
      adoRoutes([{ method: "POST", match: new RegExp(PR_BASE + "\\?"), respond: () => ({ body: { pullRequestId: 7 } }) }]),
    );
    const { ctx } = ctxFor(dir, fn);
    expect(await main(["pr", "create", "--body-file", bodyFile, "--draft", "--title", "Eigen titel", "--work-item", "1234"], ctx)).toBe(0);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body.title).toBe("Eigen titel");
    expect(post.body.isDraft).toBe(true);
    expect(post.body.description.startsWith("## Beschrijving\n\nGoed\n")).toBe(true);
  });

  it("updates the existing PR instead of creating a second one", async () => {
    const { dir } = setup();
    const { fn, calls } = fakeFetch(
      adoRoutes(
        [{ method: "PATCH", match: new RegExp(PR_BASE + "/42\\?"), respond: () => ({ body: {} }) }],
        { existing: { pullRequestId: 42 } },
      ),
    );
    const { ctx, lines } = ctxFor(dir, fn);
    expect(await main(["pr", "create"], ctx)).toBe(0);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(calls.find((c) => c.method === "PATCH")!.body.description).toContain("## Story\n\nAB#1234");
    expect(lines[0]).toContain("PR !42 updated");
  });

  it("--dry-run prints the description and changes nothing", async () => {
    const { dir, bare } = setup();
    const { fn, calls } = fakeFetch(adoRoutes());
    const { ctx, lines } = ctxFor(dir, fn);
    expect(await main(["pr", "create", "--dry-run", "--json"], ctx)).toBe(0);
    const j = JSON.parse(lines[0]);
    expect(j.dryRun).toBe(true);
    expect(j.title).toBe("1234 Zoekfunctie bouwen");
    expect(j.template).toBe(".azuredevops/pull_request_template.md");
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
    expect(sh(bare, ["branch", "--list"])).not.toContain("feature/1234");
  });

  it("uses the team.yaml emptySection text", async () => {
    const { dir } = setup();
    write(dir, ".agents/skills/_shared/references/team.yaml", "repositories:\n  - name: test-repo\n    defaultTarget: main\npullRequest:\n  emptySection: Niet van toepassing\n");
    const { fn } = fakeFetch(adoRoutes());
    const { ctx, lines } = ctxFor(dir, fn);
    await main(["pr", "create", "--dry-run"], ctx);
    expect(lines[0]).toContain("Niet van toepassing");
  });

  it("fails with one clear line when not signed in", async () => {
    const { dir } = setup();
    const { fn } = fakeFetch([{ match: /./, respond: () => ({ status: 401, body: {} }) }]);
    const { ctx, errs } = ctxFor(dir, fn);
    expect(await main(["pr", "create"], ctx)).toBe(1);
    expect(errs).toEqual(["aihub: not signed in to Azure DevOps: run 'az login' or set AIHUB_ADO_PAT"]);
  });
});

describe("aihub pr update", () => {
  const existing = {
    pullRequestId: 42,
    title: "t",
    status: "active",
    description: "## Beschrijving\n\nEerste.\n\n## Tests\n\nn.v.t.\n",
    sourceRefName: "refs/heads/feature/1234-zoekfunctie",
    targetRefName: "refs/heads/main",
  };

  it("appends to one section without a checkout and keeps the rest", async () => {
    const dir = tmp();
    sh(dir, ["init", "-b", "main"]);
    sh(dir, ["config", "remote.origin.url", "https://dev.azure.com/ferron-org/test-project/_git/test-repo"]);
    const f = join(dir, "extra.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(f, "Extra uitleg met é.", "utf8");
    const { fn, calls } = fakeFetch([
      { match: new RegExp(PR_BASE + "/42\\?"), respond: () => ({ body: existing }) },
      { method: "PATCH", match: new RegExp(PR_BASE + "/42\\?"), respond: () => ({ body: {} }) },
    ]);
    const { ctx, lines } = ctxFor(dir, fn);
    expect(await main(["pr", "update", "--pr", "https://dev.azure.com/ferron-org/test-project/_git/test-repo/pullrequest/42", "--section", "Beschrijving", "--append-file", f, "--draft", "true"], ctx)).toBe(0);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body.description).toBe("## Beschrijving\n\nEerste.\n\nExtra uitleg met é.\n\n## Tests\n\nn.v.t.\n");
    expect(patch.body.isDraft).toBe(true);
    expect(lines[0]).toContain("PR !42 updated");
  });

  it("rejects oversized evidence before patching the pull request", async () => {
    const { dir } = setup();
    const { fn, calls } = fakeFetch([{ match: /pullrequests\/42/, respond: () => ({ body: existing }) }]);
    const { ctx, errs } = ctxFor(dir, fn);
    expect(await main(["pr", "update", "--pr", "42", "--section", "Tests", "--replace-text", "x".repeat(4000)], ctx)).toBe(1);
    expect(errs.join(" ")).toMatch(/exceeds 4000/);
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("rejects an update without changes", async () => {
    const dir = tmp();
    sh(dir, ["init", "-b", "main"]);
    sh(dir, ["config", "remote.origin.url", "https://dev.azure.com/ferron-org/test-project/_git/test-repo"]);
    const { fn } = fakeFetch([{ match: /pullrequests\/42/, respond: () => ({ body: existing }) }]);
    const { ctx, errs } = ctxFor(dir, fn);
    expect(await main(["pr", "update", "--pr", "42"], ctx)).toBe(1);
    expect(errs[0]).toMatch(/nothing to update/);
  });
});

describe("router", () => {
  it("is extensible and reports unknown commands", async () => {
    const { ctx, errs, lines } = ctxFor(tmp(), fakeFetch([]).fn);
    expect(await main(["bogus"], ctx)).toBe(2);
    expect(errs[0]).toContain("unknown command 'bogus'");
    expect(await main(["hello"], ctx, { ...commands, hello: async (_a, c) => c.out("hi") })).toBe(0);
    expect(lines).toEqual(["hi"]);
  });
});

describe("aihub pr, one-call agent flows", () => {
  it("create takes the summary inline: it lands in the first template section, no body file needed", async () => {
    const { dir } = setup();
    const { fn, calls } = fakeFetch(
      adoRoutes([{ method: "POST", match: new RegExp(PR_BASE + "\?"), respond: () => ({ body: { pullRequestId: 42 } }) }]),
    );
    const { ctx, errs } = ctxFor(dir, fn);
    expect(await main(["pr", "create", "--summary-text", "Zoeken met ë, é en ü."], ctx)).toBe(0);
    expect(errs).toEqual([]);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body.description).toMatch(/## Beschrijving\n+Zoeken met ë, é en ü\./);
    expect(post.body.description).toContain("AB#1234");
  });

  it("update takes the PR url positionally and appends short inline text to one section", async () => {
    const dir = tmp();
    sh(dir, ["init", "-b", "main"]);
    sh(dir, ["config", "remote.origin.url", "https://dev.azure.com/ferron-org/test-project/_git/test-repo"]);
    const existing = { pullRequestId: 42, title: "t", status: "active", description: "## Samenvatting\n\nEerste.\n\n## Testen\n\nUnit-test gedraaid.\n", sourceRefName: "refs/heads/x", targetRefName: "refs/heads/main" };
    const { fn, calls } = fakeFetch([
      { match: new RegExp(PR_BASE + "/42\?"), respond: () => ({ body: existing }) },
      { method: "PATCH", match: new RegExp(PR_BASE + "/42\?"), respond: () => ({ body: {} }) },
    ]);
    const { ctx, lines } = ctxFor(dir, fn);
    const url = "https://dev.azure.com/ferron-org/test-project/_git/test-repo/pullrequest/42";
    expect(await main(["pr", "update", url, "--section", "Testen", "--append-text", "Handmatig getest met ë."], ctx)).toBe(0);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body.description).toBe("## Samenvatting\n\nEerste.\n\n## Testen\n\nUnit-test gedraaid.\n\nHandmatig getest met ë.\n");
    expect(lines[0]).toContain("PR !42 updated");
  });

  it("update replaces a section from inline text, and refuses inline text without --section", async () => {
    const dir = tmp();
    sh(dir, ["init", "-b", "main"]);
    sh(dir, ["config", "remote.origin.url", "https://dev.azure.com/ferron-org/test-project/_git/test-repo"]);
    const existing = { pullRequestId: 42, title: "t", status: "active", description: "## A\n\none\n\n## B\n\ntwo\n", sourceRefName: "refs/heads/x", targetRefName: "refs/heads/main" };
    const { fn, calls } = fakeFetch([
      { match: new RegExp(PR_BASE + "/42\?"), respond: () => ({ body: existing }) },
      { method: "PATCH", match: new RegExp(PR_BASE + "/42\?"), respond: () => ({ body: {} }) },
    ]);
    const { ctx, errs } = ctxFor(dir, fn);
    expect(await main(["pr", "update", "--pr", "42", "--section", "B", "--replace-text", "nieuw"], ctx)).toBe(0);
    expect(calls.find((c) => c.method === "PATCH")!.body.description).toBe("## A\n\none\n\n## B\n\nnieuw\n");
    expect(await main(["pr", "update", "--pr", "42", "--append-text", "x"], ctx)).toBe(1);
    expect(errs.join("\n")).toMatch(/need --section/);
  });

  it("answers --help with the one-line commands instead of an option error", async () => {
    const { ctx, lines } = ctxFor(tmp(), fakeFetch([]).fn);
    expect(await main(["pr", "update", "--help"], ctx)).toBe(0);
    expect(lines.join("\n")).toContain("--append-text");
    expect(await main(["pr"], ctx)).toBe(0);
  });
});

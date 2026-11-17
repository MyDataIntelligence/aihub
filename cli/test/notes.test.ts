import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { weaveNotes } from "../src/lib/notes.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

const TEMPLATE = "## Context\n\n## Story\n\n## Commits\n";
const PR_BASE = "/ferron-org/test-project/_apis/git/repositories/test-repo/pullrequests";

function setup() {
  const { dir } = makeRepo();
  write(dir, ".azuredevops/pull_request_template.md", TEMPLATE);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "chore: template"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["checkout", "-b", "feature/77-export"]);
  write(dir, "export.py", "x = 1\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "feat: export"]);
  return dir;
}

const post = (): Route => ({ method: "POST", match: new RegExp(PR_BASE + "\\?"), respond: () => ({ body: { pullRequestId: 9 } }) });
const routes = (extra: Route[] = []): Route[] => [
  ...extra,
  { match: /_apis\/wit\/workitems\/77\?/, respond: () => ({ body: { fields: { "System.Title": "Export" }, relations: [] } }) },
  { match: new RegExp(PR_BASE + "\\?.*searchCriteria"), respond: () => ({ body: { value: [] } }) },
];

describe("aihub note", () => {
  it("stores notes per branch under .git/aihub/notes, never in the working tree", async () => {
    const dir = setup();
    const { ctx, lines, errs } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["note", "add", "Customer needs CSV because finance reconciles weekly"], ctx)).toBe(0);
    const f = join(tmp(), "n.md");
    writeFileSync(f, "Second note\nover two lines\n");
    expect(await main(["note", "add", "--file", f], ctx)).toBe(0);
    lines.length = 0;
    expect(await main(["note", "list"], ctx)).toBe(0);
    expect(lines.join("\n")).toContain("2 note(s)");
    expect(lines.join("\n")).toContain("1. Customer needs CSV");
    expect(lines.join("\n")).toContain("2. Second note / over two lines");
    expect(existsSync(join(dir, ".git", "aihub", "notes", "feature", "77-export.md"))).toBe(true);
    expect(sh(dir, ["status", "--porcelain"])).toBe("");
    expect(errs).toEqual([]);
    sh(dir, ["checkout", "-b", "other"]);
    lines.length = 0;
    await main(["note", "list"], ctx);
    expect(lines).toEqual(["other: no notes"]);
  });

  it("rejects an empty note", async () => {
    const dir = setup();
    const { ctx, errs } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["note", "add"], ctx)).toBe(1);
    expect(errs[0]).toContain("needs text");
  });

  it("pr create weaves the notes into the context section, not as notes", async () => {
    const dir = setup();
    const { ctx } = ctxFor(dir, fakeFetch([]).fn);
    await main(["note", "add", "Finance reconciles weekly, so the export must be CSV."], ctx);
    const body = join(tmp(), "b.md");
    writeFileSync(body, "## Context\nAdds an export button.\n");
    const f1 = fakeFetch(routes([post()]));
    expect(await main(["pr", "create", "--body-file", body], ctxFor(dir, f1.fn).ctx)).toBe(0);
    const d = f1.calls.find((c) => c.method === "POST")!.body.description as string;
    expect(d).toContain("Adds an export button.\n\nFinance reconciles weekly, so the export must be CSV.");
    expect(d.toLowerCase()).not.toContain("note");
    const f2 = fakeFetch(routes([post()]));
    await main(["pr", "create", "--body-file", body, "--no-notes"], ctxFor(dir, f2.fn).ctx);
    expect(f2.calls.find((c) => c.method === "POST")!.body.description).not.toContain("Finance");
  });

  it("pr update appends the notes once", async () => {
    const dir = setup();
    const { ctx } = ctxFor(dir, fakeFetch([]).fn);
    await main(["note", "add", "Because support asked twice."], ctx);
    let desc = "## Context\n\nAdds export.\n\n## Story\n\nAB#77\n";
    const pr = { pullRequestId: 5, status: "active", sourceRefName: "refs/heads/feature/77-export", targetRefName: "refs/heads/main" };
    const patches: any[] = [];
    const r: Route[] = [
      { match: new RegExp(PR_BASE + "\\?.*searchCriteria"), respond: () => ({ body: { value: [pr] } }) },
      { match: /pullrequests\/5\?/, respond: () => ({ body: { ...pr, description: desc } }) },
      {
        method: "PATCH",
        match: /pullrequests\/5\?/,
        respond: (c) => {
          patches.push(c.body);
          desc = c.body.description;
          return { body: {} };
        },
      },
    ];
    const f = join(tmp(), "u.md");
    writeFileSync(f, "## Story\nAB#77\n");
    const c2 = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pr", "update", "--body-file", f], c2.ctx)).toBe(0);
    expect(await main(["pr", "update", "--body-file", f], c2.ctx)).toBe(0);
    expect(patches[0].description).toContain("Adds export.\n\nBecause support asked twice.");
    expect(patches[1].description.match(/Because support asked twice\./g)).toHaveLength(1);
  });
});

describe("weaveNotes", () => {
  const notes = [{ at: "x", text: "Why: speed." }];
  it("adds to the context section and prepends without one", () => {
    expect(weaveNotes("Free text", ["Context", "Story"], notes)).toBe("## Context\n\nFree text\n\nWhy: speed.\n");
    expect(weaveNotes("Body", ["Story"], notes)).toBe("Why: speed.\n\nBody\n");
    expect(weaveNotes("Body", ["Story"], [])).toBe("Body");
  });
});

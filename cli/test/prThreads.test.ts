import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRepoPr, suggestionBlocks } from "../src/lib/prThreads.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, sh, tmp } from "./helpers.js";

const P = "/ferron-org/test-project/_apis/git/repositories";

function repo() {
  const dir = tmp();
  sh(dir, ["init", "-b", "main"]);
  sh(dir, ["config", "remote.origin.url", "git@ssh.dev.azure.com:v3/ferron-org/test-project/repo-a"]);
  return dir;
}

// orders.py as the reviewer saw it (iteration 1) and as it is now (iteration 2: one line added on top, line 15 rewritten)
const V1 = ["import pandas as pd", "", "def export(day):", "    rows = read(day)", '    rows["customer_number"] = rows["customer_number"].str.strip()', '    rows = rows[rows["amount"].astype(float) > 0]', "    return rows"];
const V2 = ["import pandas as pd", "import numpy as np", "", "def export(day):", "    rows = read(day)", '    rows["customer_number"] = rows["customer_number"].str.strip()', '    rows = rows[pd.to_numeric(rows["amount"], errors="coerce") > 0]', "    return rows"];
const files: Record<string, string[]> = {
  "c1|/notebooks/orders.py": V1,
  "c2|/notebooks/orders.py": V2,
  "c1|/notebooks/old_name.py": ["a = 1", "b = 2"],
  "c2|/notebooks/new_name.py": ["a = 1", "b = 2"],
  "base|/notebooks/removed.py": ["x = 1", "y = 2", "z = 3"],
  "c1|/notebooks/gone.py": ["only = 1"],
  "d1|/config/settings.yaml": ["timeout: 5", "retries: 3"],
};

const who = (name: string, id: string) => ({ displayName: name, id });
const sanne = who("Sanne de Vries", "u-sanne");
const tom = who("Tom Bakker", "u-tom");
const me = who("Test User", "u-me");

const threadsA = [
  {
    id: 11,
    status: "active",
    publishedDate: "2026-11-26T08:00:00Z",
    threadContext: { filePath: "/notebooks/orders.py", rightFileStart: { line: 6 }, rightFileEnd: { line: 6 } },
    pullRequestThreadContext: { iterationContext: { firstComparingIteration: 1, secondComparingIteration: 1 }, trackingCriteria: { origFilePath: "/notebooks/orders.py", origRightFileStart: { line: 5 }, origRightFileEnd: { line: 5 }, secondComparingIteration: 1 } },
    comments: [
      { id: 1, content: "This fails for orders without a customer number. Guard it?\n```suggestion\n    rows[\"customer_number\"] = rows[\"customer_number\"].fillna(\"\").str.strip()\n```", author: sanne, publishedDate: "2026-11-26T08:00:00Z" },
      { id: 2, parentCommentId: 1, content: "Yes, I will apply it.", author: me, publishedDate: "2026-11-26T09:00:00Z" },
    ],
  },
  {
    // the line was rewritten in iteration 2: outdated
    id: 12,
    status: "active",
    threadContext: { filePath: "/notebooks/orders.py", rightFileStart: { line: 7 }, rightFileEnd: { line: 7 } },
    pullRequestThreadContext: { iterationContext: { secondComparingIteration: 1 }, trackingCriteria: { origRightFileStart: { line: 6 }, origRightFileEnd: { line: 6 } } },
    comments: [{ id: 1, content: "astype(float) raises on empty strings.", author: tom, lastUpdatedDate: "2026-11-23T10:00:00Z" }],
  },
  { id: 13, status: "fixed", comments: [{ id: 1, content: "General: please add a test.", author: tom }] },
  { id: 14, status: "active", comments: [{ id: 1, content: "Policy check passed", commentType: "system", author: tom }] },
  {
    id: 15,
    status: "active",
    threadContext: { filePath: "/notebooks/new_name.py", rightFileStart: { line: 2 }, rightFileEnd: { line: 2 } },
    pullRequestThreadContext: { iterationContext: { secondComparingIteration: 1 }, trackingCriteria: { origFilePath: "/notebooks/old_name.py", origRightFileStart: { line: 2 }, origRightFileEnd: { line: 2 } } },
    comments: [{ id: 1, content: "Name b better.", author: sanne }],
  },
  { id: 16, status: "active", threadContext: { filePath: "/notebooks/removed.py", leftFileStart: { line: 2 }, leftFileEnd: { line: 2 } }, comments: [{ id: 1, content: "Why remove y?", author: tom }] },
  {
    id: 17,
    status: "active",
    threadContext: { filePath: "/notebooks/gone.py", rightFileStart: { line: 1 }, rightFileEnd: { line: 1 } },
    pullRequestThreadContext: { iterationContext: { secondComparingIteration: 1 } },
    comments: [{ id: 1, content: "x", author: tom }],
  },
  {
    id: 18,
    status: "active",
    threadContext: { filePath: "/notebooks/orders.py", rightFileStart: { line: 1 }, rightFileEnd: { line: 2 } },
    pullRequestThreadContext: { iterationContext: { secondComparingIteration: 2 } },
    comments: [
      { id: 1, content: "Two options:\n```suggestion\nimport pandas\n```\nor\n```suggestion\nimport pandas as pd\nimport numpy\n```", author: sanne },
      { id: 2, content: "deleted", isDeleted: true, author: tom },
    ],
  },
];
const threadsC = [{ id: 31, status: "active", threadContext: { filePath: "/config/settings.yaml", rightFileStart: { line: 1 } }, pullRequestThreadContext: { iterationContext: { secondComparingIteration: 1 } }, comments: [{ id: 1, content: "A timeout of 5 seconds is too low.", author: tom }] }];

function routes() {
  return [
    { match: /connectionData/, respond: () => ({ body: { authenticatedUser: { id: "u-me", providerDisplayName: "Test User" } } }) },
    { match: new RegExp(`${P}/repo-a/pullrequests/812/iterations\\?`), respond: () => ({ body: { value: [{ id: 1, sourceRefCommit: { commitId: "c1" } }, { id: 2, sourceRefCommit: { commitId: "c2" }, commonRefCommit: { commitId: "base" } }] } }) },
    { match: new RegExp(`${P}/repo-a/pullrequests/812/threads\\?`), respond: () => ({ body: { value: threadsA } }) },
    { match: new RegExp(`${P}/repo-c/pullrequests/813/iterations\\?`), respond: () => ({ body: { value: [{ id: 1, sourceRefCommit: { commitId: "d1" } }] } }) },
    { match: new RegExp(`${P}/repo-c/pullrequests/813/threads\\?`), respond: () => ({ body: { value: threadsC } }) },
    { match: new RegExp(`${P}/repo-x/pullrequests/9/iterations\\?`), respond: () => ({ status: 404, body: { message: "pull request 9 not found" } }) },
    {
      match: /\/items\?/,
      respond: (c: { url: string }) => {
        const u = new URL(c.url);
        const lines = files[`${u.searchParams.get("versionDescriptor.version")}|${u.searchParams.get("path")}`];
        return lines ? { text: lines.join("\r\n") } : { status: 404, body: { message: "not found" } };
      },
    },
  ];
}

const read = async (args: string[]) => {
  const { fn, calls } = fakeFetch(routes() as never);
  const { ctx, lines } = ctxFor(repo(), fn);
  expect(await main(["comments", "threads", ...args], ctx)).toBe(0);
  return { j: JSON.parse(lines[0]), calls };
};

describe("aihub comments threads", () => {
  it("one call for two pull requests in two repositories, with who I am", async () => {
    const { j } = await read(["--pr", "repo-a:812", "--pr", "repo-c:813"]);
    expect(j.me).toEqual({ id: "u-me", name: "Test User" });
    expect(j.prs.map((p: any) => [p.repo, p.pr, p.latestIteration, p.threads.length])).toEqual([["repo-a", 812, 2, 7], ["repo-c", 813, 1, 1]]);
    expect(j.failed).toEqual([]);
  });

  it("asks Azure DevOps to track the positions to the latest iteration", async () => {
    const { calls } = await read(["--pr", "repo-a:812"]);
    const t = calls.find((c) => /threads\?/.test(c.url))!;
    expect(t.url).toContain("%24iteration=2");
    expect(t.url).toContain("%24baseIteration=0");
  });

  it("a thread on a line: position, the lines, the suggestion, authors and times; system threads and deleted comments are left out", async () => {
    const { j } = await read(["--pr", "repo-a:812"]);
    const [a] = j.prs;
    expect(a.threads.map((t: any) => t.threadId)).toEqual([11, 12, 13, 15, 16, 17, 18]);
    const t = a.threads[0];
    expect(t).toMatchObject({ file: "/notebooks/orders.py", side: "right", line: 6, endLine: 6, iteration: 1, outdated: false, open: true });
    expect(t.original).toEqual([V1[4]]);
    expect(t.anchor).toEqual({ start: 4, lines: V2.slice(3, 8) });
    expect(t.comments.map((c: any) => [c.author, c.authorId, c.when, c.parentId])).toEqual([["Sanne de Vries", "u-sanne", "2026-11-26T08:00:00Z", undefined], ["Test User", "u-me", "2026-11-26T09:00:00Z", 1]]);
    expect(t.suggestions).toEqual([{ commentId: 1, old: [V1[4]], new: ['    rows["customer_number"] = rows["customer_number"].fillna("").str.strip()'] }]);
    expect(a.threads.find((x: any) => x.threadId === 18).comments).toHaveLength(1);
  });

  it("outdated: the commented line was rewritten in a later iteration; the original lines are what the reviewer saw", async () => {
    const { j } = await read(["--pr", "repo-a:812"]);
    const t = j.prs[0].threads.find((x: any) => x.threadId === 12);
    expect(t).toMatchObject({ outdated: true, line: 7, original: [V1[5]] });
    expect(t.anchor.lines).toContain(V2[6]);
  });

  it("a general comment has no file and no position; a resolved one is there with open false", async () => {
    const { j } = await read(["--pr", "repo-a:812"]);
    const t = j.prs[0].threads.find((x: any) => x.threadId === 13);
    expect(t).toMatchObject({ status: "fixed", open: false, outdated: false, suggestions: [] });
    expect(t.file).toBeUndefined();
    expect(t.line).toBeUndefined();
  });

  it("a renamed file: the new path, renamedFrom, and the original text from the old path", async () => {
    const { j } = await read(["--pr", "repo-a:812"]);
    const t = j.prs[0].threads.find((x: any) => x.threadId === 15);
    expect(t).toMatchObject({ file: "/notebooks/new_name.py", renamedFrom: "/notebooks/old_name.py", original: ["b = 2"], outdated: false });
  });

  it("a comment on the left side (a removed line): side left, the text from the base, no anchor", async () => {
    const { j } = await read(["--pr", "repo-a:812"]);
    const t = j.prs[0].threads.find((x: any) => x.threadId === 16);
    expect(t).toMatchObject({ side: "left", line: 2, original: ["y = 2"] });
    expect(t.anchor).toBeUndefined();
  });

  it("a file that is not in the latest iteration any more is fileDeleted", async () => {
    const { j } = await read(["--pr", "repo-a:812"]);
    expect(j.prs[0].threads.find((x: any) => x.threadId === 17)).toMatchObject({ fileDeleted: true, original: ["only = 1"] });
  });

  it("several suggestions in one comment, each with the commented lines as old", async () => {
    const { j } = await read(["--pr", "repo-a:812"]);
    const t = j.prs[0].threads.find((x: any) => x.threadId === 18);
    expect(t.suggestions).toEqual([
      { commentId: 1, old: V2.slice(0, 2), new: ["import pandas"] },
      { commentId: 1, old: V2.slice(0, 2), new: ["import pandas as pd", "import numpy"] },
    ]);
  });

  it("one pull request that cannot be read does not hide the others", async () => {
    const { j } = await read(["--pr", "repo-a:812", "--pr", "repo-x:9"]);
    expect(j.prs.map((p: any) => p.pr)).toEqual([812]);
    expect(j.failed[0]).toMatchObject({ repo: "repo-x", pr: 9 });
  });

  it("fetches one file at one commit once", async () => {
    const { calls } = await read(["--pr", "repo-a:812"]);
    const items = calls.filter((c) => c.url.includes("/items?")).map((c) => c.url);
    expect(new Set(items).size).toBe(items.length);
  });
});

describe("aihub comments reply --return-threads", () => {
  it("posts and gives the changed thread back in the editor shape, in the same process", async () => {
    const { fn, calls } = fakeFetch([
      { method: "POST", match: /threads\/11\/comments\?/, respond: () => ({ body: { id: 3 } }) },
      { method: "PATCH", match: /threads\/11\?/, respond: () => ({ body: {} }) },
      { match: new RegExp(`${P}/repo-a/pullrequests/812\\?`), respond: () => ({ body: { pullRequestId: 812, status: "active" } }) },
      ...routes(),
    ] as never);
    const dir = repo();
    const f = join(dir, "r.yaml");
    writeFileSync(f, "- threadId: 11\n  text: |\n    Done.\n    Second line.\n  status: fixed\n");
    const { ctx, lines } = ctxFor(dir, fn);
    expect(await main(["comments", "reply", "--pr", "812", "--replies-file", f, "--return-threads", "--json"], ctx)).toBe(0);
    const j = JSON.parse(lines[0]);
    expect(j.replied).toEqual([11]);
    expect(j.threads.map((t: any) => t.threadId)).toEqual([11]);
    expect(calls.find((c) => c.method === "POST")!.body.content).toBe("Done.\nSecond line.");
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ status: "fixed" });
  });
});

describe("helpers", () => {
  it("parseRepoPr and suggestionBlocks", () => {
    expect(parseRepoPr("repo-a:812")).toEqual({ repo: "repo-a", pr: 812 });
    expect(parseRepoPr("812")).toEqual({ pr: 812 });
    expect(suggestionBlocks("```suggestion\n```")).toEqual([[]]);
    expect(suggestionBlocks("no block")).toEqual([]);
  });
});

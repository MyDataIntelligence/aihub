import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReplies } from "../src/lib/comments.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, fixture, fixtureText, sh, tmp } from "./helpers.js";

const PR = "/ferron-org/test-project/_apis/git/repositories/test-repo/pullrequests/42";
const prBody = {
  pullRequestId: 42,
  title: "t",
  status: "active",
  sourceRefName: "refs/heads/feature/1-x",
  targetRefName: "refs/heads/main",
  lastMergeSourceCommit: { commitId: "abc123" },
};

function repo() {
  const dir = tmp();
  sh(dir, ["init", "-b", "main"]);
  sh(dir, ["config", "remote.origin.url", "git@ssh.dev.azure.com:v3/ferron-org/test-project/test-repo"]);
  return dir;
}

const routes = (extra: any[] = []) => [
  ...extra,
  { match: new RegExp(PR + "\\?"), respond: () => ({ body: prBody }) },
  { match: new RegExp(PR + "/threads\\?"), respond: () => ({ body: fixture("threads.json") }) },
  { match: /repositories\/test-repo\/items\?/, respond: () => ({ text: fixtureText("app.py") }) },
];

describe("aihub comments get", () => {
  it("shows open threads compactly with the code around the line", async () => {
    const { fn, calls } = fakeFetch(routes());
    const { ctx, lines } = ctxFor(repo(), fn);
    expect(await main(["comments", "get", "--pr", "42"], ctx)).toBe(0);
    expect(lines[0]).toBe(
      [
        "!42: 2 threads",
        "[7] /src/app.py:3 (active) Anna Test: Waarom geen controle op ë-tekens? / Graag toelichten.",
        "       1 def run():",
        "       2     naam = \"Zoë\"",
        "  >    3     return naam",
        "       4 ",
        "    - Ben Test: Goede vraag, +1",
        "[9] (general) (active) Ben Test: Algemene opmerking",
      ].join("\n"),
    );
    const itemsCall = calls.find((c) => c.url.includes("/items?"))!;
    expect(itemsCall.url).toContain("versionDescriptor.version=abc123");
  });

  it("--include-resolved adds fixed threads; --json is structured", async () => {
    const { fn } = fakeFetch(routes());
    const { ctx, lines } = ctxFor(repo(), fn);
    await main(["comments", "get", "--pr", "42", "--include-resolved", "--json"], ctx);
    const j = JSON.parse(lines[0]);
    expect(j.threads.map((t: any) => t.threadId)).toEqual([7, 8, 9]);
    expect(j.threads[0].code.find((c: any) => c.n === 3).text).toBe("    return naam");
    expect(j.threads[0].comments[0].author).toBe("Anna Test");
  });
});

describe("aihub comments reply", () => {
  it("parses and validates the yaml list", () => {
    expect(parseReplies("- threadId: 7\n  text: Opgelost\n  status: fixed\n- threadId: 9\n  status: closed\n")).toEqual([
      { threadId: 7, text: "Opgelost", status: "fixed" },
      { threadId: 9, text: undefined, status: "closed" },
    ]);
    expect(() => parseReplies("- threadId: 7\n  status: done\n  text: x\n")).toThrow(/status 'done'/);
    expect(() => parseReplies("- text: x\n")).toThrow(/threadId/);
    expect(() => parseReplies("- threadId: 7\n")).toThrow(/text and\/or status/);
  });

  it("posts a reply and sets the status, UTF-8 intact", async () => {
    const f = join(tmp(), "replies.yaml");
    writeFileSync(f, "- threadId: 7\n  text: \"Aangepast: controle op ë, é en ü toegevoegd.\"\n  status: fixed\n- threadId: 9\n  text: Bewust zo gelaten.\n  status: wontFix\n", "utf8");
    const { fn, calls } = fakeFetch(
      routes([
        { method: "POST", match: new RegExp(PR + "/threads/\\d+/comments\\?"), respond: () => ({ body: { id: 3 } }) },
        { method: "PATCH", match: new RegExp(PR + "/threads/\\d+\\?"), respond: () => ({ body: {} }) },
      ]),
    );
    const { ctx, lines } = ctxFor(repo(), fn);
    expect(await main(["comments", "reply", "--pr", "42", "--replies-file", f], ctx)).toBe(0);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0].url).toContain("/threads/7/comments");
    expect(posts[0].body).toEqual({ content: "Aangepast: controle op ë, é en ü toegevoegd.", parentCommentId: 1, commentType: "text" });
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches.map((p) => p.body.status)).toEqual(["fixed", "wontFix"]);
    expect(lines).toEqual(["!42: 2 replies posted (7=fixed, 9=wontFix)"]);
  });
});

describe("replies file aliases", () => {
  it("accepts thread: / id: and resolve: true (agents write them naturally) next to threadId / status", async () => {
    const { parseReplies } = await import("../src/lib/comments.js");
    expect(parseReplies("- thread: 7\n  text: ok\n  resolve: true\n- id: 8\n  text: nee\n  status: wontfix\n- threadId: 9\n  text: x\n  resolve: false\n")).toEqual([
      { threadId: 7, text: "ok", status: "fixed" },
      { threadId: 8, text: "nee", status: "wontFix" },
      { threadId: 9, text: "x", status: undefined },
    ]);
  });
});

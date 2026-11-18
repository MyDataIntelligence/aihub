import { describe, expect, it } from "vitest";
import { main, mergeDashValues } from "../src/router.js";
import { parseInlineReply } from "../src/lib/comments.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

describe("parseInlineReply", () => {
  it("<threadId>:<status>:<text>, the text may contain colons; status may be empty", () => {
    expect(parseInlineReply("7:fixed:Aangepast: null-check toegevoegd.")).toEqual({ threadId: 7, text: "Aangepast: null-check toegevoegd.", status: "fixed" });
    expect(parseInlineReply("8::Alleen een antwoord")).toEqual({ threadId: 8, text: "Alleen een antwoord", status: undefined });
    expect(parseInlineReply("9:closed:")).toEqual({ threadId: 9, text: undefined, status: "closed" });
  });
  it("explains a wrong shape or status", () => {
    expect(() => parseInlineReply("fixed:x")).toThrow(/<threadId>:<status>:<text>/);
    expect(() => parseInlineReply("7:resolved:x")).toThrow(/status 'resolved' must be one of fixed\|wontFix\|closed\|active/);
    expect(() => parseInlineReply("7::")).toThrow(/needs text and\/or status/);
  });
});

describe("mergeDashValues", () => {
  it("joins a value that starts with '- ' (a markdown bullet) to its option; leaves real options alone", () => {
    expect(mergeDashValues(["--section", "Changes", "--append-text", "- a bullet", "--json"])).toEqual(["--section", "Changes", "--append-text=- a bullet", "--json"]);
    expect(mergeDashValues(["--pr", "5", "--json", "--no-notes"])).toEqual(["--pr", "5", "--json", "--no-notes"]);
    expect(mergeDashValues(["--text=- x"])).toEqual(["--text=- x"]);
  });
});

describe("aihub comments reply --reply (live: opencode's agent may not write a file through bash)", () => {
  const PR = "/ferron-org/test-project/_apis/git/repositories/test-repo/pullrequests/42";
  const routes: Route[] = [
    { match: new RegExp(PR + "\\?"), respond: () => ({ body: { pullRequestId: 42, status: "active", sourceRefName: "refs/heads/f", targetRefName: "refs/heads/main" } }) },
    { method: "POST", match: new RegExp(PR + "/threads/\\d+/comments\\?"), respond: () => ({ body: { id: 3 } }) },
    { method: "PATCH", match: new RegExp(PR + "/threads/\\d+\\?"), respond: () => ({ body: {} }) },
  ];

  it("posts every --reply with its status in one call, no file", async () => {
    const { fn, calls } = fakeFetch(routes);
    const { ctx, lines } = ctxFor(makeRepo().dir, fn);
    expect(await main(["comments", "reply", "--pr", "42", "--reply", "7:fixed:Aangepast: ë, é", "--reply", "9:wontFix:Bewust zo."], ctx)).toBe(0);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((p) => p.body.content)).toEqual(["Aangepast: ë, é", "Bewust zo."]);
    expect(calls.filter((c) => c.method === "PATCH").map((p) => p.body.status)).toEqual(["fixed", "wontFix"]);
    expect(lines).toEqual(["!42: 2 replies posted (7=fixed, 9=wontFix)"]);
  });

  it("needs a file or a --reply", async () => {
    const { ctx, errs } = ctxFor(makeRepo().dir, fakeFetch(routes).fn);
    expect(await main(["comments", "reply", "--pr", "42"], ctx)).toBe(1);
    expect(errs.join("\n")).toContain("--replies-file");
  });
});

import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiOf, appOf, boardOf, boardProblem, parseAnswer, pushBoard, pushToIDiagram, storyFor, storyProblem, trusted } from "../src/lib/idiagram.js";
import { afterPrOffer } from "../src/lib/learnProfile.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

const MERMAID = "flowchart LR\n  A[Bedrag] --> B[Minimum]:::changed --> C[Cap]:::changed --> D{klaar?}";
const pack = (board: unknown) => Buffer.from(deflateRawSync(Buffer.from(JSON.stringify(board)))).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const URL_OK = `https://idiagram.vercel.app/#board=${pack({ board: { name: "Betaalkosten", story: { scenes: [{}] } } })}`;
const ANSWER = { link: { url: URL_OK, playUrl: `${URL_OK}&play=1` }, board: { nodes: 4, edges: 3 }, issues: [{ code: "story.node", message: "scene 2 names an unknown block" }, { code: "x", message: "ignored" }] };

describe("iDiagram client (port of the legacy IDiagramClient)", () => {
  it("uses the default app, or AIHUB_IDIAGRAM_URL with or without /api/v1", () => {
    expect(apiOf({})).toBe("https://idiagram.vercel.app/api/v1");
    expect(apiOf({ AIHUB_IDIAGRAM_URL: "http://localhost:4000/" })).toBe("http://localhost:4000/api/v1");
    expect(appOf({ AIHUB_IDIAGRAM_URL: "http://localhost:4000/api/v1" })).toBe("http://localhost:4000");
  });

  it("only trusts https links of the app itself (or a local one)", () => {
    expect(trusted(URL_OK, {})).toBe(true);
    expect(trusted("https://evil.example.com/#board=x", {})).toBe(false);
    expect(trusted("https://user@idiagram.vercel.app/", {})).toBe(false);
    expect(trusted("http://idiagram.vercel.app/", {})).toBe(false);
    expect(trusted("http://localhost:4000/#board=x", { AIHUB_IDIAGRAM_URL: "http://localhost:4000" })).toBe(true);
  });

  it("builds a story: the whole flow, then one scene per changed block; flowcharts only", () => {
    const s = storyFor(MERMAID, "Betaalkosten")!;
    expect(s.scenes.map((x) => x.title)).toEqual(["De hele flow", "Minimum", "Cap"]);
    expect(s.scenes[0].nodes).toEqual(["*"]);
    expect(s.scenes[1].nodes).toEqual(["B"]);
    expect(storyFor("sequenceDiagram\n A->>B: x", "t")).toBeUndefined();
  });

  it("reads the board out of the link (base64url of deflate-raw JSON)", () => {
    expect(boardOf(URL_OK)?.board?.name).toBe("Betaalkosten");
    expect(boardOf("https://idiagram.vercel.app/#board=@@@")).toBeUndefined();
  });

  it("parses the answer: links, counts, story warnings, proof that the story is in the link", () => {
    const r = parseAnswer(200, JSON.stringify(ANSWER), {});
    expect(r).toMatchObject({ status: "created", url: URL_OK, playUrl: `${URL_OK}&play=1`, nodes: 4, edges: 3, storyInLink: true, boardName: "Betaalkosten", storyWarnings: ["scene 2 names an unknown block"] });
    expect(parseAnswer(500, "{}", {}).reason).toContain("answered 500");
    expect(parseAnswer(200, JSON.stringify({ link: { url: "https://evil.example.com/" } }), {}).reason).toContain("outside the app");
    expect(parseAnswer(200, JSON.stringify({ link: {} }), {}).status).toBe("failed");
    expect(parseAnswer(422, JSON.stringify({ error: { message: "bad mermaid" } }), {}).reason).toContain("bad mermaid");
  });

  it("posts only Mermaid and the story to /import; failures are results", async () => {
    const route: Route = { method: "POST", match: /idiagram\.vercel\.app\/api\/v1\/import\?output=summary/, respond: () => ({ body: ANSWER }) };
    const f = fakeFetch([route]);
    const { ctx } = ctxFor(tmp(), f.fn);
    const story = storyFor(MERMAID, "Betaalkosten");
    const r = await pushToIDiagram(ctx, { id: "arch-1", mermaid: MERMAID, story });
    expect(r).toMatchObject({ status: "created", scenes: 3 });
    expect(Object.keys(f.calls[0].body).sort()).toEqual(["filename", "outputs", "story", "text"]);
    expect(f.calls[0].body.text).toBe(MERMAID);
    expect((await pushToIDiagram(ctx, { id: "s", mermaid: "sequenceDiagram\n A->>B: x" })).status).toBe("unsupported");
    const down = ctxFor(tmp(), (async () => {
      throw new Error("offline");
    }) as never).ctx;
    expect((await pushToIDiagram(down, { id: "x", mermaid: MERMAID })).status).toBe("failed");
  });

  it("learn diagram --idiagram returns the board and play links", async () => {
    const { dir } = makeRepo();
    write(dir, "dbt/dbt_project.yml", "name: d\n");
    write(dir, "dbt/models/a.sql", "select 1\n");
    write(dir, "dbt/models/b.sql", "select * from {{ ref('a') }}\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "dbt"]);
    const f = fakeFetch([{ method: "POST", match: /\/api\/v1\/import/, respond: () => ({ body: ANSWER }) }]);
    const a = ctxFor(dir, f.fn);
    expect(await main(["learn", "diagram", "--kind", "lineage", "--idiagram", "--json"], a.ctx)).toBe(0);
    expect(JSON.parse(a.lines.join("\n")).idiagram).toMatchObject({ status: "created", url: URL_OK, playUrl: `${URL_OK}&play=1` });
    const t = ctxFor(dir, f.fn);
    await main(["learn", "diagram", "--kind", "lineage", "--idiagram"], t.ctx);
    expect(t.lines.join("\n")).toContain("Play story: ");
  });
});

describe("level and afterPr", () => {
  const run = async (dir: string, h: string, args: string[]) => {
    const f = fakeFetch([]);
    const { ctx, lines, errs } = ctxFor(dir, f.fn);
    ctx.env = { ...ctx.env, AIHUB_LEARN_HOME: h };
    const code = await main(args, ctx);
    return { code, out: lines.join("\n"), errs: errs.join("\n"), ctx };
  };

  it("level defaults to medior, can be set, and gives the skill its style", async () => {
    const { dir } = makeRepo();
    const h = tmp("aihub-learn-");
    expect(JSON.parse((await run(dir, h, ["learn", "level", "--json"])).out)).toMatchObject({ level: "medior", afterPr: false, afterPrSource: "default" });
    const set = JSON.parse((await run(dir, h, ["learn", "level", "set", "junior", "--json"])).out);
    expect(set.level).toBe("junior");
    expect(set.style).toContain("everyday analogy");
    expect(JSON.parse((await run(dir, h, ["learn", "level", "--json"])).out).level).toBe("junior");
    const bad = await run(dir, h, ["learn", "level", "set", "guru"]);
    expect(bad.code).toBe(1);
    expect(bad.errs).toContain("junior, medior, senior");
  });

  it("afterPr is off by default, on from team.yaml, and the user's choice wins", async () => {
    const { dir } = makeRepo();
    const h = tmp("aihub-learn-");
    expect(JSON.parse((await run(dir, h, ["learn", "after-pr", "--json"])).out)).toMatchObject({ afterPr: false, afterPrSource: "default" });
    write(dir, ".agents/skills/_shared/references/team.yaml", "learn:\n  afterPr: true\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "team"]);
    expect(JSON.parse((await run(dir, h, ["learn", "after-pr", "--json"])).out)).toMatchObject({ afterPr: true, afterPrSource: "team" });
    await run(dir, h, ["learn", "after-pr", "off"]);
    expect(JSON.parse((await run(dir, h, ["learn", "after-pr", "--json"])).out)).toMatchObject({ afterPr: false, afterPrSource: "user" });
  });

  it("the offer is one line, only when afterPr is on", async () => {
    const { dir } = makeRepo();
    const h = tmp("aihub-learn-");
    const off = await run(dir, h, ["learn", "after-pr"]);
    expect(afterPrOffer(off.ctx)).toBe("");
    const on = await run(dir, h, ["learn", "after-pr", "on"]);
    expect(afterPrOffer(on.ctx)).toBe("Wil je een les van deze wijziging? Zeg /leer (of: aihub learn change --json).");
    await run(dir, h, ["learn", "after-pr", "off"]);
    expect(afterPrOffer(on.ctx)).toBe("");
  });
});

const MERM = "flowchart LR" + String.fromCharCode(10) + "  a --> b";
const BOARD = JSON.parse(readFileSync(join(__dirname, "../../skills/learn/references/board-example.json"), "utf8"));
const STORY = JSON.parse(readFileSync(join(__dirname, "../../skills/learn/references/story-example.json"), "utf8"));

describe("the rich board path (/boards/build)", () => {
  it("checks the board shape and size like the legacy prepareBoard, and the story scenes", () => {
    expect(boardProblem(BOARD)).toBeUndefined();
    expect(boardProblem({ nodes: [] })).toContain("1 to 200 nodes");
    expect(boardProblem({ nodes: Array.from({ length: 201 }, (_, i) => ({ id: String(i) })) })).toContain("1 to 200 nodes");
    expect(boardProblem("x")).toContain("iDiagram board spec");
    expect(storyProblem(STORY)).toBeUndefined();
    expect(storyProblem({ scenes: [] })).toContain("1 to 12 scenes");
    expect(storyProblem({ scenes: [{ title: "x" }] })).toContain("scene 1 needs a title and nodes");
  });

  it("posts spec, outputs link+mermaid and the story to /boards/build and returns the links and the Mermaid fallback", async () => {
    const f = fakeFetch([{ method: "POST", match: /\/api\/v1\/boards\/build\?output=summary/, respond: () => ({ body: { ...ANSWER, mermaid: MERM } }) }]);
    const { ctx } = ctxFor(tmp(), f.fn);
    const r = await pushBoard(ctx, { board: BOARD, story: STORY });
    expect(r).toMatchObject({ status: "created", scenes: 3, mermaid: MERM, url: URL_OK });
    expect(f.calls[0].body).toEqual({ spec: BOARD, outputs: ["link", "mermaid"], story: STORY });
    expect((await pushBoard(ctx, { board: { nodes: [] } })).reason).toContain("iDiagram board spec");
    expect(f.calls).toHaveLength(1);
  });

  it("learn diagram --board reads the files and prints the picture and the links", async () => {
    const dir = makeRepo().dir;
    const d = tmp();
    writeFileSync(join(d, "b.json"), JSON.stringify(BOARD));
    writeFileSync(join(d, "s.json"), JSON.stringify(STORY));
    const f = fakeFetch([{ method: "POST", match: /boards\/build/, respond: () => ({ body: { ...ANSWER, mermaid: MERM } }) }]);
    const t = ctxFor(dir, f.fn);
    expect(await main(["learn", "diagram", "--board", join(d, "b.json"), "--story", join(d, "s.json")], t.ctx)).toBe(0);
    const out = t.lines.join(String.fromCharCode(10));
    expect(out).toContain("SCD2: een adreswijziging");
    expect(out).toContain("flowchart LR");
    expect(out).toContain("Play story: ");
    const bad = ctxFor(dir, f.fn);
    expect(await main(["learn", "diagram", "--board", join(d, "nope.json")], bad.ctx)).toBe(1);
  });
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { htmlToMd, mdToHtml } from "../src/lib/story.js";
import { criterionKey, howKind, parseCriteria, renderCriteria, vagueness } from "../src/lib/e2e/criteria.js";
import { ACTIONS, checkAction, conditionals, fill, findPrompt, listPrompts, renderPrompt, resetPrompt, runOptions, savePrompt, TEAM_PROMPT_DIR } from "../src/lib/e2e/prompts.js";
import { storyActivate } from "../src/lib/stories/write.js";
import { criteriaTable, notProvenError, provenLine, withCriteria } from "../src/lib/e2e/prSection.js";
import { LIMIT_DENY, progress, stepsView, yolo } from "../src/lib/e2e/run.js";
import { setFolderOf, stateFile } from "../src/lib/e2e/state.js";
import { criteriaApply, criteriaProposal, criteriaRecord, criteriaStatus, proposalFileFor, readCriteria, statusOf } from "../src/lib/e2e/workitem.js";
import { tmp } from "./helpers.js";
import { setup } from "./storiesWorld.js";

const CRIT = `1. Als ik een datum kies, bevat het bestand alle orders van die kalenderdag (Europe/Amsterdam).
   Hoe getest: Data-check: count(csv) = count(stg_orders) voor 24-11
   Bewijs: Query en uitkomst

2. Het bestand heet orders_YYYY-MM-DD.csv en gebruikt ; als scheidingsteken.
   Hoe getest: Fabric-run: run in de feature-workspace, lees de eerste regel
   Bewijs: Bestandsnaam en eerste regel, met runlink

3. Testorders (is_test_order) staan er niet in.
   Hoe getest: Data-check: count(is_test_order = 1) = 0
   Bewijs: Query en uitkomst: 0 testorders`;

/** The synthetic world with story 101 carrying the three criteria above in its criteria field, run inside a set folder. */
function world() {
  const t = setup();
  t.items[101].fields["Microsoft.VSTS.Common.AcceptanceCriteria"] = mdToHtml(CRIT);
  const set = join(t.empty, "101-orderexport");
  mkdirSync(set, { recursive: true });
  writeFileSync(join(set, ".aihub-set.json"), JSON.stringify({ story: 101, branch: "feature/101-orderexport", repos: [{ name: "repo-a", source: "x", path: join(set, "repo-a") }] }));
  t.ctx.cwd = set;
  // this world is a Dutch team (its criteria and prompts are Dutch): team.yaml says so, aihub assumes no language
  const s = (refresh = false) => {
    const x = t.s(refresh);
    x.teamCfg = { language: "nl", ...x.teamCfg };
    return x;
  };
  return { ...t, set, s };
}

describe("acceptance criteria text", () => {
  it("reads criteria with how tested and proof, and writes them back the same", () => {
    const c = parseCriteria(CRIT);
    expect(c.map((x) => [x.n, howKind(x.how), !!x.proof])).toEqual([
      [1, "Data-check", true],
      [2, "Fabric-run", true],
      [3, "Data-check", true],
    ]);
    expect(renderCriteria(c, "nl")).toBe(CRIT);
    expect(parseCriteria(renderCriteria(c, "en"))[1].how).toBe("Fabric-run: run in de feature-workspace, lees de eerste regel");
  });

  it("survives the HTML of the work item field", () => {
    expect(parseCriteria(htmlToMd(mdToHtml(CRIT)))).toEqual(parseCriteria(CRIT));
  });

  it("plain bullets are criteria too; vague ones are named", () => {
    const c = parseCriteria("- [ ] De export is snel.\n- [x] Een lege export heeft alleen de kopregel\n  Hoe getest: Unit-test: test_export_zonder_orders\n  Bewijs: groen in de pipeline");
    expect(c.map((x) => x.text)).toEqual(["De export is snel.", "Een lege export heeft alleen de kopregel"]);
    expect(vagueness(c[0], "nl")).toBe('wat is "snel"?');
    expect(vagueness({ n: 1, text: "Klaar binnen 30 seconden voor 10.000 orders, snel", how: "x", proof: "y" })).toBeUndefined();
    expect(vagueness(c[1])).toBeUndefined();
    expect(vagueness({ n: 1, text: "Het bestand heeft een kopregel" }, "en")).toBe("How tested is missing");
    expect(criterionKey("A  b")).toBe(criterionKey("a b"));
  });
});

describe("criteria on the work item and their test status", () => {
  it("reads the criteria field; records per criterion in the set folder; a pass needs evidence", async () => {
    const t = world();
    const s = t.s();
    const c = await readCriteria(s, 101);
    expect(c.criteria.length).toBe(3);
    expect(c.field).toBe("Microsoft.VSTS.Common.AcceptanceCriteria");
    expect(setFolderOf(join(t.set, "repo-a", "src"))).toBe(t.set);
    await expect(criteriaRecord(t.ctx, s, { id: 101, criterion: 1, result: "pass" })).rejects.toThrow(/needs --evidence/);
    await expect(criteriaRecord(t.ctx, s, { id: 101, criterion: 4, result: "pass", evidence: "x" })).rejects.toThrow(/has 3 criteria/);
    const st = await criteriaRecord(t.ctx, s, { id: 101, criterion: 1, result: "pass", evidence: "https://dev.azure.com/ferron-test/test-project/_build/results?buildId=7", reason: "1.204 van 1.204 orders" });
    expect(st.stateFile).toBe(join(t.set, ".aihub-criteria-101.json"));
    await criteriaRecord(t.ctx, s, { id: 101, criterion: 3, result: "fail", reason: "2 testorders" });
    const now = await criteriaStatus(t.ctx, s, 101);
    expect([now.proven, now.total]).toEqual([1, 3]);
    expect(now.criteria.map((x) => x.result)).toEqual(["pass", "notrun", "fail"]);
    // a changed criterion text has no status anymore
    const moved = statusOf(st.stateFile, 101, [{ n: 1, text: "Een ander criterium" }]);
    expect(moved.criteria[0].result).toBe("notrun");
  });

  it("the proposal of /story-criteria next to the current ones; apply writes only the ticked rows with the revision test", async () => {
    const t = world();
    const s = t.s();
    await expect(criteriaProposal(s, 101)).rejects.toThrow(/no criteria proposal yet/);
    writeFileSync(proposalFileFor(s, 101), `${CRIT.replace("staan er niet in.", "staan er niet in (0 rijen).")}\n\n4. De export is snel.\n   Hoe getest: Fabric-run: duur van de run`);
    const p = await criteriaProposal(s, 101);
    expect(p.rows.map((r) => [r.n, r.changed, r.isNew, r.vague ?? ""])).toEqual([
      [1, false, false, ""],
      [2, false, false, ""],
      [3, true, false, ""],
      [4, true, true, 'wat is "snel"?'],
    ]);
    expect(t.written).toEqual([]);
    const r = await criteriaApply(s, { id: 101, rev: 4, take: [3] });
    expect(r).toMatchObject({ status: "saved", criteria: 3 });
    const ops = t.written[0].body as { path: string; value: string }[];
    expect(ops.map((o) => o.path)).toEqual(["/rev", "/fields/Microsoft.VSTS.Common.AcceptanceCriteria"]);
    const saved = parseCriteria(htmlToMd(ops[1].value));
    expect(saved.map((x) => x.text)).toEqual([
      "Als ik een datum kies, bevat het bestand alle orders van die kalenderdag (Europe/Amsterdam).",
      "Het bestand heet orders_YYYY-MM-DD.csv en gebruikt ; als scheidingsteken.",
      "Testorders (is_test_order) staan er niet in (0 rijen).",
    ]);
    expect(saved[2].how).toBe("Data-check: count(is_test_order = 1) = 0");
  });
});

describe("team prompts", () => {
  it("every action has a default prompt with a title, a slash command and the limits", () => {
    const t = setup();
    const l = listPrompts(t.ctx, t.s());
    expect(l.prompts.map((x) => x.action)).toEqual([...ACTIONS]);
    for (const p of l.prompts) {
      expect(p.source).toBe("default");
      expect(p.slash).toBe(`/${p.action}`);
      expect(readFileSync(p.file, "utf8")).toContain("{{limits}}");
    }
    expect(() => checkAction("story-deploy")).toThrow(/unknown action/);
    expect(checkAction("/story-run")).toBe("story-run");
  });

  it("fills the placeholders from the story, its criteria, its set and team.yaml; unknown ones stay and are named", async () => {
    const t = world();
    const s = t.s();
    s.teamCfg = { language: "nl", repositories: [{ name: "repo-a", defaultTarget: "staging" }], fabric: { workspaces: [{ name: "ws-feature-101", environment: "feature", branches: ["feature/101-*"] }, { name: "ACC-x", environment: "acc", branches: ["feature/*"] }] } } as never;
    const r = await renderPrompt(t.ctx, s, "story-run", 101);
    expect(r.source).toBe("default");
    expect(r.text).toContain("Maak User Story #101 bench-a1b2c3 Export the orders report af");
    expect(r.text).toContain("naar staging");
    expect(r.text).toContain("Feature-branch: feature/101-orderexport");
    expect(r.text).toContain("Repos: repo-a (feature/101-orderexport)");
    expect(r.text).toContain("Fabric-workspace van de feature: ws-feature-101");
    expect(r.text).toContain("     Hoe getest: Fabric-run: run in de feature-workspace");
    expect(r.text).toContain("Taken: #201 Write the export (klaar), #202 Test the export");
    expect(r.text).toContain("Nooit pushen naar of mergen in main of staging. Nooit ACC of PRD. Alleen de Fabric-workspace van de featurebranch (ws-feature-101).");
    expect(r.text).not.toMatch(/\{\{/);
    expect(r.unknown).toEqual([]);
    expect(r.summary.goal).toBe("Een groene pull request naar staging met alle acceptatiecriteria bewezen.");
    expect(r.filled.find((f) => f.name === "criteria.count")?.value).toBe("3");
    expect(fill("{{a}} {{b.c}}", { a: "1" })).toEqual({ text: "1 {{b.c}}", filled: [{ name: "a", value: "1" }], unknown: ["b.c"] });
  });

  it("an English team gets the English default and labels", async () => {
    const t = world();
    const s = t.s();
    s.teamCfg = { language: "en" } as never;
    const r = await renderPrompt(t.ctx, s, "story-run", 101);
    expect(r.file.split("\\").join("/")).toMatch(/prompts\/en\/story-run\.md$/);
    expect(r.text).toContain("Finish User Story #101");
    expect(r.text).toContain("     How tested: Fabric-run");
    expect(r.text).toContain("Never push to or merge into main or staging.");
    expect(r.unknown).toEqual([]);
  });

  it("the team's prompt wins over the default; a prompt edited for one story wins until it is reset", async () => {
    const t = world();
    const s = t.s();
    const repo = join(t.set, "repo-a");
    mkdirSync(join(repo, TEAM_PROMPT_DIR), { recursive: true });
    writeFileSync(join(repo, TEAM_PROMPT_DIR, "story-test-fabric.md"), "---\ntitle: Test op Fabric (team)\n---\nTest #{{story.id}} in {{workspace}}.\n");
    expect(findPrompt(s, "story-test-fabric", { set: t.set }).source).toBe("team");
    expect((await renderPrompt(t.ctx, s, "story-test-fabric", 101)).text).toBe("Test #101 in (geen Fabric-workspace in team.yaml).\n");
    savePrompt(s, 101, "story-test-fabric", "Eigen prompt voor #101.");
    const own = await renderPrompt(t.ctx, s, "story-test-fabric", 101);
    expect([own.source, own.text, own.title]).toEqual(["story", "Eigen prompt voor #101.\n", "Test op Fabric (team)"]);
    expect(resetPrompt(s, 101, "story-test-fabric")).toEqual({ reset: true });
    expect((await renderPrompt(t.ctx, s, "story-test-fabric", 101)).source).toBe("team");
  });

  it("aihub prompt render prints the prompt for the agent, --json for the bar", async () => {
    const t = world();
    t.lines.length = 0;
    expect(await main(["prompt", "render", "story-explain", "--id", "101"], t.ctx)).toBe(0);
    expect(t.lines[0]).toMatch(/^# Explain Story/);
    t.lines.length = 0;
    expect(await main(["prompt", "render", "nope", "--id", "101", "--json"], t.ctx)).toBe(1);
    expect(JSON.parse(t.lines[0]).error.kind).toBe("badInput");
  });
});

describe("pull request section", () => {
  const st = (results: ("pass" | "fail" | "notrun")[]) =>
    statusOf(join(tmp(), "none.json"), 101, parseCriteria(CRIT)) && {
      id: 101,
      total: 3,
      proven: results.filter((r) => r === "pass").length,
      stateFile: "x",
      criteria: parseCriteria(CRIT).map((c, i) => ({ ...c, result: results[i], ...(results[i] === "pass" ? { evidence: `https://dev.azure.com/ferron-test/test-project/_build/results?buildId=${i}`, reason: "ok" } : {}), ...(results[i] === "notrun" ? { reason: "de Fabric-run draaide niet" } : {}) })),
    };

  it("a table per criterion with how tested, outcome and link; honestly 'Nog niet uitgevoerd'", () => {
    const t = criteriaTable(st(["pass", "pass", "notrun"]), "nl");
    const rows = t.split("\n");
    expect(rows[0]).toBe("| Criterium | Hoe getest | Uitkomst | Link |");
    expect(rows[2]).toContain("| Data-check | Geslaagd: ok | [run 0](https://dev.azure.com/ferron-test/test-project/_build/results?buildId=0) |");
    expect(rows[3]).toContain("Het bestand heet orders_YYYY-MM-DD.csv en gebruikt ; als scheidingsteken.");
    expect(rows[4]).toContain("| Data-check | Nog niet uitgevoerd: de Fabric-run draaide niet | — |");
  });

  it("N/M on top and the section after the first one; an existing criteria section of the template is replaced", () => {
    const d = withCriteria("## Samenvatting\n\nDe export.\n\n## Tests\n\nNog niet uitgevoerd.\n", st(["pass", "pass", "pass"]), "nl");
    expect(d.split("\n")[0]).toBe("**3/3 acceptatiecriteria bewezen**");
    expect([...d.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(["Samenvatting", "Acceptatiecriteria", "Tests"]);
    const again = withCriteria(d, st(["pass", "pass", "notrun"]), "nl");
    expect(again.split("\n")[0]).toBe("> **Let op: 1 criterium niet bewezen** (2/3 bewezen): criterium 3. Deze pull request blijft een concept tot dat bewezen is.");
    expect(again.match(/## Acceptatiecriteria/g)?.length).toBe(1);
    expect(again).not.toContain("3/3");
    expect(provenLine(st(["fail", "notrun", "pass"]), "en")).toContain("2 criteria not proven");
  });

  it("not all proven: exit 5 with the choices, nothing written", () => {
    const e = notProvenError(st(["pass", "fail", "notrun"]), 101, "nl");
    expect(e.exitCode).toBe(5);
    expect(e.message).toContain("2 of 3 acceptance criteria of story 101 are not proven");
    expect(e.message).toContain("--draft");
    expect(e.message).toContain("--anyway");
  });
});

describe("run progress and YOLO", () => {
  it("the agent reports steps; the bar reads done, running and queued", () => {
    const t = world();
    const r1 = progress(t.ctx, { id: 101, steps: ["Plan", "Bouwen", "Testen", "Pull request"], step: 2, label: "Bouwen", action: "story-run" });
    expect(r1).toMatchObject({ running: true, step: 2, total: 4, label: "Bouwen", stateFile: stateFile(t.ctx, 101, "run") });
    expect(stepsView(r1).map((x) => x.state)).toEqual(["done", "running", "queued", "queued"]);
    const done = progress(t.ctx, { id: 101, done: true });
    expect(stepsView(done).map((x) => x.state)).toEqual(["done", "done", "done", "done"]);
    expect(progress(t.ctx, { id: 101 }).running).toBe(false);
  });

  it("YOLO writes opencode permissions in the set folder with the limits denied, and takes only its own file away", () => {
    const t = world();
    const on = yolo(t.ctx, { on: true });
    const cfg = JSON.parse(readFileSync(on.file, "utf8"));
    expect(cfg.permission.edit).toBe("allow");
    expect(cfg.permission.bash["*"]).toBe("allow");
    for (const p of LIMIT_DENY) expect(cfg.permission.bash[p]).toBe("deny");
    expect(cfg.permission.bash["git push * staging*"]).toBe("deny");
    expect(cfg.permission.bash["aihub pr complete*"]).toBe("deny");
    expect(yolo(t.ctx, { on: false })).toMatchObject({ yolo: false });
    expect(existsSync(on.file)).toBe(false);
    writeFileSync(on.file, "{}");
    expect(() => yolo(t.ctx, { on: true })).toThrow(/not from aihub/);
  });
});

describe("the options of Run End to End and bugs", () => {
  it("conditional blocks on their own lines and inside a line", () => {
    const t = "a\n{{#if x}}\nX line\n{{/if}}\nb{{#if y}} and y{{/if}}.\n";
    expect(conditionals(t, { x: true, y: false })).toBe("a\nX line\nb.\n");
    expect(conditionals(t, { x: false, y: true })).toBe("a\nb and y.\n");
    expect(runOptions({}, true)).toEqual({ planFirst: true, fabric: true, setActive: false, draft: false, anyway: false });
    expect(runOptions({ planFirst: "false", fabric: "true" }, false)).toMatchObject({ planFirst: false, fabric: true });
  });

  it("the dialog's options from the run state fill story-run; the PR choice fills story-pr", async () => {
    const t = world();
    const s = t.s();
    s.teamCfg = { language: "nl", fabric: { workspaces: [{ name: "ws-feature-101", environment: "feature", branches: ["feature/101-*"] }] } } as never;
    const all = await renderPrompt(t.ctx, s, "story-run", 101);
    expect(all.workspace).toBe("ws-feature-101");
    expect(all.options).toEqual({ planFirst: true, fabric: true, setActive: false, draft: false, anyway: false });
    expect(all.text).toContain("## Plan first");
    expect(all.text).toContain("een Fabric-run in ws-feature-101");
    expect(all.text).not.toContain("Resolved");
    progress(t.ctx, { id: 101, action: "story-run", options: { planFirst: false, fabric: false, setActive: true } });
    const none = await renderPrompt(t.ctx, s, "story-run", 101);
    expect(none.text).not.toContain("## Plan first");
    expect(none.text).not.toContain("Fabric-run in");
    expect(none.text).toContain("Draai niets op Fabric.");
    expect(none.text).toContain("aihub workitem state --id 101 --to Resolved");
    expect(none.text.includes("{{")).toBe(false);
    expect(none.text.includes("\n\n\n")).toBe(false);
    expect((await renderPrompt(t.ctx, s, "story-pr", 101)).text).toContain("Leg de keuze aan mij voor");
    const draft = await renderPrompt(t.ctx, s, "story-pr", 101, { draft: true });
    expect(draft.text).toContain("Ik koos: als concept; gebruik `--draft`.");
    expect(draft.text).not.toContain("Leg de keuze aan mij voor");
  });

  it("Stop marks the run stopped; a new action starts a new run", () => {
    const t = world();
    progress(t.ctx, { id: 101, action: "story-run", step: 3, total: 8, label: "Testen" });
    const st = progress(t.ctx, { id: 101, stop: true });
    expect([st.running, st.stopped]).toEqual([false, true]);
    const again = progress(t.ctx, { id: 101, action: "story-run" });
    expect([again.step, again.stopped, again.steps]).toEqual([0, false, []]);
  });

  it("a bug has no acceptance criteria: refused, and Fix End to End does not ask for them", async () => {
    const t = world();
    const s = t.s();
    await expect(readCriteria(s, 301)).rejects.toThrow(/bugs have no acceptance criteria/);
    await expect(criteriaRecord(t.ctx, s, { id: 301, criterion: 1, result: "pass", evidence: "x" })).rejects.toThrow(/bugs have no acceptance criteria/);
    const r = await renderPrompt(t.ctx, s, "bug-run", 301);
    expect(r.text).toContain("Los Bug #301");
    expect(r.text).not.toMatch(/criteri/i);
    expect(readFileSync(findPrompt(s, "bug-reproduce").file, "utf8")).not.toMatch(/criteri/i);
    expect(ACTIONS).toContain("bug-run");
    expect(ACTIONS).toContain("story-pr-review");
    expect(ACTIONS).not.toContain("bug-fix-e2e");
  });

  it("activate: a new item goes to the first InProgress state and to me; an active one keeps its state", async () => {
    const t = world();
    const r = await storyActivate(t.s(), { id: 301 });
    expect(r).toMatchObject({ status: "saved", state: "Active", assignedTo: "Test User" });
    expect(t.items[301].fields["System.AssignedTo"]).toBe("test.user@example.test");
    const again = await storyActivate(t.s(), { id: 101 });
    expect(again).toMatchObject({ status: "saved", state: "Active", changed: [] });
  });
});

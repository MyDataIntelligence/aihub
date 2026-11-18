import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { findSet } from "../src/lib/setInfo.js";
import { isJournaled, nextHint, readJournal } from "../src/lib/journal.js";
import { ctxFor, fakeFetch, sh, write, type Route } from "./helpers.js";
import { makeNamedRepo, newParent, storyRoutes } from "./parity-helpers.js";

const TEAM = "language: en\nbranches:\n  protected: [main]\nrepositories:\n  - name: repo-a\n  - name: repo-b\n";

/** Two repositories checked out as a worktree set for story 5 (what `aihub worktree create` leaves behind). */
function makeSet() {
  const parent = newParent();
  const a = makeNamedRepo(parent, "repo-a");
  const b = makeNamedRepo(parent, "repo-b");
  for (const r of [a, b]) {
    write(r.dir, ".agents/skills/_shared/references/team.yaml", TEAM);
    sh(r.dir, ["add", "."]);
    sh(r.dir, ["commit", "-m", "team"]);
    sh(r.dir, ["push", "origin", "main"]);
  }
  const folder = join(parent, "worktrees", "story-5");
  const meta = { story: 5, branch: "feature/5-set-demo", repos: [] as { name: string; source: string; path: string }[] };
  for (const [name, r] of [["repo-a", a], ["repo-b", b]] as const) {
    const path = join(folder, name);
    sh(r.dir, ["worktree", "add", "-b", "feature/5-set-demo", path]);
    meta.repos.push({ name, source: r.dir, path });
  }
  write(folder, ".aihub-set.json", JSON.stringify(meta));
  return { parent, folder, a: meta.repos[0].path, b: meta.repos[1].path, aMain: a.dir, bMain: b.dir };
}

async function run(cwd: string, argv: string[], routes: Route[] = []) {
  const { fn } = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(cwd, fn);
  ctx.now = () => Date.parse("2026-11-18T12:00:00Z");
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), errs: errs.join("\n") };
}

describe("worktree set: --all-repos", () => {
  it("findSet recognises the set folder and every repository inside it", () => {
    const s = makeSet();
    expect(findSet(s.a)?.story).toBe(5);
    expect(findSet(s.folder)?.repos.map((r) => r.name)).toEqual(["repo-a", "repo-b"]);
    expect(findSet(s.aMain)).toBeUndefined();
  });

  it("commit --all-repos commits the repository with changes, skips the unchanged one and prints one table", async () => {
    const s = makeSet();
    write(s.a, "src/new.py", "x = 1\n");
    write(s.a, "src/__pycache__/new.cpython-312.pyc", "bin\n");
    const r = await run(s.a, ["commit", "--all-repos", "--type", "feat", "--subject", "add the thing"]);
    expect(r.errs).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/set story-5: commit in 2 repo\(s\)/);
    expect(r.out).toMatch(/repo-a\s+no\s+/);
    expect(r.out).toMatch(/repo-b\s+no\s+.*skipped: nothing to commit/);
    expect(sh(s.a, ["log", "-1", "--format=%s"])).toContain("add the thing");
    expect(sh(s.a, ["show", "--name-only", "--format=", "HEAD"])).not.toContain("pycache");
    expect(sh(s.b, ["log", "-1", "--format=%s"])).toBe("team");
  });

  it("continues after an error in one repository and fails at the end naming it", async () => {
    const s = makeSet();
    write(s.a, "a.txt", "1\n");
    write(s.b, "b.txt", "2\n");
    // a failing pre-commit hook in repo-b only (the hooks folder is shared by the worktrees of that repository)
    const hooks = resolve(s.b, sh(s.b, ["rev-parse", "--git-path", "hooks"]));
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho nope >&2\nexit 1\n");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    const r = await run(s.a, ["commit", "--all-repos", "--type", "feat", "--subject", "both"]);
    expect(r.code).toBe(1);
    expect(r.errs).toContain("failed in repo-b");
    expect(sh(s.a, ["log", "-1", "--format=%s"])).toContain("both");
    expect(r.out).toMatch(/repo-b .*failed:/);
  });

  it("--all-repos outside a set and without sibling checkouts on the same branch explains itself", async () => {
    const s = makeSet();
    sh(s.bMain, ["checkout", "-b", "other"]);
    const r = await run(s.aMain, ["commit", "--all-repos", "--type", "feat", "--subject", "x"]);
    expect(r.code).toBe(1);
    expect(r.errs).toContain("worktree set");
  });

  it("status shows the Set line", async () => {
    const s = makeSet();
    const r = await run(s.a, ["status"]);
    expect(r.out).toContain("Set: story-5 with repo-a, repo-b");
  });
});

describe("journal and resume", () => {
  it("records actions, not reads; a failure is recorded with its message", async () => {
    const s = makeSet();
    write(s.a, "x.txt", "1\n");
    await run(s.a, ["commit", "--type", "feat", "--subject", "first"]);
    await run(s.a, ["status"]);
    await run(s.a, ["note", "list"]);
    const bad = await run(s.a, ["commit", "--type", "feat", "--subject", "nothing"]);
    expect(bad.code).toBe(1);
    const j = readJournal(s.a);
    expect(j.map((e) => e.command)).toEqual(['aihub commit --type feat --subject first', 'aihub commit --type feat --subject nothing']);
    expect(j[0]).toMatchObject({ status: "ok", at: "2026-11-18T12:00:00Z" });
    expect(j[0].next).toContain("aihub pr create");
    expect(j[1].status).toBe("failed");
    // the file lives in the git common dir, so both worktrees of a repository share it and it is never committed
    const f = join(sh(s.a, ["rev-parse", "--git-common-dir"]), "aihub", "journal.md");
    expect(existsSync(f.startsWith("/") || /^[A-Za-z]:/.test(f) ? f : join(s.a, f))).toBe(true);
    expect(sh(s.a, ["status", "--porcelain"])).toBe("");
  });

  it("note add goes into the journal with its text", async () => {
    const s = makeSet();
    await run(s.a, ["note", "add", "decided to keep the old API"]);
    expect(readJournal(s.a)[0].command).toContain("decided to keep the old API");
  });

  it("status --resume prints last time, plan done/left and next step without any network call", async () => {
    const s = makeSet();
    write(s.a, "x.txt", "1\n");
    await run(s.a, ["commit", "--type", "feat", "--subject", "first change"]);
    await run(s.a, ["note", "add", "waiting for the API owner"]);
    write(s.a, "y.txt", "2\n");
    const { fn, calls } = fakeFetch([]);
    const { ctx, lines } = ctxFor(s.a, fn);
    ctx.now = () => Date.parse("2026-11-18T12:30:00Z");
    expect(await main(["status", "--resume"], ctx, commands)).toBe(0);
    expect(calls).toHaveLength(0);
    const out = lines.join("\n");
    expect(out).toMatch(/Last time: aihub note add waiting for the API owner .* \(30 min ago\)/);
    expect(out).toContain("Plan done/left: committed / ");
    expect(out).toContain("Next step: there are uncommitted changes");
    expect(out).toContain("Note: waiting for the API owner");
    expect(out).toContain("Set: story-5");
  });

  it("the Dutch team gets the Dutch labels", async () => {
    const s = makeSet();
    write(s.a, ".agents/skills/_shared/references/team.yaml", TEAM.replace("language: en", "language: nl"));
    const r = await run(s.a, ["status", "--resume"]);
    expect(r.out).toContain("Vorige keer: nog niets vastgelegd");
    expect(r.out).toContain("Plan gedaan/rest:");
    expect(r.out).toContain("Volgende stap:");
  });

  it("nextHint and isJournaled", () => {
    expect(nextHint("pipeline", ["follow"], true, "PR !1: all 1 pipeline run(s) finished green")).toContain("comments get");
    expect(nextHint("pipeline", ["follow"], true, "failed: build")).toContain("pipeline-fix");
    expect(isJournaled("status", [])).toBe(false);
    expect(isJournaled("commit", ["--type", "x"])).toBe(true);
    expect(isJournaled("pr", ["changes"])).toBe(false);
    expect(isJournaled("story", ["recall", "--id", "5"])).toBe(false);
    expect(isJournaled("pr", ["create", "--dry-run"])).toBe(false);
  });

  it("story recall joins ADO and the journal; story search finds a title and journal lines", async () => {
    const s = makeSet();
    write(s.a, "x.txt", "1\n");
    await run(s.a, ["commit", "--type", "feat", "--subject", "recall me"]);
    const routes: Route[] = [
      ...storyRoutes(5, { title: "Orders exporteren", state: "Doing" }),
      { method: "POST", match: /wit\/wiql/, respond: () => ({ body: { workItems: [{ id: 5 }] } }) },
      { match: /wit\/workitems\?ids=5/, respond: () => ({ body: { value: [{ id: 5, fields: { "System.Id": 5, "System.Title": "Orders exporteren", "System.State": "Doing" } }] } }) },
    ];
    const r = await run(s.a, ["story", "recall", "--id", "5"], routes);
    expect(r.out).toContain("Story 5 [Doing] Orders exporteren");
    expect(r.out).toContain("Journal (latest 10):");
    expect(r.out).toContain("commit --type feat --subject recall me");
    const q = await run(s.a, ["story", "search", "orders"], routes);
    expect(q.out).toContain("5 [Doing] Orders exporteren");
  });
});

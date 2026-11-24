import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deriveTarget, targetFor } from "../src/lib/baseBranch.js";
import { MISSING_SETTING_EXIT } from "../src/lib/team-guide.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, write } from "./helpers.js";

vi.setConfig({ testTimeout: 30_000 });

function commit(dir: string, file: string, msg: string) {
  write(dir, file, `${msg}\n`);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", msg]);
}

/** main with one commit, origin/develop two commits ahead of it (like bench-base-noteam on main). */
function world() {
  const { dir } = makeRepo();
  sh(dir, ["switch", "-c", "develop"]);
  commit(dir, "a.txt", "develop 1");
  commit(dir, "b.txt", "develop 2");
  sh(dir, ["push", "-u", "origin", "develop"]);
  sh(dir, ["switch", "main"]);
  return dir;
}

const env = () => ({ AIHUB_HOME: ctxFor(".", fakeFetch([]).fn).ctx.env.AIHUB_HOME });

describe("deriveTarget: the branch a feature branch was cut from", () => {
  it("cut from a branch that is not the default: that branch, from the merge-base (as in the world without team.yaml)", () => {
    const dir = world();
    sh(dir, ["switch", "develop"]);
    sh(dir, ["switch", "-c", "feature/7-csv"]);
    commit(dir, "c.txt", "feature");
    expect(deriveTarget({ env: env() }, dir, "feature/7-csv", {})).toEqual({ target: "develop", how: "branch point" });
  });

  it("the merge-base decides, not the reflog: cut from develop while the reflog only mentions main", () => {
    const dir = world();
    sh(dir, ["switch", "-c", "feature/8-x", "origin/develop"]);
    commit(dir, "c.txt", "feature");
    sh(dir, ["reflog", "expire", "--expire=now", "--all"]);
    // develop is known only as a protected branch of team.yaml; origin/HEAD is main
    expect(deriveTarget({ env: env() }, dir, "feature/8-x", { branches: { protected: ["main", "develop", "release/*"] } })?.target).toBe("develop");
  });

  it("cut from the default branch: the default branch, also when another candidate exists", () => {
    const dir = world();
    sh(dir, ["switch", "-c", "feature/9-y"]);
    commit(dir, "c.txt", "feature");
    expect(deriveTarget({ env: env() }, dir, "feature/9-y", { branches: { protected: ["develop"] } })).toEqual({ target: "main", how: "branch point" });
  });

  it("only the default branch: used silently (no note on the result line)", () => {
    const { dir } = makeRepo();
    sh(dir, ["switch", "-c", "feature/10-z"]);
    commit(dir, "c.txt", "feature");
    expect(deriveTarget({ env: env() }, dir, "feature/10-z", {})).toEqual({ target: "main", how: "default branch" });
  });

  it("a tie without local knowledge is asked, not guessed", () => {
    const { dir } = makeRepo();
    sh(dir, ["push", "origin", "main:refs/heads/develop"]);
    sh(dir, ["fetch", "origin"]);
    sh(dir, ["switch", "-c", "feature/11-t"]);
    commit(dir, "c.txt", "feature");
    sh(dir, ["reflog", "expire", "--expire=now", "--all"]);
    expect(() => deriveTarget({ env: env() }, dir, "feature/11-t", { branches: { protected: ["develop"] } })).toThrow(
      'missing team setting repositories[0].defaultTarget (found: main, develop): ask the user, then run: aihub team set repositories[0].defaultTarget "<value>" (or pass --target <branch> for this one call)',
    );
  });

  it("a branch that shares no history with the default branch is asked", () => {
    const { dir } = makeRepo();
    sh(dir, ["switch", "--orphan", "feature/12-o"]);
    commit(dir, "o.txt", "orphan");
    expect(() => deriveTarget({ env: env() }, dir, "feature/12-o", {})).toThrow(/missing team setting repositories\[0\]\.defaultTarget \(found: main\)/);
  });

  it("team.yaml wins and costs no git call", () => {
    expect(targetFor({ env: {} }, "/does/not/exist", "feature/1", { repositories: [{ name: "r", defaultTarget: "staging" }] }, "r")).toEqual({ target: "staging", how: "team.yaml" });
  });
});

describe("aihub pr create without team.yaml", () => {
  it("targets the branch point and says so; a tie stops with exit code 3 before anything is pushed", async () => {
    const dir = world();
    sh(dir, ["switch", "develop"]);
    sh(dir, ["switch", "-c", "feature/csv"]);
    commit(dir, "c.txt", "add csv");
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["pr", "create", "--dry-run", "--summary-text", "Adds CSV"], ctx)).toBe(0);
    expect(lines[0].split("\n")[0]).toMatch(/^dry-run: 'add csv' feature\/csv -> develop \(.*target: develop \(derived from the branch point\)\)$/);

    const t = makeRepo().dir;
    sh(t, ["push", "origin", "main:refs/heads/develop"]);
    sh(t, ["fetch", "origin"]);
    write(t, ".agents/skills/_shared/references/team.yaml", "branches:\n  protected: [develop]\n");
    sh(t, ["switch", "-c", "feature/tie"]);
    commit(t, "c.txt", "tie");
    sh(t, ["reflog", "expire", "--expire=now", "--all"]);
    const f = fakeFetch([]);
    const b = ctxFor(t, f.fn);
    expect(await main(["pr", "create", "--summary-text", "x"], b.ctx)).toBe(MISSING_SETTING_EXIT);
    expect(b.errs.join("\n")).toContain("aihub team set repositories[0].defaultTarget");
    expect(f.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(sh(t, ["ls-remote", "--heads", "origin", "feature/tie"])).toBe("");
    // the answer works without a team.yaml: team set writes the proposal first, then the PR targets the answer
    const set = ctxFor(t, fakeFetch([]).fn);
    set.ctx.tokenCache = join(set.ctx.env.AIHUB_HOME!, "no-token");
    rmSync(join(t, ".agents"), { recursive: true, force: true });
    expect(await main(["team", "set", "repositories[0].defaultTarget", "develop"], set.ctx)).toBe(0);
    const after = ctxFor(t, fakeFetch([]).fn);
    expect(await main(["pr", "create", "--dry-run", "--summary-text", "x"], after.ctx)).toBe(0);
    expect(after.lines[0]).toContain("feature/tie -> develop");
    expect(after.lines[0]).not.toContain("derived from the branch point");
    // --target overrules the derivation
    const c = ctxFor(t, fakeFetch([]).fn);
    expect(await main(["pr", "create", "--dry-run", "--target", "develop", "--summary-text", "x"], c.ctx)).toBe(0);
    expect(c.lines[0]).toContain("feature/tie -> develop");
  });
});

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deriveTarget } from "../src/lib/baseBranch.js";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, sh, tmp, write } from "./helpers.js";

vi.setConfig({ testTimeout: 30_000 });

/**
 * A team repository on a plain local bare origin (no Azure DevOps URL, no insteadOf): main and staging on the same commit, as
 * right after a release. The developer's clone has origin/HEAD -> main.
 */
function world() {
  const base = tmp("aihub-anyremote-");
  const bare = join(base, "orders.git");
  const dir = join(base, "work");
  mkdirSync(bare);
  mkdirSync(dir);
  sh(bare, ["init", "--bare", "-b", "main"]);
  sh(dir, ["init", "-b", "main"]);
  for (const [k, v] of [["user.name", "Test"], ["user.email", "test@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) sh(dir, ["config", k, v]);
  sh(dir, ["remote", "add", "origin", bare]);
  commit(dir, "README.md", "init");
  sh(dir, ["push", "-q", "origin", "main"]);
  sh(dir, ["push", "-q", "origin", "main:staging"]);
  sh(dir, ["fetch", "-q", "origin"]);
  sh(dir, ["remote", "set-head", "origin", "main"]);
  return { base, bare, dir };
}

function commit(dir: string, file: string, msg: string) {
  write(dir, file, `${msg}\n`);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", msg]);
}

/** staging moves on on the server by one commit (another developer), without touching the feature's files */
function stagingMovesOn(w: { base: string; bare: string }, file = "staging.txt") {
  const other = join(w.base, `other-${file}`);
  sh(w.base, ["clone", "-q", "-b", "staging", w.bare, other]);
  for (const [k, v] of [["user.name", "Other"], ["user.email", "other@example.com"], ["commit.gpgsign", "false"]]) sh(other, ["config", k, v]);
  commit(other, file, "staging moves on");
  sh(other, ["push", "-q", "origin", "staging"]);
}

const env = () => ({ AIHUB_HOME: ctxFor(".", fakeFetch([]).fn).ctx.env.AIHUB_HOME });

describe("aihub branch update on any git remote (fetch and merge need no Azure DevOps)", () => {
  it("a plain local origin: the feature cut from staging is updated from staging; the line names the target and why", async () => {
    const w = world();
    sh(w.dir, ["switch", "-q", "-c", "feature/4711-orderexport", "origin/staging"]);
    commit(w.dir, "orderexport.txt", "feature");
    stagingMovesOn(w);
    const { ctx, lines, errs } = ctxFor(w.dir, fakeFetch([]).fn);
    expect(await main(["branch", "update", "--no-push"], ctx, commands)).toBe(0);
    expect(errs.join("\n")).toBe("");
    const out = lines.join("\n");
    expect(out).toContain("feature/4711-orderexport <- staging: updated");
    expect(out).toContain("target staging (the branch it was cut from)");
    expect(out).not.toMatch(/hint:/);
    expect(readFileSync(join(w.dir, "staging.txt"), "utf8").trim()).toBe("staging moves on");
    // the second time: already up to date, and it says with what
    lines.length = 0;
    expect(await main(["branch", "update", "--no-push"], ctx, commands)).toBe(0);
    expect(lines.join("\n")).toContain("feature/4711-orderexport: already up to date with staging");
    expect(lines.join("\n")).toContain("target staging");
  });

  it("main chosen (team.yaml) while origin/staging exists: one hint line with --target staging; --target staging then updates from staging", async () => {
    const w = world();
    sh(w.dir, ["switch", "-q", "-c", "feature/4712-orderexport", "origin/staging"]);
    write(w.dir, ".agents/skills/_shared/references/team.yaml", "repositories:\n  - name: orders\n    defaultTarget: main\n");
    commit(w.dir, "orderexport.txt", "feature");
    stagingMovesOn(w);
    const { ctx, lines } = ctxFor(w.dir, fakeFetch([]).fn);
    expect(await main(["branch", "update", "--no-push"], ctx, commands)).toBe(0);
    let out = lines.join("\n");
    expect(out).toContain("feature/4712-orderexport: already up to date with main");
    expect(out).toContain("target main (from team.yaml)");
    expect(out).toContain("hint: origin/staging exists; to update from it: aihub branch update --target staging");
    lines.length = 0;
    expect(await main(["branch", "update", "--no-push", "--target", "staging"], ctx, commands)).toBe(0);
    out = lines.join("\n");
    expect(out).toContain("feature/4712-orderexport <- staging: updated");
    expect(out).toContain("target staging (given with --target)");
    expect(out).not.toMatch(/hint:/);
  });

  it("--json carries the target, the reason and the hint", async () => {
    const w = world();
    sh(w.dir, ["switch", "-q", "-c", "hotfix/9-rounding", "origin/main"]);
    commit(w.dir, "fix.txt", "fix");
    const { ctx, lines } = ctxFor(w.dir, fakeFetch([]).fn);
    expect(await main(["branch", "update", "--no-push", "--json"], ctx, commands)).toBe(0);
    const r = JSON.parse(lines[0]);
    expect(r).toMatchObject({ branch: "hotfix/9-rounding", target: "main", result: "up-to-date", targetReason: "origin's default branch" });
    expect(r.hint).toContain("--target staging");
  });
});

describe("the target rule: a branch cut from staging while main is on the same commit", () => {
  it("the branch's own upstream and reflog say staging: staging, not main (main moved on less, which used to win)", () => {
    const w = world();
    sh(w.dir, ["switch", "-q", "-c", "feature/4713-orderexport", "origin/staging"]);
    commit(w.dir, "orderexport.txt", "feature");
    stagingMovesOn(w);
    sh(w.dir, ["fetch", "-q", "origin"]);
    expect(deriveTarget({ env: env() }, w.dir, "feature/4713-orderexport", {})?.target).toBe("staging");
  });

  it("nothing in the branch says where it came from: staging (the integration branch) before main", () => {
    const w = world();
    sh(w.dir, ["switch", "-q", "--no-track", "-c", "feature/4714-orderexport", "origin/staging"]);
    commit(w.dir, "orderexport.txt", "feature");
    sh(w.dir, ["reflog", "expire", "--expire=now", "--all"]);
    stagingMovesOn(w);
    sh(w.dir, ["fetch", "-q", "origin"]);
    expect(deriveTarget({ env: env() }, w.dir, "feature/4714-orderexport", { branches: { protected: ["main", "staging"] } })?.target).toBe("staging");
  });

  it("a hotfix cut from main while staging is on the same commit stays on main (the branch says so)", () => {
    const w = world();
    sh(w.dir, ["switch", "-q", "-c", "hotfix/10-vat", "origin/main"]);
    commit(w.dir, "vat.txt", "hotfix");
    stagingMovesOn(w);
    sh(w.dir, ["fetch", "-q", "origin"]);
    expect(deriveTarget({ env: env() }, w.dir, "hotfix/10-vat", {})?.target).toBe("main");
  });
});

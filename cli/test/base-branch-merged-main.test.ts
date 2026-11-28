import { describe, expect, it, vi } from "vitest";
import { deriveTarget } from "../src/lib/baseBranch.js";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, write } from "./helpers.js";

vi.setConfig({ testTimeout: 30_000 });

const commit = (dir: string, file: string, msg: string) => {
  write(dir, file, `${msg}\n`);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", msg]);
};

/** A feature branch cut from staging (one commit ahead of main) that later merged main, which moved on by three commits. */
function featureWithMainMerged() {
  const { dir } = makeRepo();
  sh(dir, ["switch", "-c", "staging"]);
  commit(dir, "s1.txt", "staging 1");
  sh(dir, ["push", "-u", "origin", "staging"]);
  sh(dir, ["switch", "-c", "feature/3-z"]);
  commit(dir, "f.txt", "feature");
  sh(dir, ["switch", "main"]);
  for (const n of ["m2", "m3", "m4"]) commit(dir, `${n}.txt`, n);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["switch", "feature/3-z"]);
  sh(dir, ["merge", "main", "-m", "merge main"]);
  return dir;
}

describe("the target of a feature branch that merged main into itself", () => {
  it("is still the branch it was cut from: a merge of main is not work after main (it came out as main before)", () => {
    const dir = featureWithMainMerged();
    const env = ctxFor(dir, fakeFetch([]).fn).ctx.env;
    expect(deriveTarget({ env }, dir, "feature/3-z", {})).toEqual({ target: "staging", how: "branch point" });
  });

  it("aihub branch update names staging as the target", async () => {
    const dir = featureWithMainMerged();
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["branch", "update", "--no-push"], ctx, commands)).toBe(0);
    expect(lines.join("\n")).toContain("target staging");
  });
});

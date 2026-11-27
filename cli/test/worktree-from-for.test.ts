import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, sh, write } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

/** Two synthetic clones; repo-b also has a pushed `develop` with one more commit. */
function clones() {
  const parent = newParent();
  const a = makeNamedRepo(parent, "repo-a");
  const b = makeNamedRepo(parent, "repo-b");
  sh(b.dir, ["switch", "-c", "develop"]);
  write(b.dir, "develop.txt", "only on develop\n");
  sh(b.dir, ["add", "."]);
  sh(b.dir, ["commit", "-m", "develop work"]);
  sh(b.dir, ["push", "origin", "develop"]);
  sh(b.dir, ["switch", "main"]);
  return { parent, a, b };
}

const run = async (cwd: string, argv: string[]) => {
  const { ctx, lines, errs } = ctxFor(cwd, fakeFetch([]).fn);
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), err: errs.join("\n") };
};

describe("aihub worktree open --from-for", () => {
  it("makes each new branch from its own base, and an existing branch is used as it is", async () => {
    const { a, b } = clones();
    sh(a.dir, ["branch", "feature/12-shared"]);
    const r = await run(a.dir, ["worktree", "open", "--repos", `${a.dir},${b.dir}`, "--branch", "feature/12-shared", "--branch-for", "repo-b=feature/12-from-develop", "--from-for", "repo-b=develop", "--window", "none", "--json"]);
    expect(r.code).toBe(0);
    const res = JSON.parse(r.out);
    const ra = res.repos.find((x: any) => x.repo === "repo-a");
    const rb = res.repos.find((x: any) => x.repo === "repo-b");
    expect(ra).toMatchObject({ ok: true, branch: "feature/12-shared" });
    expect(rb).toMatchObject({ ok: true, branch: "feature/12-from-develop", from: "origin/develop" });
    // the new branch of repo-b starts at develop: its file is there
    expect(sh(rb.path, ["ls-files", "develop.txt"])).toBe("develop.txt");
    expect(sh(ra.path, ["ls-files", "develop.txt"])).toBe("");
  });

  it("refuses --from-for for a repository that is not in --repos", async () => {
    const { a, b } = clones();
    const r = await run(a.dir, ["worktree", "open", "--repos", `${a.dir},${b.dir}`, "--branch", "feature/13-x", "--from-for", "repo-z=develop", "--window", "none", "--json"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--from-for names repo-z/);
  });
});

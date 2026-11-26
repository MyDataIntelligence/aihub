import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { chooseClone } from "../src/lib/cloneChoice.js";
import { setPreferredClone } from "../src/lib/repoPicker.js";
import { ctxFor, fakeFetch, sh } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

/** Three clones of one remote: the first, one in a folder with another name, one with spaces. */
function clones() {
  const parent = newParent();
  const first = makeNamedRepo(parent, "repo-a");
  const url = sh(first.dir, ["remote", "get-url", "origin"]).trim();
  const extra = (name: string) => {
    const dir = join(parent, "more", name);
    mkdirSync(join(parent, "more"), { recursive: true });
    sh(parent, ["clone", "-q", url, dir]);
    sh(dir, ["config", "user.name", "Test"]);
    sh(dir, ["config", "user.email", "test@example.invalid"]);
    return dir;
  };
  return { first: first.dir, second: extra("repo-a-kopie"), third: extra("Repo Met Spaties") };
}

const common = (wt: string) => realpathSync(resolve(wt, sh(wt, ["rev-parse", "--git-common-dir"]).trim()));
const run = async (dir: string, argv: string[], prefer?: [string, string]) => {
  const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
  if (prefer) setPreferredClone(ctx.env, prefer[0], prefer[1]);
  const code = await main(argv, ctx, commands);
  return { code, json: JSON.parse(lines.join("\n")) as { repos: { repo: string; path?: string }[] } };
};

describe("the clone rule is one rule (CLI and extension)", () => {
  it("chooseClone: preferred, else last used, else first folder to look in, else shortest path", () => {
    const c = [{ path: "/x/b-long", lastUsed: 5, rank: 1 }, { path: "/x/a", lastUsed: 5, rank: 2 }, { path: "/y/c", lastUsed: 1, rank: 0 }];
    expect(chooseClone(c, "/y/c")).toBe("/y/c");
    expect(chooseClone(c)).toBe("/x/b-long");
    expect(chooseClone(c.map((x) => ({ ...x, rank: undefined })))).toBe("/x/a");
  });

  it("worktree open by name uses the preferred clone, not the one next to the current repository", async () => {
    const w = clones();
    const r = await run(w.first, ["worktree", "open", "--repos", "repo-a", "--branch", "feature/x", "--window", "none", "--json"], ["repo-a", w.second]);
    expect(r.code).toBe(0);
    expect(common(r.json.repos[0].path!)).toBe(realpathSync(join(w.second, ".git")));
  });

  it("an explicit folder (what the extension passes) is used as given, even with spaces, and is named by its remote", async () => {
    const w = clones();
    const r = await run(w.first, ["worktree", "open", "--repos", w.third, "--branch", "feature/y", "--window", "none", "--json"], ["repo-a", w.second]);
    expect(r.code).toBe(0);
    expect(r.json.repos[0].repo).toBe("repo-a");
    expect(common(r.json.repos[0].path!)).toBe(realpathSync(join(w.third, ".git")));
  });
});

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRepoDirs } from "../src/lib/repos.js";
import { tmp } from "./helpers.js";

describe("resolveRepoDirs", () => {
  it("uses repositories[].path from team.yaml before looking next to the current repository (live: worktree create ignored it)", () => {
    const base = tmp("aihub-dirs-");
    const here = join(base, "work", "main-repo");
    const other = join(base, "elsewhere", "clone-of-b");
    mkdirSync(join(here, ".git"), { recursive: true });
    mkdirSync(join(other, ".git"), { recursive: true });
    const team = { repositories: [{ name: "main-repo", path: "." }, { name: "repo-b", aliases: ["b"], path: "../../elsewhere/clone-of-b" }] } as any;
    expect(resolveRepoDirs(["repo-b", "b"], here, team).map((r) => r.dir)).toEqual([other, other]);
  });

  it("explains how to fix a repository that is not found", () => {
    const here = join(tmp("aihub-dirs-"), "r");
    mkdirSync(join(here, ".git"), { recursive: true });
    expect(() => resolveRepoDirs(["nope"], here, { repositories: [] } as any)).toThrow(/repositories\[\]\.path in team\.yaml/);
  });
});

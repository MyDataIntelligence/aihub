import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { findSet } from "../src/lib/setInfo.js";
import { readSetFile, writeSetMeta } from "../src/lib/setFile.js";
import { ctxFor, fakeFetch, sh, tmp } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

const run = async (cwd: string, argv: string[]) => {
  const { ctx, lines, errs } = ctxFor(cwd, fakeFetch([]).fn);
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), err: errs.join("\n") };
};
const repo = (parent: string, name: string) => {
  const r = makeNamedRepo(parent, name);
  sh(r.dir, ["config", "user.name", "Test"]);
  sh(r.dir, ["config", "user.email", "test@example.invalid"]);
  return r.dir;
};

describe("set files as people and PowerShell save them", () => {
  const two = {
    story: 7,
    branch: "feature/7-b",
    repos: [{ name: "repo-a", source: "C:/x/repo-a", path: "C:/x/s/repo-a--b" }],
    others: [{ story: 7, branch: "feature/7-a", repos: [{ name: "repo-a", source: "C:/x/repo-a", path: "C:/x/s/repo-a" }] }],
  };

  it("a UTF-8 BOM does not hide the set, and writing keeps the other sets of the folder", () => {
    const folder = tmp("aihub-setfile-");
    const p = join(folder, ".aihub-set.json");
    writeFileSync(p, "\uFEFF" + JSON.stringify(two, null, 2), "utf8");
    const top = readSetFile(folder)!.top;
    expect(top.branch).toBe("feature/7-b");
    writeSetMeta(folder, { ...top, storyTitle: "Zoekfunctie" });
    const after = JSON.parse(readFileSync(p, "utf8"));
    expect(after.storyTitle).toBe("Zoekfunctie");
    expect(after.others.map((o: { branch: string }) => o.branch)).toEqual(["feature/7-a"]);
  });

  it("UTF-16 (what `>` writes in Windows PowerShell 5) is read too, for both set files", () => {
    const folder = tmp("aihub-setfile-");
    writeFileSync(join(folder, ".aihub-set.json"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(two), "utf16le")]));
    expect(readSetFile(folder)?.top.branch).toBe("feature/7-b");
    const maker = tmp("aihub-setfile-");
    writeFileSync(join(maker, ".worktree-set.json"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify({ schemaVersion: 1, branch: "feature/8-x", slug: "feature-8-x", repos: [{ name: "repo-a", source: "C:/x/repo-a", path: "repo-a" }] }), "utf16le")]));
    expect(readSetFile(maker)).toMatchObject({ kind: "maker", top: { branch: "feature/8-x" } });
  });

  it("a set file that cannot be read is not overwritten unseen: its text is kept next to it", () => {
    const folder = tmp("aihub-setfile-");
    const p = join(folder, ".aihub-set.json");
    const broken = JSON.stringify(two, null, 2).replace('"story": 7,', '"story": 7 // by hand\n,');
    writeFileSync(p, broken, "utf8");
    expect(readSetFile(folder)).toBeUndefined();
    writeSetMeta(folder, { story: 7, branch: "feature/7-c", repos: [] });
    const kept = readdirSync(folder).filter((f) => f.startsWith(".aihub-set.json.broken-"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(folder, kept[0]), "utf8")).toBe(broken);
  });

  it("findSet finds the set from a folder deep inside a worktree", { timeout: 60_000 }, async () => {
    const parent = newParent();
    const a = repo(parent, "repo-a");
    const o = JSON.parse((await run(a, ["worktree", "open", "--repos", "repo-a", "--branch", "feature/9-a", "--story", "9", "--window", "none", "--json"])).out);
    const deep = join(o.repos[0].path, "src", "main", "java", "com", "acme", "service", "impl");
    mkdirSync(deep, { recursive: true });
    expect(findSet(deep)?.folder).toBe(o.folder);
  });

  it("worktree open into the folder of an extension set (.worktree-set.json, same branch) adds to that file; no second set file", { timeout: 60_000 }, async () => {
    const parent = newParent();
    const a = repo(parent, "repo-a");
    const b = repo(parent, "repo-b");
    const root = join(parent, "sets");
    const folder = join(root, "feature-x");
    mkdirSync(folder, { recursive: true });
    sh(a, ["worktree", "add", join(folder, "repo-a"), "-b", "feature/x"]);
    writeFileSync(join(folder, ".worktree-set.json"), JSON.stringify({ schemaVersion: 1, branch: "feature/x", slug: "feature-x", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", repos: [{ name: "repo-a", source: a, path: "repo-a" }] }, null, 2));
    const r = await run(b, ["worktree", "open", "--repos", "repo-b", "--branch", "feature/x", "--root", root, "--window", "none", "--json"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(folder, ".aihub-set.json"))).toBe(false);
    const set = readSetFile(folder)!;
    expect(set.kind).toBe("maker");
    expect(set.top.repos.map((x) => x.name).sort()).toEqual(["repo-a", "repo-b"]);
  });
});

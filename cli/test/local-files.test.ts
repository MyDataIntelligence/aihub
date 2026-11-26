import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { inventoryIgnored } from "../src/lib/localFiles.js";
import { ctxFor, fakeFetch, sh, tmp } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

const run = async (cwd: string, argv: string[], env: Record<string, string> = {}) => {
  const { ctx, lines, errs } = ctxFor(cwd, fakeFetch([]).fn);
  Object.assign(ctx.env, env);
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), err: errs.join("\n") };
};

/** repo-a with a .gitignore for the files a developer keeps local, and a set with one worktree of it. */
async function world() {
  const parent = newParent();
  const a = makeNamedRepo(parent, "repo-a").dir;
  sh(a, ["config", "user.name", "Test"]);
  sh(a, ["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(a, ".gitignore"), ".env\nnotes/\nbig.dat\nnode_modules/\n__pycache__/\n*.pyc\n*.log\n");
  sh(a, ["add", ".gitignore"]);
  sh(a, ["commit", "-m", "ignore"]);
  sh(a, ["push", "origin", "main"]);
  const o = JSON.parse((await run(a, ["worktree", "open", "--repos", "repo-a", "--branch", "feature/3-x", "--story", "3", "--window", "none", "--json"])).out);
  const wt = o.repos[0].path as string;
  const put = (rel: string, text: string | Buffer) => {
    mkdirSync(join(wt, rel, ".."), { recursive: true });
    writeFileSync(join(wt, rel), text);
  };
  return { parent, a, wt, folder: o.folder as string, put, backups: () => (existsSync(join(a, ".git", "aihub", "backup")) ? readdirSync(join(a, ".git", "aihub", "backup")) : []) };
}

const remove = (w: { a: string; folder: string }, extra: string[] = []) => run(w.a, ["worktree", "remove", "--folder", w.folder, "--branch", "feature/3-x", "--json", ...extra]);

describe("ignored local files are saved before a worktree goes", { timeout: 90_000 }, () => {
  it("remove copies .env and notes with their relative paths, and leaves build folders alone", async () => {
    const w = await world();
    w.put(".env", "SECRET=1\n");
    w.put("notes/todo.txt", "call back\n");
    w.put("node_modules/x/index.js", "module.exports = 1\n");
    w.put("src/__pycache__/a.pyc", "x");
    w.put("run.log", "log");
    const r = JSON.parse((await remove(w)).out);
    expect(r.kept).toEqual([]);
    expect(existsSync(w.wt)).toBe(false);
    const dir = join(w.a, ".git", "aihub", "backup", w.backups()[0]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(readFileSync(join(dir, "notes", "todo.txt"), "utf8")).toBe("call back\n");
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    expect(existsSync(join(dir, "src"))).toBe(false);
    // the line names the backup folder and the first files
    expect(r.lines.join("\n")).toContain("saved in");
    expect(r.lines.join("\n")).toContain(".env");
  });

  it("a worktree with only build output makes no backup", async () => {
    const w = await world();
    w.put("node_modules/x/index.js", "1");
    w.put("src/__pycache__/a.pyc", "x");
    await remove(w);
    expect(existsSync(w.wt)).toBe(false);
    expect(w.backups()).toEqual([]);
  });

  it("a file over 50 MB is not copied: the removal is refused with its name, --discard-local-work removes anyway", async () => {
    const w = await world();
    w.put(".env", "SECRET=1\n");
    w.put("big.dat", Buffer.alloc(51 * 1024 * 1024));
    const first = JSON.parse((await remove(w)).out);
    expect(first.kept).toEqual(["repo-a"]);
    expect(first.lines.join("\n")).toContain("big.dat");
    expect(first.lines.join("\n")).toContain("--discard-local-work");
    expect(existsSync(join(w.wt, "big.dat"))).toBe(true);
    expect(w.backups()).toEqual([]);
    const second = JSON.parse((await remove(w, ["--discard-local-work"])).out);
    expect(second.kept).toEqual([]);
    expect(existsSync(w.wt)).toBe(false);
    expect(second.lines.join("\n")).toContain("too big to save");
  });

  it("drop saves them too", async () => {
    const w = await world();
    const b = makeNamedRepo(w.parent, "repo-b").dir;
    sh(b, ["config", "user.name", "Test"]);
    sh(b, ["config", "user.email", "test@example.invalid"]);
    await run(w.wt, ["worktree", "add", "--repos", "repo-b", "--json"]);
    w.put(".env", "A=1\n");
    const r = await run(join(w.folder, "repo-b"), ["worktree", "drop", "--repos", "repo-a", "--json"]);
    expect(r.code).toBe(0);
    expect(existsSync(w.wt)).toBe(false);
    expect(w.backups()).toHaveLength(1);
  });

  it("recreate names them in the question and copies them before the old worktree goes", async () => {
    const parent = newParent();
    const a = makeNamedRepo(parent, "repo-a").dir;
    sh(a, ["config", "user.name", "Test"]);
    sh(a, ["config", "user.email", "test@example.invalid"]);
    writeFileSync(join(a, ".gitignore"), ".env\n");
    sh(a, ["add", "."]);
    sh(a, ["commit", "-m", "ignore"]);
    sh(a, ["push", "origin", "main:refs/heads/feature/x"]);
    const old = join(parent, "other", "repo-a-x");
    sh(a, ["worktree", "add", old, "feature/x"]);
    writeFileSync(join(old, ".env"), "KEY=1\n");
    const open = ["worktree", "open", "--repos", "repo-a", "--branch", "feature/x", "--window", "none", "--json"];
    const q = JSON.parse((await run(a, open)).out).needsChoice;
    expect(q.existing[0].ignored).toBe(1);
    expect(q.existing[0].state).toContain("1 ignored local file (.env)");
    expect(q.choices[2].label).toContain("ignored local files");
    const done = JSON.parse((await run(a, [...open, "--existing", "recreate"])).out);
    expect(done.repos[0].state).toBe("recreated");
    expect(done.repos[0].note).toContain("saved in");
    const dirs = readdirSync(join(a, ".git", "aihub", "backup"));
    expect(readFileSync(join(a, ".git", "aihub", "backup", dirs[0], ".env"), "utf8")).toBe("KEY=1\n");
    expect(existsSync(old)).toBe(false);
  });

  it("the personal list ignoreInBackup adds names, and keeps whenExists", async () => {
    const root = tmp("aihub-local-");
    const cfg = tmp("aihub-cfg-");
    sh(root, ["init", "-b", "main"]);
    writeFileSync(join(root, ".gitignore"), ".env\ngenerated/\n*.tmpdata\n");
    mkdirSync(join(root, "generated"));
    writeFileSync(join(root, "generated", "a.txt"), "1");
    writeFileSync(join(root, "x.tmpdata"), "1");
    writeFileSync(join(root, ".env"), "1");
    expect(inventoryIgnored(root, { AIHUB_CONFIG_HOME: cfg }).files.map((f) => f.rel).sort()).toEqual([".env", "generated/a.txt", "x.tmpdata"]);
    await run(root, ["worktree", "when-exists", "move"], { AIHUB_CONFIG_HOME: cfg });
    writeFileSync(join(cfg, "worktrees.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(cfg, "worktrees.json"), "utf8")), ignoreInBackup: ["generated", "*.tmpdata"] }));
    expect(inventoryIgnored(root, { AIHUB_CONFIG_HOME: cfg }).files.map((f) => f.rel)).toEqual([".env"]);
    await run(root, ["worktree", "when-exists", "reuse"], { AIHUB_CONFIG_HOME: cfg });
    expect(JSON.parse(readFileSync(join(cfg, "worktrees.json"), "utf8"))).toMatchObject({ whenExists: "reuse", ignoreInBackup: ["generated", "*.tmpdata"] });
  });
});

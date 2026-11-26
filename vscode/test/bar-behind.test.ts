import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FetchGate, Told, decide, type BehindMode } from "../src/bar/behind";
import { BehindManager, type BehindUi } from "../src/bar/behindRun";
import { gitRaw, gitRun } from "../src/bar/ownWindow";
import { sh, write } from "./gitHelpers";

interface R {
  name: string;
  path: string;
  other: string;
  origin: string;
}

/** n repositories with an origin that has main and (unless onlyMain) staging, a clone on feature/5-x cut from the target, and a second clone to put commits on the target. */
function world(names: string[], o: { onlyMain?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "aihub-behind-"));
  const repos: R[] = names.map((name) => {
    const origin = join(root, `${name}.git`);
    mkdirSync(origin);
    sh(origin, "init", "--bare", "-b", "main");
    const path = join(root, name);
    sh(root, "clone", origin, path);
    sh(path, "switch", "-c", "main");
    write(path, "lib.txt", "one\n");
    write(path, "other.txt", "x\n");
    sh(path, "add", "-A");
    sh(path, "commit", "-m", "init");
    sh(path, "push", "-u", "origin", "main");
    if (!o.onlyMain) {
      sh(path, "switch", "-c", "staging");
      sh(path, "push", "-u", "origin", "staging");
    }
    sh(path, "switch", "-c", "feature/5-x");
    const other = join(root, `${name}-other`);
    sh(root, "clone", origin, other);
    sh(other, "switch", o.onlyMain ? "main" : "staging");
    return { name, path, other, origin };
  });
  const target = o.onlyMain ? "main" : "staging";
  const advance = (r: R, file: string, text: string, n = 1) => {
    for (let i = 0; i < n; i++) {
      write(r.other, file, `${text}${i}\n`);
      sh(r.other, "add", "-A");
      sh(r.other, "commit", "-m", `${file} ${i}`);
    }
    sh(r.other, "push", "origin", `HEAD:${target}`);
  };
  return { root, repos, target, advance };
}

function ui(repos: R[], answers: Record<string, string | undefined> = {}, mode: BehindMode = "ask") {
  const log = { asked: [] as { message: string; buttons: string[] }[], said: [] as string[], undo: undefined as undefined | { label: string; run: () => Promise<{ problem?: string }> }, mode, focused: true, setAuto: 0, changed: 0 };
  const u: BehindUi = {
    mode: () => log.mode,
    setAuto: async () => void (log.setAuto++, (log.mode = "auto")),
    focused: () => log.focused,
    repos: () => repos.map((r) => ({ name: r.name, path: r.path, branch: sh(r.path, "branch", "--show-current").trim() || undefined })),
    ask: async (message, buttons) => (log.asked.push({ message, buttons }), answers[buttons[0]] ?? answers.default),
    said: (line, undo) => void (log.said.push(line), undo && (log.undo = undo)),
    changed: () => void log.changed++,
  };
  return { u, log };
}

/** the stub of `aihub branch update --target T`: the team's way here is a merge */
const cliMerge = (calls: { args: string[]; cwd: string }[] = []) => async (args: string[], cwd: string) => {
  calls.push({ args, cwd });
  const t = args[args.indexOf("--target") + 1];
  sh(cwd, "merge", "--no-edit", `origin/${t}`);
  return "";
};

const manager = (u: BehindUi, calls: { args: string[]; cwd: string }[] = [], extra: Partial<ConstructorParameters<typeof BehindManager>[0]> = {}) => new BehindManager({ git: gitRun, raw: gitRaw, cli: cliMerge(calls), ui: u, ...extra });

describe("behind the target branch: the decision", () => {
  const f = (o: Partial<Parameters<typeof decide>[1]> = {}) => ({ name: "a", path: "/a", branch: "b", target: "staging", behind: 3, targetSha: "x", head: "h", conflicts: [] as string[] | "unknown", overlap: [] as string[], tracked: 0, ...o });
  it("off does nothing; conflicts or no way to check always ask; auto only without overlap", () => {
    expect(decide("off", f())).toBe("none");
    expect(decide("ask", f())).toBe("ask");
    expect(decide("auto", f())).toBe("auto");
    expect(decide("auto", f({ overlap: ["x"] }))).toBe("ask");
    expect(decide("auto", f({ tracked: 2 }))).toBe("ask");
    expect(decide("auto", f({ conflicts: ["x"] }))).toBe("ask-conflict");
    expect(decide("auto", f({ conflicts: "unknown" }))).toBe("ask-conflict");
    expect(decide("ask", f({ blocked: "a merge is in progress" }))).toBe("none");
    expect(decide("ask", f({ behind: 0 }))).toBe("none");
  });
});

describe("behind the target branch", () => {
  it("ask, no conflicts: one message with the three buttons; Update runs aihub branch update in that repository", async () => {
    const w = world(["Repo A"]);
    w.advance(w.repos[0], "new.txt", "n", 2);
    const { u, log } = ui(w.repos, { Update: "Update" });
    const calls: { args: string[]; cwd: string }[] = [];
    const r = await manager(u, calls).run("open");
    expect(log.asked).toEqual([{ message: "Repo A is 2 commits behind staging · no conflicts", buttons: ["Update", "Always Update Automatically", "Later"] }]);
    expect(calls).toEqual([{ args: ["branch", "update", "--no-push", "--target", "staging"], cwd: w.repos[0].path }]);
    expect(r.updated.map((x) => x.line)).toEqual(["Repo A updated from staging (2 commits)"]);
    expect(sh(w.repos[0].path, "rev-list", "--count", "HEAD..origin/staging").trim()).toBe("0");
  });

  it("Always Update Automatically sets the mode and updates this one", async () => {
    const w = world(["Repo A"]);
    w.advance(w.repos[0], "new.txt", "n");
    const { u, log } = ui(w.repos, { Update: "Always Update Automatically" });
    const r = await manager(u).run("open");
    expect(log.setAuto).toBe(1);
    expect(r.updated).toHaveLength(1);
  });

  it("auto, no conflicts, no overlap: updated by itself, one line with Undo; Undo puts the branch back while nothing is pushed", async () => {
    const w = world(["Repo A"]);
    w.advance(w.repos[0], "new.txt", "n", 14);
    const before = sh(w.repos[0].path, "rev-parse", "HEAD").trim();
    const { u, log } = ui(w.repos, {}, "auto");
    await manager(u).run("open");
    expect(log.asked).toEqual([]);
    expect(log.said).toEqual(["Repo A updated from staging (14 commits) · Undo"]);
    expect(sh(w.repos[0].path, "rev-parse", "HEAD").trim()).not.toBe(before);
    write(w.repos[0].path, "work.txt", "uncommitted, kept\n");
    expect(await log.undo!.run()).toEqual({});
    expect(sh(w.repos[0].path, "rev-parse", "HEAD").trim()).toBe(before);
    expect(sh(w.repos[0].path, "status", "--porcelain").trim()).toBe("?? work.txt");
  });

  it("Undo is refused once the update is pushed", async () => {
    const w = world(["Repo A"]);
    w.advance(w.repos[0], "new.txt", "n");
    const { u, log } = ui(w.repos, {}, "auto");
    await manager(u).run("open");
    sh(w.repos[0].path, "push", "-u", "origin", "feature/5-x");
    const res = await log.undo!.run();
    expect(res.problem).toBe("Repo A is pushed since; the update stays");
  });

  it("conflict: says how many files, offers Update and Resolve and Later, never updates by itself (not even in auto)", async () => {
    const w = world(["Repo A"]);
    write(w.repos[0].path, "lib.txt", "mine\n");
    sh(w.repos[0].path, "add", "-A");
    sh(w.repos[0].path, "commit", "-m", "mine");
    w.advance(w.repos[0], "lib.txt", "theirs");
    const { u, log } = ui(w.repos, {}, "auto");
    const calls: { args: string[]; cwd: string }[] = [];
    const r = await manager(u, calls).run("open");
    expect(log.asked).toEqual([{ message: "Repo A is 1 commit behind staging · 1 file will conflict", buttons: ["Update and Resolve...", "Later"] }]);
    expect(calls).toEqual([]);
    expect(r.facts[0].conflicts).toEqual(["lib.txt"]);
    // the working folder was not touched by the check
    expect(sh(w.repos[0].path, "status", "--porcelain").trim()).toBe("");
  });

  it("uncommitted work that the update touches: auto falls back to the question", async () => {
    const w = world(["Repo A"]);
    w.advance(w.repos[0], "other.txt", "theirs");
    write(w.repos[0].path, "other.txt", "my unsaved idea\n");
    const { u, log } = ui(w.repos, {}, "auto");
    const calls: { args: string[]; cwd: string }[] = [];
    await manager(u, calls).run("open");
    expect(calls).toEqual([]);
    expect(log.asked[0].message).toBe("Repo A is 1 commit behind staging · no conflicts, but your uncommitted changes touch 1 of the changed files");
  });

  it("only main exists: main is the target", async () => {
    const w = world(["Repo A"], { onlyMain: true });
    w.advance(w.repos[0], "new.txt", "n", 3);
    const { u, log } = ui(w.repos);
    await manager(u).run("open");
    expect(log.asked[0].message).toBe("Repo A is 3 commits behind main · no conflicts");
  });

  it("the same stand is told once; a new commit on the target is a new stand", async () => {
    const w = world(["Repo A"]);
    w.advance(w.repos[0], "new.txt", "n");
    const { u, log } = ui(w.repos);
    let t = 1_000_000;
    const m = manager(u, [], { gate: new FetchGate(gitRun, () => t) });
    await m.run("open");
    t += 2 * 60_000;
    await m.run("menu");
    t += 2 * 60_000;
    await m.run("own");
    expect(log.asked).toHaveLength(1);
    w.advance(w.repos[0], "new2.txt", "m");
    t += 2 * 60_000;
    await m.run("own");
    expect(log.asked.map((x) => x.message)).toEqual(["Repo A is 1 commit behind staging · no conflicts", "Repo A is 2 commits behind staging · no conflicts"]);
  });

  it("a failed fetch is remembered for 10 minutes: no second try, no message", async () => {
    const w = world(["Repo A"]);
    sh(w.repos[0].path, "remote", "set-url", "origin", join(w.root, "nowhere.git"));
    let fetches = 0;
    let t = 1_000_000;
    const gate = new FetchGate(async (cwd, args) => (fetches++, gitRun(cwd, args)), () => t);
    const { u, log } = ui(w.repos);
    const m = manager(u, [], { gate });
    await m.run("open");
    t += 5 * 60_000;
    await m.run("menu");
    expect(fetches).toBe(1);
    t += 6 * 60_000;
    await m.run("menu");
    expect(fetches).toBe(2);
    expect(log.asked).toEqual([]);
  });

  it("focus: a fetch only after 30 minutes; never without focus; off does nothing", async () => {
    const w = world(["Repo A"]);
    let fetches = 0;
    let t = 1_000_000;
    const gate = new FetchGate(async (cwd, args) => (fetches++, gitRun(cwd, args)), () => t);
    const { u, log } = ui(w.repos);
    const m = manager(u, [], { gate });
    await m.run("open");
    expect(fetches).toBe(1);
    t += 10 * 60_000;
    await m.run("focus");
    expect(fetches).toBe(1);
    t += 25 * 60_000;
    await m.run("focus");
    expect(fetches).toBe(2);
    log.focused = false;
    t += 60 * 60_000;
    await m.run("focus");
    expect(fetches).toBe(2);
    log.focused = true;
    log.mode = "off";
    await m.run("menu");
    expect(fetches).toBe(2);
  });

  it("five repositories, three behind: one message for the set; Update All updates the three", async () => {
    const w = world(["a", "b", "c", "d", "e"]);
    for (const i of [0, 2, 4]) w.advance(w.repos[i], "new.txt", "n", i + 1);
    const { u, log } = ui(w.repos, { default: undefined, "Update All": "Update All" });
    const calls: { args: string[]; cwd: string }[] = [];
    const r = await manager(u, calls).run("open");
    expect(log.asked).toEqual([{ message: "3 repositories are behind staging", buttons: ["Update All", "Later"] }]);
    expect(calls.map((c) => c.cwd)).toEqual([w.repos[0].path, w.repos[2].path, w.repos[4].path]);
    expect(r.updated.every((x) => x.ok)).toBe(true);
  });

  it("never in the middle of a merge, on a detached HEAD, or on the target itself", async () => {
    const w = world(["a", "b", "c"]);
    for (const r of w.repos) w.advance(r, "new.txt", "n");
    writeFileSync(join(w.repos[0].path, ".git", "MERGE_HEAD"), sh(w.repos[0].path, "rev-parse", "HEAD"));
    sh(w.repos[1].path, "checkout", "--detach");
    sh(w.repos[2].path, "switch", "staging");
    const { u, log } = ui(w.repos);
    const calls: { args: string[]; cwd: string }[] = [];
    await manager(u, calls).run("open");
    expect(log.asked).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("the look at the target branch stays out of the way", () => {
  const store = () => {
    let rec: Record<string, { ok: boolean; at: number }> = {};
    return { read: () => rec, write: (r: Record<string, { ok: boolean; at: number }>) => void (rec = r) };
  };

  it("starts a few seconds after the window opened, never before", async () => {
    const { openCheckDelay, OPEN_CHECK_AFTER_MS } = await import("../src/bar/behind");
    expect(OPEN_CHECK_AFTER_MS).toBeGreaterThanOrEqual(3000);
    expect(openCheckDelay(1000, 1000)).toBe(OPEN_CHECK_AFTER_MS);
    expect(openCheckDelay(1000, 1000 + OPEN_CHECK_AFTER_MS - 1)).toBe(1);
    expect(openCheckDelay(1000, 1000 + 60_000)).toBe(0);
  });

  it("a reload or a second window on the same set does not fetch again within the freshness term: the times are kept per repository", async () => {
    const shared = store();
    let fetches = 0;
    let t = 5_000_000;
    const git = async () => (fetches++, "");
    const first = new FetchGate(git, () => t, shared);
    expect(await first.fetch("/w/Repo A", "staging", "open")).toBe("fetched");
    // the window is reloaded: a new gate, the same file
    t += 2 * 60_000;
    const second = new FetchGate(git, () => t, shared);
    expect(second.has("/w/Repo A")).toBe(true);
    expect(await second.fetch("/w/Repo A", "staging", "open")).toBe("skipped");
    expect(await second.fetch("/w/Repo A", "staging", "menu")).toBe("skipped");
    expect(fetches).toBe(1);
    t += 4 * 60_000;
    expect(await second.fetch("/w/Repo A", "staging", "open")).toBe("fetched");
    expect(second.lastOk()).toBe(t);
  });

  it("offline: the first failure is the only one (no fetch per repository), and the manager says nothing", async () => {
    const w = world(["a", "b", "c", "d", "e"]);
    let fetches = 0;
    const git = async (cwd: string, args: string[]) => {
      if (args[0] === "fetch") {
        fetches++;
        throw new Error("fatal: unable to access 'https://dev.azure.com/x/': Could not resolve host: dev.azure.com");
      }
      return gitRun(cwd, args);
    };
    const { u, log } = ui(w.repos);
    const m = manager(u, [], { git, gate: new FetchGate(git, () => 1_000_000, undefined) });
    const r = await m.run("open");
    expect(fetches).toBe(1);
    expect(log.asked).toEqual([]);
    expect(log.said).toEqual([]);
    expect(r.messages).toEqual([]);
    // later, still offline: nothing again within 10 minutes
    await m.run("menu");
    expect(fetches).toBe(1);
  });

  it("Push All offline is one quiet line, not one error per repository", async () => {
    const { offlineSummary } = await import("../src/bar/batch");
    const bad = (n: string) => ({ repo: n, ok: false, line: `${n}: not pushed, fatal: unable to access 'https://x/'`, detail: "fatal: unable to access 'https://x/': Could not resolve host: x" });
    expect(offlineSummary("Push all", [bad("a"), bad("b")])).toBe("Push all: no network right now, nothing was changed on the remote; try again when you are online");
    // one real failure among them: the normal lines
    expect(offlineSummary("Push all", [bad("a"), { repo: "b", ok: false, line: "b: not pushed, rejected by policy" }])).toBeUndefined();
    expect(offlineSummary("Push all", [{ repo: "a", ok: true, line: "a: pushed" }])).toBeUndefined();
  });
});

describe("the awkward repositories of the look at the target", () => {
  it("no remote and a missing folder: no message, no failure per repository, the others are still looked at", async () => {
    const w = world(["a", "b"]);
    w.advance(w.repos[1], "new.txt", "n");
    const { root } = w;
    const lone = join(root, "lone");
    mkdirSync(lone);
    sh(lone, "init", "-b", "feature/5-x");
    write(lone, "a.txt", "a\n");
    sh(lone, "add", "-A");
    sh(lone, "commit", "-m", "init");
    const fetched: string[] = [];
    const git = async (cwd: string, args: string[]) => (args[0] === "fetch" && fetched.push(cwd), gitRun(cwd, args));
    const repos = [{ name: "lone", path: lone, branch: "feature/5-x" }, { name: "gone", path: join(root, "nowhere"), branch: "feature/5-x" }, { name: w.repos[1].name, path: w.repos[1].path, branch: "feature/5-x" }];
    const { u, log } = ui([]);
    const base = u.repos;
    void base;
    const m = new BehindManager({ git, raw: gitRaw, cli: async () => "", ui: { ...u, repos: () => repos } });
    const r = await m.run("open");
    expect(fetched).not.toContain(join(root, "nowhere"));
    expect(r.facts.map((f) => f.name)).toEqual(["b"]);
    expect(log.asked.map((x) => x.message)).toEqual(["b is 1 commit behind staging · no conflicts"]);
  });
});

describe("Undo of an update only undoes that update", () => {
  async function updated() {
    const w = world(["Repo A"]);
    w.advance(w.repos[0], "new.txt", "n", 2);
    const { u, log } = ui(w.repos, {}, "auto");
    await manager(u).run("open");
    return { w, log, path: w.repos[0].path };
  }

  it("not after a commit of the user: the commit stays on the branch", async () => {
    const { w, log, path } = await updated();
    write(path, "mine.txt", "mine\n");
    sh(path, "add", "-A");
    sh(path, "commit", "-m", "feat: mine");
    const head = sh(path, "rev-parse", "HEAD").trim();
    const r = await log.undo!.run();
    expect(r.problem).toBe("Repo A has new commits since the update; they would be lost, so the update stays");
    expect(sh(path, "rev-parse", "HEAD").trim()).toBe(head);
    void w;
  });

  it("not on another branch: that branch is never moved", async () => {
    const { w, log, path } = await updated();
    sh(path, "switch", "-c", "feature/other", "main");
    const other = sh(path, "rev-parse", "feature/other").trim();
    const r = await log.undo!.run();
    expect(r.problem).toBe("Repo A is not on feature/5-x any more; the update stays");
    expect(sh(path, "rev-parse", "feature/other").trim()).toBe(other);
    void w;
  });

  it("not in the middle of a merge", async () => {
    const { log, path } = await updated();
    writeFileSync(join(path, ".git", "MERGE_HEAD"), sh(path, "rev-parse", "HEAD"));
    expect((await log.undo!.run()).problem).toBe("a merge is in progress in Repo A; finish or abort it first");
  });

  it("and the update itself never publishes: the remote branch is where it was", async () => {
    const w = world(["Repo A"]);
    sh(w.repos[0].path, "push", "-u", "origin", "feature/5-x");
    const remote = sh(w.repos[0].origin, "rev-parse", "feature/5-x").trim();
    w.advance(w.repos[0], "new.txt", "n");
    const { u, log } = ui(w.repos, {}, "auto");
    await manager(u).run("open");
    expect(log.said[0]).toContain("updated from staging");
    expect(sh(w.repos[0].origin, "rev-parse", "feature/5-x").trim()).toBe(remote);
    // not pushed, so Undo works
    expect(await log.undo!.run()).toEqual({});
  });
});

describe("auto only when nothing tracked has changed (review D)", () => {
  it("a changed tracked file that the update does not touch: asked, never by itself, and the question says so", async () => {
    const w = world(["Repo A"]);
    w.advance(w.repos[0], "new.txt", "n");
    write(w.repos[0].path, "other.txt", "my edit\n");
    const { u, log } = ui(w.repos, {}, "auto");
    const calls: { args: string[]; cwd: string }[] = [];
    const r = await manager(u, calls).run("open");
    expect(calls).toEqual([]);
    expect(r.facts[0].tracked).toBe(1);
    expect(log.asked[0].message).toBe("Repo A is 1 commit behind staging · no conflicts, but you have uncommitted changes");
  });

  it("only an untracked file elsewhere: updated by itself", async () => {
    const w = world(["Repo A"]);
    w.advance(w.repos[0], "new.txt", "n");
    write(w.repos[0].path, "scratch/notes.txt", "x\n");
    const { u, log } = ui(w.repos, {}, "auto");
    await manager(u).run("open");
    expect(log.said[0]).toContain("updated from staging");
  });

  it("the overlap is read the safe way: renames, spaces and non-ASCII names, untracked folders", async () => {
    const { parseStatusZ } = await import("../src/bar/behind");
    const nul = String.fromCharCode(0);
    const out = ["R  new name.txt", "old name.txt", " M é.txt", "?? dir sub/", "!! ignored.log", "A  plain.txt", ""].join(nul);
    expect(parseStatusZ(out)).toEqual({ tracked: ["new name.txt", "é.txt", "plain.txt"], untracked: ["dir sub/"] });
  });

  it("an untracked folder that the update would fill, and a renamed file the update changes, count as overlap and are named", async () => {
    const w = world(["Repo A"]);
    w.advance(w.repos[0], "docs/new.txt", "n");
    write(w.repos[0].path, "docs/mine.txt", "x\n");
    const { u, log } = ui(w.repos, {}, "auto");
    const calls: { args: string[]; cwd: string }[] = [];
    await manager(u, calls).run("open");
    expect(calls).toEqual([]);
    expect(log.asked[0].message).toBe("Repo A is 1 commit behind staging · no conflicts, but your uncommitted changes touch 1 of the changed files");
  });
});

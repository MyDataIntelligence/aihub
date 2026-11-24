import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The "Open Repo Set" controller against a fake vscode and a fake CLI: which steps are asked, what is
 * pre-selected, and that "this window" really reopens this window on the set (vscode.openFolder), not a `code -r`.
 */

interface FakePick {
  title: string;
  placeholder: string;
  labels: string[];
  active: string;
}

const h = vi.hoisted(() => ({
  picks: [] as FakePick[],
  answers: [] as ((labels: string[], active: string) => string | undefined)[],
  calls: [] as string[][],
  commands: [] as unknown[][],
  errors: [] as string[],
  infos: [] as string[],
  progress: [] as string[],
  cli: (_args: string[]): string => "",
}));

vi.mock("vscode", () => {
  const createQuickPick = () => {
    const accept: (() => void)[] = [];
    const hide: (() => void)[] = [];
    const qp = {
      title: "",
      placeholder: "",
      items: [] as { label: string; kind?: number }[],
      activeItems: [] as { label: string }[],
      selectedItems: [] as { label: string }[],
      busy: false,
      matchOnDescription: false,
      matchOnDetail: false,
      ignoreFocusOut: false,
      onDidAccept: (f: () => void) => (accept.push(f), { dispose() {} }),
      onDidHide: (f: () => void) => (hide.push(f), { dispose() {} }),
      show() {
        const tick = () => {
          if (qp.busy || !qp.items.length) return void setTimeout(tick, 1);
          const rows = qp.items.filter((i) => i.kind !== -1);
          const active = (qp.activeItems[0] ?? rows[0]).label;
          h.picks.push({ title: qp.title, placeholder: qp.placeholder, labels: rows.map((i) => i.label), active });
          const answer = h.answers.shift()?.(rows.map((i) => i.label), active);
          const it = rows.find((i) => i.label === answer);
          if (!it) return hide.forEach((f) => f());
          qp.selectedItems = [it];
          accept.forEach((f) => f());
        };
        setTimeout(tick, 1);
      },
      hide() {
        hide.forEach((f) => f());
      },
      dispose() {},
    };
    return qp;
  };
  return {
    window: {
      createQuickPick,
      showQuickPick: vi.fn(),
      showInputBox: vi.fn(async () => undefined),
      showErrorMessage: vi.fn(async (m: string) => void h.errors.push(m)),
      showWarningMessage: vi.fn(async (m: string) => void h.errors.push(m)),
      showInformationMessage: vi.fn(async (m: string) => void h.infos.push(m)),
      withProgress: vi.fn(async (o: { title: string }, f: () => Promise<unknown>) => (h.progress.push(o.title), f())),
    },
    workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }), workspaceFolders: [] },
    commands: { executeCommand: vi.fn(async (...a: unknown[]) => void h.commands.push(a)), registerCommand: vi.fn() },
    Uri: { file: (p: string) => ({ fsPath: p, scheme: "file" }) },
    QuickPickItemKind: { Separator: -1 },
    ProgressLocation: { Notification: 15 },
  };
});

vi.mock("../src/cli", () => ({
  makeRunner: () => async (args: string[]) => (h.calls.push(args), h.cli(args)),
  readJson: async (run: (a: string[], c: string) => Promise<string>, args: string[], cwd: string) => JSON.parse(await run([...args, "--json"], cwd)),
}));

const { RepoSetController, readLocalSet } = await import("../src/repoSetUi");

const groups = [{ name: "pipeline", source: "team", repos: ["repo-a", "repo-b", "repo-c"].map((n) => ({ name: n, path: `/w/${n}` })), present: ["repo-a", "repo-b", "repo-c"], missing: [] }];
const branches = {
  repos: ["repo-a", "repo-b", "repo-c"],
  current: { "repo-a": "develop", "repo-b": "develop", "repo-c": "main" },
  branches: [
    { name: "main", in: ["repo-a", "repo-b", "repo-c"], missing: [] },
    { name: "develop", in: ["repo-a", "repo-b", "repo-c"], missing: [] },
    { name: "feature/story-7", in: ["repo-a", "repo-b"], missing: ["repo-c"] },
  ],
};
const result = (branch: string, mode: string) => ({
  group: "pipeline",
  branch,
  mode,
  folder: "/w/worktrees/x",
  workspace: "/w/worktrees/x/pipeline.code-workspace",
  opened: false,
  repos: ["repo-a", "repo-b", "repo-c"].map((n) => ({ repo: n, ok: true, state: "existing", branch, note: "worktree", path: `/w/worktrees/x/${n}` })),
});

const controller = () =>
  new RepoSetController({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } } as never, { cwd: () => "/w/repo-a", log: () => {}, refresh: () => {} });

const startsWith = (prefix: string) => (labels: string[]) => labels.find((l) => l.includes(prefix));

beforeEach(() => {
  h.picks = [];
  h.answers = [];
  h.calls = [];
  h.commands = [];
  h.errors = [];
  h.infos = [];
  h.progress = [];
  h.cli = (args) => {
    if (args[0] === "repos") return JSON.stringify({ repos: [] });
    if (args[1] === "groups") return JSON.stringify(groups);
    if (args[1] === "branches") return JSON.stringify(branches);
    if (args[1] === "open") return JSON.stringify(result(args[args.indexOf("--branch") + 1], args[args.indexOf("--mode") + 1]));
    return "";
  };
});

describe("Open Repo Set, the whole flow", () => {
  it("worktrees, this window: reopens THIS window on the set's workspace file, the CLI starts no VS Code", async () => {
    h.answers.push(startsWith("pipeline"), startsWith("feature/story-7"), startsWith("Worktrees, this window"));
    await controller().open();
    const open = h.calls.find((a) => a[1] === "open")!;
    expect(open).toEqual(expect.arrayContaining(["--group", "pipeline", "--branch", "feature/story-7", "--mode", "worktree", "--window", "none"]));
    expect(h.commands).toEqual([["vscode.openFolder", { fsPath: "/w/worktrees/x/pipeline.code-workspace", scheme: "file" }, { forceReuseWindow: true }]]);
    expect(h.errors).toEqual([]);
  });

  it("new window and the switch variant open the workspace with the matching option", async () => {
    h.answers.push(startsWith("pipeline"), startsWith("develop"), startsWith("Switch the checkouts, new window"));
    await controller().open();
    expect(h.calls.find((a) => a[1] === "open")).toEqual(expect.arrayContaining(["--mode", "switch", "--window", "none"]));
    expect(h.commands[0][2]).toEqual({ forceNewWindow: true });
  });

  it("step 2 has the current branch on top and focused, with titles 'stap n/3' and what was chosen; no progress toast in between", async () => {
    h.answers.push(startsWith("pipeline"), (_l, active) => active, startsWith("Worktrees, new window"));
    await controller().open();
    expect(h.picks.map((p) => p.title)).toEqual(["Open Repo Set · stap 1/3", "Open Repo Set · stap 2/3 · pipeline", "Open Repo Set · stap 3/3 · pipeline · develop"]);
    expect(h.picks[1].labels[0]).toContain("develop");
    expect(h.picks[1].active).toContain("develop");
    expect(h.progress).not.toContain("Reading the branches...");
    expect(h.calls.find((a) => a[1] === "open")).toEqual(expect.arrayContaining(["--branch", "develop"]));
  });

  it("a branch passed in (a story or a set) is not asked again, and the branches are not even read", async () => {
    h.answers.push(startsWith("Worktrees, this window"));
    await controller().open("pipeline", "feature/story-7");
    expect(h.picks.map((p) => p.title)).toEqual(["Open Repo Set · stap 3/3 · pipeline · feature/story-7"]);
    expect(h.calls.some((a) => a[1] === "branches")).toBe(false);
  });

  it("reads the branches of a group once: picking it again uses the cache", async () => {
    const c = controller();
    for (let i = 0; i < 2; i++) {
      h.answers.push(startsWith("pipeline"), (_l, a) => a, () => undefined);
      await c.open();
    }
    expect(h.calls.filter((a) => a[1] === "branches")).toHaveLength(1);
  });

  it("the repo opener: a repository that is not cloned is cloned first, then goes into the set with the local ones", async () => {
    const vscode = await import("vscode");
    (vscode.window.showQuickPick as any).mockResolvedValueOnce({ value: "" }); // "Continue" (do not save as a group)
    h.cli = (args) => {
      if (args[0] === "repos" && args[1] === "local") return JSON.stringify({ repos: [{ name: "repo-a", path: "/w/repo-a", branch: "develop", key: "o/p/repo-a" }] });
      if (args[0] === "repos" && args[1] === "ado") return JSON.stringify({ repos: [{ project: "p", name: "repo-a", key: "o/p/repo-a", path: "/w/repo-a", branch: "develop" }, { project: "p", name: "repo-z", key: "o/p/repo-z" }] });
      if (args[0] === "repos" && args[1] === "clone") return JSON.stringify([{ repo: "repo-z", project: "p", path: "/w/repo-z", status: "cloned" }]);
      if (args[1] === "groups") return JSON.stringify(groups);
      if (args[1] === "branches") return JSON.stringify(branches);
      if (args[1] === "open") return JSON.stringify(result(args[args.indexOf("--branch") + 1], "worktree"));
      return "";
    };
    h.answers.push((l) => l.find((x) => x === "repo-z"), startsWith("develop"), startsWith("Worktrees, new window"));
    await controller().open();
    expect(h.picks[0].labels).toContain("repo-z");
    const clone = h.calls.find((a) => a[1] === "clone")!;
    expect(clone).toEqual(expect.arrayContaining(["--repos", "p/repo-z"]));
    expect(h.calls.find((a) => a[1] === "open")).toEqual(expect.arrayContaining(["--repos", "/w/repo-z", "--branch", "develop"]));
  });

  it("a failure gives a clear message, the window is not touched", async () => {
    h.cli = (args) => {
      if (args[0] === "repos") return JSON.stringify({ repos: [] });
    if (args[1] === "groups") return JSON.stringify(groups);
      if (args[1] === "branches") return JSON.stringify(branches);
      return JSON.stringify({ ...result("x", "worktree"), workspace: undefined, repos: [{ repo: "repo-a", ok: false, state: "failed", branch: "x", note: "boom" }] });
    };
    h.answers.push(startsWith("pipeline"), (_l, a) => a, startsWith("Worktrees, this window"));
    await controller().open();
    expect(h.commands).toEqual([]);
    expect(h.errors.join("\n")).toMatch(/No repository could be opened on x/);
    expect(h.errors.join("\n")).toContain("repo-a: failed - boom");
  });
});

describe("the status bar after opening", () => {
  it("knows the set from .aihub-set.json above the folder, also without an aihub status answer", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const set = mkdtempSync(join(tmpdir(), "reposet-"));
    for (const n of ["repo-a", "repo-b"]) mkdirSync(join(set, n, "src"), { recursive: true });
    writeFileSync(join(set, ".aihub-set.json"), JSON.stringify({ story: 0, group: "pipeline", branch: "feature/story-7", repos: ["repo-a", "repo-b", "repo-c"].map((n) => ({ name: n, path: join(set, n) })) }));
    expect(await readLocalSet(join(set, "repo-b", "src"))).toEqual({ story: 0, group: "pipeline", branch: "feature/story-7", total: 3, repos: ["repo-a", "repo-b"] });
    expect(await readLocalSet(tmpdir())).toBeNull();
    expect(await readLocalSet(undefined)).toBeNull();
  });
});

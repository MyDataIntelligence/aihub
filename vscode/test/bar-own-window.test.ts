import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  shown: [] as { message: string; detail: string; buttons: string[] }[],
  answer: undefined as string | undefined,
  commands: [] as unknown[][],
}));

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: async (message: string, opts: { detail: string }, ...buttons: string[]) => (h.shown.push({ message, detail: opts.detail, buttons }), h.answer),
  },
  commands: { executeCommand: async (...a: unknown[]) => void h.commands.push(a) },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }), workspaceFolders: undefined },
  ProgressLocation: {},
  QuickPickItemKind: {},
  EventEmitter: class {},
}));

import { answerExisting } from "../src/repoSetUi";

const existing = (repo: string, path: string) => ({ repo, branch: "feature/x", path, target: `C:/sets/story/${repo}`, state: "clean", dirty: 0, unpushed: 0 });
const question = (rows: ReturnType<typeof existing>[]) =>
  JSON.stringify({
    needsChoice: {
      question: "q",
      existing: rows,
      choices: [
        { choice: "move", label: "move it", command: "aihub x --existing move" },
        { choice: "reuse", label: "reuse it", command: "aihub x --existing reuse" },
        { choice: "recreate", label: "recreate it", command: "aihub x --existing recreate" },
      ],
    },
  });

describe("the fourth choice of the question about an existing worktree: Open in Its Own Window", () => {
  beforeEach(() => {
    h.shown.length = 0;
    h.commands.length = 0;
    h.answer = undefined;
  });

  it("is offered after Move, Reuse and Recreate, each with one line that says what happens and where", async () => {
    await answerExisting(question([existing("repo-a", "C:/other/repo-a-x")]), async () => "", { ownWindow: true });
    expect(h.shown[0].buttons).toEqual(["Move", "Reuse", "Recreate", "Open in Its Own Window"]);
    const lines = h.shown[0].detail.split("\n");
    expect(lines).toContain("Move: C:/other/repo-a-x goes to C:/sets/story/repo-a in this set; its work and branch go along");
    expect(lines).toContain("Reuse: C:/other/repo-a-x stays where it is and is used by this set");
    expect(lines).toContain("Recreate: C:/other/repo-a-x is removed and a new worktree is made at C:/sets/story/repo-a");
    expect(lines).toContain("Open in Its Own Window: C:/other/repo-a-x opens in a new window; this set stays exactly as it is");
  });

  it("choosing it opens that folder in a new window, calls no CLI and leaves the set file byte for byte", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aihub-own-"));
    const setFile = join(dir, ".aihub-set.json");
    writeFileSync(setFile, JSON.stringify({ story: 3, branch: "feature/3-a", repos: [] }, null, 2));
    const before = readFileSync(setFile);
    h.answer = "Open in Its Own Window";
    const rerun = vi.fn(async () => "");
    const out = await answerExisting(question([existing("repo-a", "C:/other/repo-a-x")]), rerun, { ownWindow: true });
    expect(out).toBeUndefined();
    expect(rerun).not.toHaveBeenCalled();
    expect(h.commands).toEqual([["vscode.openFolder", { fsPath: "C:/other/repo-a-x" }, { forceNewWindow: true }]]);
    expect(readFileSync(setFile).equals(before)).toBe(true);
  });

  it("Escape changes nothing: no CLI call, no window", async () => {
    h.answer = undefined;
    const rerun = vi.fn(async () => "");
    expect(await answerExisting(question([existing("repo-a", "C:/other/repo-a-x")]), rerun, { ownWindow: true })).toBeUndefined();
    expect(rerun).not.toHaveBeenCalled();
    expect(h.commands).toEqual([]);
  });

  it("the other choices still run the CLI with their answer", async () => {
    h.answer = "Move";
    const rerun = vi.fn(async () => "done");
    expect(await answerExisting(question([existing("repo-a", "C:/o/a")]), rerun, { ownWindow: true })).toBe("done");
    expect(rerun).toHaveBeenCalledWith(["--existing", "move"]);
  });

  it("is not offered when the caller does not allow it, or when the question is about more than one repository", async () => {
    await answerExisting(question([existing("repo-a", "C:/o/a")]), async () => "");
    await answerExisting(question([existing("repo-a", "C:/o/a"), existing("repo-b", "C:/o/b")]), async () => "", { ownWindow: true });
    expect(h.shown[0].buttons).toEqual(["Move", "Reuse", "Recreate"]);
    expect(h.shown[1].buttons).toEqual(["Move", "Reuse", "Recreate"]);
  });
});

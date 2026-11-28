import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addPending, externalTerminal, opencodeLine, parseChangeStart, PENDING_TTL_MS, startArgs, takePending, workingCopyTask } from "../src/bar/change";
import { BAR_COMMANDS } from "../src/bar/types";
import { vscodeRipgrep } from "../src/bar/browse";

describe("change with agent in the bar: the argument and the calls", () => {
  it("needs a repository and a prompt; remote and the panel by default", () => {
    expect(parseChangeStart({ repo: "r", prompt: "x" })).toEqual({ problem: "which repository? ({ project, repo })" });
    expect(parseChangeStart({ project: "p", repo: "r" })).toEqual({ problem: "what should change? ({ prompt })" });
    expect(parseChangeStart({ project: "p", repo: "r", prompt: "x", mode: "cloud" })).toEqual({ problem: "mode is remote or workingCopy" });
    expect(parseChangeStart({ project: "p", repo: "r", prompt: "x", where: "tab" })).toEqual({ problem: "where is panel, newWindow or terminal" });
    expect(parseChangeStart({ project: "p", repo: "r", prompt: " Filter actieve klanten ", selection: { path: "/n/load.py", startLine: 16, endLine: 23 }, story: "4711" })).toMatchObject({
      project: "p",
      repo: "r",
      prompt: "Filter actieve klanten",
      mode: "remote",
      where: "panel",
      story: 4711,
      selection: { path: "/n/load.py", startLine: 16, endLine: 23 },
    });
  });

  it("builds aihub browse change start; the prompt goes in a file", () => {
    const a = parseChangeStart({ project: "test-project", repo: "orders-ingest", branch: "main", newBranch: "feature/4711-x", story: 4711, paths: ["/n/load.py"], selection: { path: "/n/load.py", startLine: 16, endLine: 23 }, prompt: "x" }) as never;
    expect(startArgs(a, "C:/t/prompt.txt")).toEqual(["browse", "change", "start", "--project", "test-project", "--repo", "orders-ingest", "--ref", "main", "--branch", "feature/4711-x", "--story", "4711", "--paths", "/n/load.py", "--selection", "/n/load.py:16-23", "--prompt-file", "C:/t/prompt.txt"]);
  });

  it("writes the task of a working copy with the fixed limits", () => {
    const t = workingCopyTask(parseChangeStart({ project: "p", repo: "orders-ingest", prompt: "Filter actieve klanten", paths: ["/n/load.py"] }) as never, "feature/4711-x", "main");
    expect(t).toContain("Filter actieve klanten");
    expect(t).toContain("on the new branch feature/4711-x, made from main");
    expect(t).toContain("Do not push");
    expect(t).toContain("Run the tests");
  });

  it("starts opencode with a prompt that survives pwsh and cmd, in Windows Terminal or a console window", () => {
    expect(opencodeLine('Read "TASK.md"\nnow', "aihub")).toBe(`opencode --agent aihub --prompt "Read 'TASK.md' now"`);
    expect(externalTerminal("C:/w", "go", { hasWt: true, platform: "win32" })).toEqual({ command: "wt.exe", args: ["-d", "C:/w", "cmd", "/k", 'opencode --prompt "go"'] });
    expect(externalTerminal("C:/w", "go", { hasWt: false, platform: "win32" })).toEqual({ command: "cmd.exe", args: ["/c", "start", "opencode", "/D", "C:/w", "cmd", "/k", 'opencode --prompt "go"'] });
    expect(externalTerminal("/w", "go", { hasWt: false, platform: "linux" })).toBeUndefined();
  });

  it("a new window takes its own start once; an old one is dropped", () => {
    const env = { AIHUB_CONFIG_HOME: mkdtempSync(join(tmpdir(), "aihub-cfg-")) } as NodeJS.ProcessEnv;
    expect(takePending(env, "C:/w/a", 1000)).toBeUndefined();
    addPending(env, { folder: "C:/w/a", line: "opencode --prompt \"a\"", at: 1000 });
    addPending(env, { folder: "C:/w/b", line: "opencode --prompt \"b\"", at: 1000 });
    expect(takePending(env, "c:\\w\\A\\", 2000)?.line).toBe('opencode --prompt "a"');
    expect(takePending(env, "C:/w/a", 2000)).toBeUndefined();
    expect(takePending(env, "C:/w/b", 1000 + PENDING_TTL_MS + 1)).toBeUndefined();
    expect(JSON.parse(readFileSync(join(env.AIHUB_CONFIG_HOME!, "changes", "pending-agent.json"), "utf8"))).toEqual([]);
  });

  it("every change command is in the contract", () => {
    for (const id of ["changeStart", "changeState", "changePush", "changeDiscard", "changeStop", "changeToWorkingCopy"]) expect((BAR_COMMANDS as Record<string, string>)[id]).toBe(`aihub.bar.${id}`);
  });
});

describe("text in files: VS Code's own ripgrep for the local fallback", () => {
  it("finds rg in node_modules, else in node_modules.asar.unpacked", () => {
    const seen = (want: string) => (p: string) => p.replace(/\\/g, "/") === want;
    expect(vscodeRipgrep("C:/vsc/resources/app", seen("C:/vsc/resources/app/node_modules/@vscode/ripgrep/bin/rg.exe"), "win32")?.replace(/\\/g, "/")).toBe("C:/vsc/resources/app/node_modules/@vscode/ripgrep/bin/rg.exe");
    expect(vscodeRipgrep("/opt/vsc/app", seen("/opt/vsc/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg"), "linux")?.replace(/\\/g, "/")).toBe("/opt/vsc/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg");
    expect(vscodeRipgrep("/x", () => false, "linux")).toBeUndefined();
  });
});

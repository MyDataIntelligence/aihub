import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanExclude, editOpencodeConfig, removeTopLevelKeys, topLevelMembers, withoutBlock, withoutCodexEntries } from "../src/lib/legacy.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, fixtureText, makeRepo, sh, tmp, write } from "./helpers.js";

const BLOCK = "<!-- aihub:skills:start -->\n## AI Context Hub\n\nUse hub call.\n<!-- aihub:skills:end -->\n";
const put = (p: string, c: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, c, "utf8");
};
const get = (p: string) => readFileSync(p, "utf8");

/** Every file below dir with its content hash: a snapshot to compare before and after. */
function tree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) Object.assign(out, tree(p, base));
    else out[p.slice(base.length)] = createHash("sha256").update(readFileSync(p)).digest("hex");
  }
  return out;
}

const COPILOT_HOOKS =
  JSON.stringify(
    {
      version: 1,
      hooks: {
        sessionStart: [{ type: "command", bash: "'/h/hooks/hub-hook' copilot sessionStart", powershell: "& 'C:\\h\\hooks\\hub-hook.cmd' copilot sessionStart", timeoutSec: 60 }],
        preToolUse: [{ type: "command", bash: "'/h/hooks/hub-push-guard' copilot", powershell: "& ([scriptblock]::Create([IO.File]::ReadAllText('C:\h\hooks\hub-push-guard.ps1'))) copilot", timeoutSec: 5 }],
      },
    },
    null,
    2,
  ) + "\n";

interface World {
  env: NodeJS.ProcessEnv;
  home: string;
  local: string;
  cli: string;
  vsData: string;
  extensions: string[];
  reg: { path: string; type: string; calls: string[][] };
  codeCalls: string[][];
  spawn: (cmd: string, args: string[]) => { status: number; stdout: string; stderr: string };
}

/** A fake machine: every variable that could point at the real one is overridden; code and reg are fakes. */
function world(): World {
  const home = tmp("aihub-legacy-home-");
  const local = join(home, "AppData", "Local");
  const vsData = join(home, "vscode-data");
  const w: World = {
    home,
    local,
    cli: join(local, "AIContextHub", "cli"),
    vsData,
    env: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: local,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      CODEX_HOME: join(home, ".codex"),
      COPILOT_HOME: join(home, ".copilot"),
      OPENCODE_CONFIG_DIR: join(home, ".config", "opencode"),
      AIHUB_HOME: join(home, ".aihub-new"),
      AIHUB_LEGACY_PLATFORM: "win32",
      AIHUB_LEGACY_CODE_ARGS: JSON.stringify(["--user-data-dir", vsData, "--extensions-dir", join(home, "vscode-ext")]),
    },
    extensions: ["FerronHooi.ai-context-hub@2.0.0-dev-e51df08b1", "ferron.worktree-maker@0.1.1", "ms-python.python@2024.1.0"],
    reg: { path: `C:\\Windows;${join(local, "AIContextHub", "cli")};C:\\Tools`, type: "REG_EXPAND_SZ", calls: [] },
    codeCalls: [],
    spawn: () => ({ status: 1, stdout: "", stderr: "" }),
  };
  w.spawn = (cmd, args) => {
    if (cmd === "code") {
      w.codeCalls.push(args);
      if (args.includes("--list-extensions")) return { status: 0, stdout: w.extensions.join("\r\n") + "\r\n", stderr: "" };
      const gone = args[args.indexOf("--uninstall-extension") + 1];
      w.extensions = w.extensions.filter((e) => !e.startsWith(gone + "@"));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (cmd === "reg") {
      w.reg.calls.push(args);
      if (args[0] === "query" && args[1] === "HKCU\\Environment") return { status: 0, stdout: `\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    ${w.reg.type}    ${w.reg.path}\r\n\r\n`, stderr: "" };
      if (args[0] === "query") return { status: 0, stdout: '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    OneDrive    REG_SZ    "C:\\x\\OneDrive.exe"\r\n', stderr: "" };
      if (args[0] === "add") {
        w.reg.path = args[args.indexOf("/d") + 1];
        w.reg.type = args[args.indexOf("/t") + 1];
        return { status: 0, stdout: "", stderr: "" };
      }
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  return w;
}

/** Everything the old Hub wrote, plus look-alikes of the user's that must survive. */
function oldHub(w: World): { mine: string[]; gone: string[] } {
  const { home, env } = w;
  const copilot = env.COPILOT_HOME!;
  const oc = env.OPENCODE_CONFIG_DIR!;
  const codex = env.CODEX_HOME!;
  const mine: string[] = [];
  const gone: string[] = [];

  // Copilot CLI / VS Code Copilot Chat: skills, agent, instructions, hooks
  put(join(copilot, "skills", "aihub-setup", "SKILL.md"), fixtureText("legacy/aihub-setup.SKILL.md"));
  gone.push(join(copilot, "skills", "aihub-setup", "SKILL.md"));
  put(join(copilot, "skills", "aihub-mine", "SKILL.md"), "---\nname: aihub-mine\ndescription: my own skill\n---\nmine\n");
  mine.push(join(copilot, "skills", "aihub-mine", "SKILL.md"));
  put(join(copilot, "skills", "pr-create", "SKILL.md"), "---\nname: pr-create\n---\nnew aihub skill\n");
  mine.push(join(copilot, "skills", "pr-create", "SKILL.md"));
  put(join(copilot, "agents", "hub.agent.md"), fixtureText("legacy/hub.agent.md"));
  gone.push(join(copilot, "agents", "hub.agent.md"));
  put(join(copilot, "agents", "aihub.agent.md"), "---\nname: aihub\n---\nthe new agent\n");
  mine.push(join(copilot, "agents", "aihub.agent.md"));
  put(join(copilot, "instructions", "ai-context-hub.instructions.md"), fixtureText("legacy/ai-context-hub.instructions.md"));
  gone.push(join(copilot, "instructions", "ai-context-hub.instructions.md"));
  put(join(copilot, "instructions", "mine.instructions.md"), "my rules\n");
  mine.push(join(copilot, "instructions", "mine.instructions.md"));
  put(join(copilot, "hooks", "aihub.json"), COPILOT_HOOKS);
  gone.push(join(copilot, "hooks", "aihub.json"));
  put(join(copilot, "hooks", "mine.json"), JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: "command", bash: "echo hi" }] } }));
  mine.push(join(copilot, "hooks", "mine.json"));

  // opencode: skills, agents, rules block, config, plugin, command
  put(join(oc, "skills", "aihub-setup", "SKILL.md"), fixtureText("legacy/aihub-setup.SKILL.md"));
  gone.push(join(oc, "skills", "aihub-setup", "SKILL.md"));
  put(join(oc, "skills", "start-here", "SKILL.md"), "---\nname: start-here\n---\nnew\n");
  mine.push(join(oc, "skills", "start-here", "SKILL.md"));
  put(join(oc, "agents", "hub.md"), '---\ndescription: "AI Context Hub"\nmode: primary\n---\n# AI Context Hub agent (generated by AI Context Hub 2.0.0)\n');
  gone.push(join(oc, "agents", "hub.md"));
  put(join(oc, "agents", "hub-hard.md"), "---\nmode: subagent\n---\nYou take ONE hard step for the hub agent.\n# AI Context Hub agent (generated by AI Context Hub 2.0.0)\n");
  gone.push(join(oc, "agents", "hub-hard.md"));
  put(join(oc, "agents", "reviewer.md"), "---\nmode: subagent\n---\nmy reviewer\n");
  mine.push(join(oc, "agents", "reviewer.md"));
  put(join(oc, "AGENTS.md"), "# My rules\n\nAlways be kind.\n\n" + BLOCK);
  put(join(oc, "opencode.jsonc"), '{\n  // my model\n  "default_agent": "hub",\n  "model": "p/m",\n  "permission": {\n    "skill": {"aihub-*": "deny"},\n    "bash": "ask"\n  }\n}\n');
  put(join(oc, "plugin", "aihub.js"), '// AI Context Hub plugin for opencode (managed: written by "hub hooks install", deleted by "hub hooks remove").\nexport default {};\n');
  gone.push(join(oc, "plugin", "aihub.js"));
  put(join(oc, "plugin", "mine.js"), "export default {};\n");
  mine.push(join(oc, "plugin", "mine.js"));
  put(join(oc, "command", "story-run.md"), "---\ndescription: Run a story\n---\n# Story run\nsteps\nThe developer said: $ARGUMENTS\n");
  gone.push(join(oc, "command", "story-run.md"));
  put(join(oc, "command", "pr.md"), "---\ndescription: pr\n---\n<!-- aihub 1.0.3 -->\nLoad the `pr-create` skill.\nArguments: $ARGUMENTS\n");
  mine.push(join(oc, "command", "pr.md"));

  // Codex: the user's own Stop hook next to the Hub entries
  put(
    join(codex, "hooks.json"),
    JSON.stringify(
      {
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "/usr/bin/my-stop" }] },
            { hooks: [{ type: "command", command: "'/h/hooks/hub-hook' codex Stop", commandWindows: '"C:\\h\\hooks\\hub-hook.cmd" codex Stop', timeout: 5 }] },
          ],
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "'/h/hooks/hub-push-guard' codex", commandWindows: 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\h\\hooks\\hub-push-guard.ps1" codex', timeout: 5 }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "'/x/github-hook.sh' codex SessionStart" }] }],
        },
      },
      null,
      2,
    ),
  );

  // data, CLI package, hook runner
  const cli = w.cli;
  for (const f of ["hub", "hub.cmd", "hub.ps1", "hub-copilot.cmd", "VERSION", "RELEASE-NOTES.md", "lib/hub-standalone.jar", "runtime/bin/java.exe", "skills/manifest.json", "templates/user-story-standard.md"]) put(join(cli, f), "x");
  put(join(cli, "repos.json"), JSON.stringify({ repos: {} }));
  put(join(cli, "logs", "hub.log"), "log");
  put(join(w.local, "AIContextHub", "instances", "1-2.json"), "{}");
  put(join(w.local, "AIContextHub", "standalone", "hooks", "hub-hook.cmd"), "@echo off");
  put(join(w.local, "AIContextHub", "standalone", "hooks", "hub-hook"), "#!/bin/sh");
  put(join(w.local, "AIContextHub", "standalone", "hooks", "hub-push-guard"), "#!/bin/sh");
  put(join(w.local, "AIContextHub", "standalone", "hooks", "endpoints", "k"), "http://127.0.0.1:1");
  put(join(w.local, "AIContextHub", "standalone", "hooks", "launcher"), "x");
  // the new aihub's own folder under ~/.aihub is not the old Hub's
  put(join(home, ".aihub", "events", "e.jsonl"), "{}");
  mine.push(join(home, ".aihub", "events", "e.jsonl"));

  // VS Code: settings with comments, the old extension's storage
  put(join(w.vsData, "User", "settings.json"), '{\n  // keep me\n  "editor.fontSize": 14,\n  "aiContextHub.bar": {\n    "a": 1\n  },\n  "aiContextHub.autoStart": true,\n  "files.autoSave": "off", // mine\n  "aiContextHub.port": 5\n}\n');
  put(join(w.vsData, "User", "globalStorage", "FerronHooi.ai-context-hub", "settings.json"), "{}");
  gone.push(join(w.vsData, "User", "globalStorage", "FerronHooi.ai-context-hub"));
  put(join(w.vsData, "User", "globalStorage", "ms-python.python", "x.json"), "{}");
  mine.push(join(w.vsData, "User", "globalStorage", "ms-python.python", "x.json"));
  return { mine, gone };
}

/** A repository the old Hub worked in. */
function oldRepo(): { dir: string; mine: string[]; gone: string[] } {
  const { dir } = makeRepo();
  const mine: string[] = [];
  const gone: string[] = [];
  put(join(dir, ".aihub", "tmp", "pr.md"), "scratch");
  gone.push(join(dir, ".aihub"));
  put(join(dir, ".github", "skills", "aihub-setup", "SKILL.md"), fixtureText("legacy/aihub-setup.SKILL.md"));
  gone.push(join(dir, ".github", "skills", "aihub-setup", "SKILL.md"));
  put(join(dir, ".github", "skills", "aihub-team", "SKILL.md"), "---\nname: aihub-team\n---\nteam skill\n");
  mine.push(join(dir, ".github", "skills", "aihub-team", "SKILL.md"));
  put(join(dir, ".github", "instructions", "ai-context-hub.instructions.md"), fixtureText("legacy/ai-context-hub.instructions.md"));
  gone.push(join(dir, ".github", "instructions", "ai-context-hub.instructions.md"));
  write(dir, "AGENTS.md", "# Team rules\n\n" + BLOCK);
  sh(dir, ["add", "AGENTS.md"]);
  sh(dir, ["commit", "-m", "team agents file"]);
  mine.push(join(dir, "AGENTS.md"));
  const exclude = join(dir, ".git", "info", "exclude");
  put(
    exclude,
    "# my own\n*.scratch\n\n# AI Context Hub: GitHub Copilot handoff folders (local only)\n/.aihub/\n# AI Context Hub: local Copilot instructions and skills (never committed)\n/.github/instructions/ai-context-hub.instructions.md\n/.github/skills/aihub-*/\n/.aihub/\n# AI Context Hub: its own state files (local only)\n/.idea/copilot-context-bridge.xml\n/keep-me.txt\n",
  );
  const hooks = join(dir, ".git", "hooks");
  put(
    join(hooks, "pre-commit"),
    '#!/bin/sh\n# >>> AI Context Hub quality check (managed block; edit outside it) >>>\naihub_hook_dir=$(dirname "$0")\nif [ -f "$aihub_hook_dir/pre-commit.before-aihub" ]; then "$aihub_hook_dir/pre-commit.before-aihub" "$@" || exit $?; fi\nexit 0\n# <<< AI Context Hub quality check <<<\n',
  );
  put(join(hooks, "pre-commit.before-aihub"), "#!/bin/sh\necho my own pre-commit\n");
  put(join(hooks, "pre-push"), "#!/bin/sh\necho my own pre-push\n");
  mine.push(join(hooks, "pre-push"));
  put(join(dir, ".idea", "copilot-context-bridge.xml"), "<project/>");
  gone.push(join(dir, ".idea"));
  put(join(dir, ".git", "aihub-port"), "1234\n");
  gone.push(join(dir, ".git", "aihub-port"));
  put(join(dir, ".vscode", "settings.json"), '{\n  "aiContextHub.engine": "standalone",\n  "editor.tabSize": 2\n}\n');
  return { dir, mine, gone };
}

async function legacy(w: World, args: string[], cwd: string) {
  const { ctx, lines, errs } = ctxFor(cwd, fakeFetch([]).fn);
  ctx.env = w.env;
  ctx.spawn = (cmd, a) => w.spawn(cmd, a);
  const code = await main(["legacy", "remove", ...args], ctx);
  return { code, out: lines.join("\n"), errs };
}

describe("aihub legacy remove", () => {
  it("lists the old Hub by group and changes nothing without --yes", async () => {
    const w = world();
    oldHub(w);
    const r = oldRepo();
    const before = [tree(w.home), tree(r.dir)];
    for (const args of [["--repos", r.dir], ["--repos", r.dir, "--dry-run"], ["--repos", r.dir, "--dry-run", "--yes"]]) {
      const res = await legacy(w, args, tmp());
      expect(res.code).toBe(0);
      for (const group of ["VS Code extension", "CLI package", "Skills, agents and rules", "Hooks", "Registry", "Files and data", "Settings", "Per-repo leftovers"]) expect(res.out).toContain(group);
      expect(res.out).toMatch(/uninstall FerronHooi\.ai-context-hub@2\.0\.0/);
      expect(res.out).toContain("aihub-mine");
      expect(res.out).toMatch(/Nothing was changed|dry-run: nothing was changed/);
    }
    expect([tree(w.home), tree(r.dir)]).toEqual(before);
    expect(w.codeCalls.every((c) => c.includes("--list-extensions"))).toBe(true);
    expect(w.reg.calls.every((c) => c[0] === "query")).toBe(true);
  });

  it("removes every Hub-owned artifact and leaves the user's look-alikes", async () => {
    const w = world();
    const hub = oldHub(w);
    const repo = oldRepo();
    const res = await legacy(w, ["--yes", "--repos", repo.dir], tmp());
    expect(res.errs).toEqual([]);
    expect(res.code).toBe(0);
    for (const p of [...hub.gone, ...repo.gone]) expect(existsSync(p), `still there: ${p}`).toBe(false);
    for (const p of [...hub.mine, ...repo.mine]) expect(existsSync(p), `lost: ${p}`).toBe(true);
    // the package, its data and the hook runner are gone, the root too
    expect(existsSync(join(w.local, "AIContextHub"))).toBe(false);
    // the shared files lost only the Hub's part
    expect(get(join(w.env.OPENCODE_CONFIG_DIR!, "AGENTS.md"))).toBe("# My rules\n\nAlways be kind.\n");
    const cfg = get(join(w.env.OPENCODE_CONFIG_DIR!, "opencode.jsonc"));
    expect(cfg).toContain("// my model");
    expect(cfg).toContain('"model": "p/m"');
    expect(cfg).toContain('"bash": "ask"');
    expect(cfg).not.toMatch(/default_agent|aihub-\*/);
    const codex = JSON.parse(get(join(w.env.CODEX_HOME!, "hooks.json")));
    expect(codex.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "/usr/bin/my-stop" }] }]);
    expect(codex.hooks.SessionStart[0].hooks[0].command).toContain("github-hook.sh");
    expect(codex.hooks.PreToolUse).toBeUndefined();
    expect(get(join(w.vsData, "User", "settings.json"))).toBe('{\n  // keep me\n  "editor.fontSize": 14,\n  "files.autoSave": "off" // mine\n}\n');
    expect(get(join(repo.dir, ".vscode", "settings.json"))).toBe('{\n  "editor.tabSize": 2\n}\n');
    // the repository
    expect(get(join(repo.dir, ".git", "info", "exclude"))).toBe("# my own\n*.scratch\n\n/keep-me.txt\n");
    expect(get(join(repo.dir, ".git", "hooks", "pre-commit"))).toContain("my own pre-commit");
    expect(existsSync(join(repo.dir, ".git", "hooks", "pre-commit.before-aihub"))).toBe(false);
    expect(get(join(repo.dir, ".git", "hooks", "pre-push"))).toBe("#!/bin/sh\necho my own pre-push\n");
    expect(res.out).toContain("aihub-mine");
    // code and the registry
    expect(w.codeCalls.filter((c) => c.includes("--uninstall-extension")).map((c) => c[c.length - 1]).sort()).toEqual(["FerronHooi.ai-context-hub", "ferron.worktree-maker"]);
    expect(w.reg.path).toBe("C:\\Windows;C:\\Tools");
    expect(w.reg.type).toBe("REG_EXPAND_SZ");
    // a second run finds nothing
    const again = await legacy(w, ["--yes", "--repos", repo.dir], tmp());
    expect(again.out, again.out).toContain("nothing of the old AI Context Hub was found");
  });

  it("--keep-data and --keep-settings keep the data and the settings keys", async () => {
    const w = world();
    oldHub(w);
    const repo = oldRepo();
    const res = await legacy(w, ["--yes", "--keep-data", "--keep-settings", "--repos", repo.dir], tmp());
    expect(res.code).toBe(0);
    expect(existsSync(join(w.cli, "repos.json"))).toBe(true);
    expect(existsSync(join(w.cli, "hub.ps1"))).toBe(false);
    expect(existsSync(join(w.local, "AIContextHub", "instances", "1-2.json"))).toBe(true);
    expect(existsSync(join(repo.dir, ".aihub", "tmp", "pr.md"))).toBe(true);
    expect(existsSync(join(w.vsData, "User", "globalStorage", "FerronHooi.ai-context-hub"))).toBe(true);
    expect(get(join(w.vsData, "User", "settings.json"))).toContain("aiContextHub.bar");
    // the hook runner is a hook, not data
    expect(existsSync(join(w.local, "AIContextHub", "standalone", "hooks", "hub-hook.cmd"))).toBe(false);
  });

  it("keeps the new 3.x extension, and a repository file that git tracks", async () => {
    const w = world();
    w.extensions = ["FerronHooi.ai-context-hub@3.0.0", "ferron.ai-context-hub@1.54.4"];
    const repo = oldRepo();
    sh(repo.dir, ["add", "-f", ".github/skills/aihub-setup/SKILL.md"]);
    sh(repo.dir, ["commit", "-m", "team copy"]);
    const res = await legacy(w, ["--yes", "--repos", repo.dir], tmp());
    expect(res.code).toBe(0);
    expect(w.codeCalls.filter((c) => c.includes("--uninstall-extension")).map((c) => c[c.length - 1])).toEqual(["ferron.ai-context-hub"]);
    expect(res.out).toContain("the new aihub extension (3.x), kept");
    expect(existsSync(join(repo.dir, ".github", "skills", "aihub-setup", "SKILL.md"))).toBe(true);
    expect(res.out).toContain("tracked by git");
  });

  it("never touches the files of the new aihub", async () => {
    const w = world();
    oldHub(w);
    const newHome = tmp("aihub-new-");
    const env = { ...w.env, AIHUB_OPENCODE_VERSION: "1.19.5", COPILOT_HOME: join(newHome, ".copilot"), OPENCODE_CONFIG_DIR: join(newHome, "oc"), CODEX_HOME: join(newHome, ".codex"), XDG_CONFIG_HOME: join(newHome, "xdg") };
    const { ctx } = ctxFor(tmp(), fakeFetch([]).fn);
    ctx.env = env;
    expect(await main(["skills", "install", "--global", "--client", "all"], ctx)).toBe(0);
    const before = tree(newHome);
    expect(Object.keys(before).length).toBeGreaterThan(20);
    const res = await legacy({ ...w, env }, ["--yes"], tmp());
    expect(res.code).toBe(0);
    expect(tree(newHome)).toEqual(before);
  });

  it("never removes the new aihub's own ~/.aihub even when the old registry names the home as a repository", async () => {
    const w = world();
    oldHub(w);
    put(join(w.cli, "repos.json"), JSON.stringify({ repos: { home: { root: w.home } } }));
    put(join(w.home, ".aihub", "tmp", "x.json"), "{}");
    const before = tree(join(w.home, ".aihub"));
    const res = await legacy(w, ["--yes"], tmp());
    expect(res.code).toBe(0);
    expect(tree(join(w.home, ".aihub"))).toEqual(before);
    expect(res.out).toContain("new aihub's own home");
  });

  it("reports a failing step and still removes the rest", async () => {
    const w = world();
    oldHub(w);
    const inner = w.spawn;
    w.spawn = (cmd, args) => (cmd === "reg" && args[0] === "add" ? { status: 1, stdout: "", stderr: "denied" } : inner(cmd, args));
    const { ctx, errs } = ctxFor(tmp(), fakeFetch([]).fn);
    ctx.env = w.env;
    ctx.spawn = (cmd, a) => w.spawn(cmd, a);
    expect(await main(["legacy", "remove", "--yes"], ctx)).toBe(1);
    expect(errs.join("\n")).toMatch(/could not be removed|failed: remove the CLI folder/);
    expect(existsSync(join(w.cli, "hub.ps1"))).toBe(false);
  });

  it("says so when the VS Code CLI is not there", async () => {
    const w = world();
    oldHub(w);
    const inner = w.spawn;
    w.spawn = (cmd, args) => (cmd === "code" ? { status: 127, stdout: "", stderr: "" } : inner(cmd, args));
    const res = await legacy(w, [], tmp());
    expect(res.out).toContain("extensions were not checked");
  });
});

describe("legacy helpers", () => {
  it("removes JSONC keys: whole-line, multi-line value, last member, comments kept", () => {
    const src = '{\n  // c\n  "a": 1,\n  "aiContextHub.x": [\n    1, 2 // two\n  ],\n  "b": "x, y", /* inline */\n  "aiContextHub.y": {"k": "}"}\n}\n';
    const cut = removeTopLevelKeys(src, (k) => k.startsWith("aiContextHub."));
    expect(cut.removed).toEqual(["aiContextHub.x", "aiContextHub.y"]);
    expect(cut.text).toBe('{\n  // c\n  "a": 1,\n  "b": "x, y" /* inline */\n}\n');
    expect(topLevelMembers("not json")).toEqual([]);
    expect(removeTopLevelKeys('{"aiContextHub.only": 1}', (k) => k.startsWith("aiContextHub.")).text).toBe("{}");
  });

  it("withoutBlock strips only the marked block", () => {
    expect(withoutBlock("mine\n\n" + BLOCK)?.trim()).toBe("mine");
    expect(withoutBlock("no block")).toBeNull();
  });

  it("opencode config: only the exact text the old Hub inserted", () => {
    const created = '{\n  "$schema": "https://opencode.ai/config.json",\n  "default_agent": "hub"\n}\n';
    expect(editOpencodeConfig(created, true).deleteFile).toBe(true);
    expect(editOpencodeConfig('{\n  "$schema": "https://opencode.ai/config.json",\n  "permission": {"skill": {"aihub-*": "deny"}}\n}\n', true).deleteFile).toBe(true);
    expect(editOpencodeConfig('{\n  "default_agent": "build"\n}\n', true).changes).toEqual([]);
    expect(editOpencodeConfig('{\n  "default_agent": "hub",\n  "model": "p/m"\n}\n', false).changes).toEqual([]);
  });

  it("codex hooks: an unparseable file is never touched, an empty result deletes the file", () => {
    expect(withoutCodexEntries("{ not json")).toBeNull();
    const only = JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "'/h/hub-hook' codex Stop" }] }] } });
    const r = withoutCodexEntries(only)!;
    expect(r.removed).toBe(1);
    expect(r.empty).toBe(true);
  });

  it("exclude: a Hub comment takes its Hub lines, not the user's neighbours", () => {
    expect(cleanExclude("/.aihub/\n# AI Context Hub: GitHub Copilot handoff folders (local only)\n/.aihub/\nmine.txt\n").text).toBe("/.aihub/\nmine.txt\n");
  });
});

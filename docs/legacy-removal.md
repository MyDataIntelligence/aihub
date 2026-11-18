# Removing the old AI Context Hub

`aihub legacy remove` takes back everything the first AI Context Hub (v1.x and 2.x: Kotlin core, `hub` CLI package, VS Code
extension, agent hooks) put on a machine, in one command, without the old core running. It removes only what is provably the
old Hub's: a marker the Hub wrote, a generated shape, or an exact name. Your own files, hooks, settings and agents stay.

```sh
aihub legacy remove                 # lists what it would remove, grouped; changes nothing
aihub legacy remove --yes           # removes it
aihub legacy remove --yes --keep-data --keep-settings --repos ~/work
```

| Flag | Meaning |
|---|---|
| `--dry-run` | The default without `--yes`: print the list, change nothing. With `--yes` it still only prints. |
| `--yes` | Act. Without it nothing is changed (the command is not interactive, so a script cannot remove by accident). |
| `--keep-data` | Keep the old Hub's data: `%LOCALAPPDATA%\AIContextHub`, `~/.aihub/{cli,instances,standalone,...}`, `.aihub` folders, the old extension's global storage. |
| `--keep-settings` | Keep the old `aiContextHub.*` keys in VS Code settings. |
| `--repos <dir>[,<dir>]` | Also clean the repositories in `<dir>` (the folder itself and its direct children that are repositories or have a `.aihub` folder). Repeatable. |

Repositories are found from three places: `--repos`, the old CLI's `repos.json` (the repositories where `hub up` ran), and the
repository you are standing in. The registry is read before the CLI package is removed.

Output groups: VS Code extension, CLI package, Skills/agents/rules (per client), Hooks (per client), Registry, Files and data,
Settings, Per-repo leftovers. Below them, "Found but not provably Hub-owned" lists look-alikes that were left alone and why.
Items are removed in that order; a failing item is reported and the rest still goes (exit code 1).

## What the old Hub wrote, and how each item is recognised

Sources: the frozen product in `MyDataIntelligence/extensions` (`archive/ai-context-hub-v2/`: `AgentHookInstaller.kt`,
`HubSkills*.kt`, `HookInstaller.kt`, `agent-cli/hub.ps1` with `hub uninstall`, `scripts/copilot-cli/package/Install-Hub.ps1`,
the old `install/` scripts from the git history, the VS Code extension's `package.json`) and the dev build in the pre-release
`legacy/hub-surface-v2-2026-11-17`.

### VS Code extension

| Item | Where | Recognised as the old Hub's | Removed by |
|---|---|---|---|
| Extension `FerronHooi.ai-context-hub` below 3.0.0 | the VS Code profile | `code --list-extensions --show-versions` gives `id@version`, major < 3. The new thin extension (3.x) has the same id and is kept. | `code --uninstall-extension` |
| Extension `ferron.ai-context-hub` | same | the id the product had before the publisher rename; any version | same |
| Extension `ferron.worktree-maker` | same | Worktree Maker, installed by the old bundle (menu entry 1) and uninstalled by the old Hub install itself | same |
| Settings `aiContextHub.*` | `User/settings.json` of Code, Code - Insiders, VSCodium; `.vscode/settings.json` of the scanned repositories | key prefix `aiContextHub.`; the new extension only uses `aihub.*` | the key is cut out of the JSONC text; comments, order and other keys stay (`--keep-settings` skips) |
| Global storage of the old extension | `<user data>/User/globalStorage/<id>` for the ids above | exact folder name | folder deleted (`--keep-data` skips) |

The old extension also registered a Copilot MCP server definition (`aiContextHub.hubApi`), chat skills, instructions and agents
and language model tools. All of those are contributions of the extension and disappear with it; nothing is written to
`mcp.json` or the user settings for them. `code` must be on the PATH; otherwise the command says so and skips this group.

### CLI package

| Item | Where | Recognised as | Removed by |
|---|---|---|---|
| The package | `%LOCALAPPDATA%\AIContextHub\cli` (else `~/.aihub/cli`; `AIHUB_CLI_HOME` overrides) | folder with `VERSION` and `hub.ps1` or `hub` | the package entries by exact name: `hub`, `hub.cmd`, `hub.ps1`, `hub-copilot.cmd`, `HUB_COMMANDS.md`, `RELEASE-NOTES.md`, `VERSION`, `lib\`, `runtime\` (the bundled Java), `skills\`, `templates\` |
| User PATH entry | `HKCU\Environment\Path` (Windows) | an entry equal to that folder (also `%LOCALAPPDATA%\AIContextHub\cli`) | `reg add ... /t <same type> /f` with the entry left out; the registry type (`REG_EXPAND_SZ`) is kept. Open a new terminal afterwards. |
| Autostart value | `HKCU\...\CurrentVersion\Run` | a value whose command contains `AIContextHub`. The old installers never wrote one; this only covers a hand-made one. | `reg delete /v` |

Protocol handlers, scheduled tasks and machine-wide registry keys were not written by any old installer (checked in the
installer sources; the only registry write was the user PATH), so there is nothing to remove.

### Data of the old Hub (`--keep-data` keeps it)

| Item | Where | Recognised as |
|---|---|---|
| Everything else in the Hub folder | `%LOCALAPPDATA%\AIContextHub\*`: `cli\repos.json`, `cli\run`, `cli\logs`, `instances\`, `standalone\` (core home: settings, stories, caches, `hooks\endpoints`), `config\`, `failure-memory\`, locks, logs | the folder name `AIContextHub` is the product's own; every child that is not the package is data |
| The same on macOS and Linux | `~/.aihub/cli`, `instances`, `standalone`, `failure-memory`, `config/hub-settings.json` | exact names only. `~/.aihub` itself is also used by the new aihub (events, Fabric state) and is never removed as a whole. |

Empty Hub folders are removed at the end; the root `AIContextHub` goes when it is empty.

### Skills, agents and rules per client

Written by `hub skills install` (global) and by the extension. The new aihub never writes a file with these markers or names.

| Client | Item | Where | Recognised as |
|---|---|---|---|
| Copilot CLI / VS Code Copilot Chat (`COPILOT_HOME`, `~/.copilot`) | skills `aihub-*` | `skills/<name>/SKILL.md` | name starts with `aihub-` and the front matter has `generated-by: AI Context Hub` or `aihub-version:`. A look-alike without the marker stays; extra files in the folder stay. A file the new install recorded in its `.aihub-manifest.json` is never touched. |
| | the `hub` agent | `agents/hub.agent.md` | `name: hub` and the header `generated by AI Context Hub` (the new agent is `aihub.agent.md`) |
| | Hub instructions | `instructions/ai-context-hub.instructions.md` | the block `<!-- aihub:skills:start -->` ... `end`; the whole file goes when only the block (and front matter) is in it, otherwise only the block |
| opencode (`OPENCODE_CONFIG_DIR`, `$XDG_CONFIG_HOME/opencode`, `~/.config/opencode`) | skills `aihub-*` | `skills/` | as above |
| | agents `hub` and `hub-hard` | `agents/hub.md`, `agents/hub-hard.md` | header `generated by AI Context Hub` |
| | the `hub` agent, older folder | `agent/hub.md` | same header |
| Codex, Claude Code | a `hub` agent | `<codex home>/agents/hub.toml`, `<claude config>/agents/hub.md` | header `generated by AI Context Hub`; the old Hub never wrote them, so this only covers a copy someone made; a `hub` agent without the header is yours |
| | rules block | `AGENTS.md` | the markers above; the file goes only if nothing else is in it |
| | `"default_agent": "hub"` | `opencode.json(c)` | exactly the text the old installer inserted, and only when the `hub` agent is the Hub's; another `default_agent` is the user's |
| | skill deny rule `"aihub-*": "deny"` | `opencode.json(c)` | exactly the three forms the old installer inserted; a file that is then empty (the Hub created it) is deleted |
| Codex (`CODEX_HOME`, `~/.codex`) | none | | The old Hub never installed skills for Codex; only hooks (below). |
| Claude Code | none | | |

### Hooks per client

Written by the first old core that ran (`AgentHookInstaller`), `hub hooks install`, and the extension.

| Client | Item | Where | Recognised as | Removed by |
|---|---|---|---|---|
| Copilot CLI and VS Code Copilot Chat | the Hub's own hook file | `<copilot home>/hooks/aihub.json` | JSON whose every command runs `hub-hook` or `hub-push-guard` | file deleted; a `aihub.json` that runs anything else stays |
| Codex | entries in the user's file | `<codex home>/hooks.json` | a command that is exactly the quoted runner `hub-hook`/`hub-hook.cmd` followed by `codex <Event>`, or `hub-push-guard` (sh or `powershell -NoProfile -ExecutionPolicy Bypass -File ...hub-push-guard.ps1 codex`); never a substring match | only those entries are removed, the user's hooks and keys stay; the file is deleted when nothing is left; a file that is not valid JSON is never touched |
| opencode | the plugin | `<opencode config>/plugin/aihub.js` (older: `plugins/aihub.js`) | first line `// AI Context Hub plugin for opencode (managed` | file deleted, the folder when empty |
| opencode | `/story-run` command | `command/story-run.md` | ends with `The developer said: $ARGUMENTS` and has no `<!-- aihub <version> -->` stamp (the new aihub command has one and is in the new manifest) | file deleted |
| all | the hook runner | `<hub home>/hooks/hub-hook`, `hub-hook.cmd`, `hub-push-guard`, `hub-push-guard.ps1` (`<hub home>` = `%LOCALAPPDATA%\AIContextHub\standalone`, else `~/.aihub/standalone`) | exact names | files deleted (the rest of `hooks\` is data) |

### Per-repo leftovers

Found in the repositories described above. Anything git tracks is the team's and is never touched; it is listed instead.

| Item | Where | Recognised as | Removed by |
|---|---|---|---|
| `.aihub/` | repository root, or a worktree set folder | the folder (the new aihub keeps its state in `<git common dir>/aihub`), not tracked | folder deleted (`--keep-data` skips) |
| Local skills | `.github/skills/aihub-*/SKILL.md` | marker as above and not tracked | file (and empty folders) deleted |
| Local instructions | `.github/instructions/ai-context-hub.instructions.md` | the Hub block, not tracked | file deleted |
| Shared install blocks | `AGENTS.md`, `.github/copilot-instructions.md` | the block markers | **listed only**: these files are the team's or yours; remove the block by hand |
| `info/exclude` lines | `.git/info/exclude` (common dir of a worktree) | the Hub's comment lines (`# AI Context Hub: GitHub Copilot handoff folders (local only)`, `... local Copilot instructions and skills (never committed)`, `... its own state files (local only)`) and the Hub entries directly below them (`/.aihub/`, the instructions file, `/.github/skills/aihub-*/`, `/.idea/*.xml`); a `/.aihub/` you wrote yourself stays | those lines removed |
| Git hooks | `pre-commit`, `pre-push` in the hooks folder (`core.hooksPath` respected) | the block between `# >>> AI Context Hub quality check` ... `# <<< AI Context Hub quality check <<<` (and `push check`) | only the block is cut; when nothing else is in the hook it is deleted and the user's original (`pre-commit.before-aihub`, `pre-push.before-aihub`) is restored |
| Port file | `.git/aihub-port` | exact name | deleted |

## What it never does

- It never removes the new aihub's skills (`pr-create`, `start-here`, ...), agents (`aihub`, `aihub-runner`), commands or manifest.
- It never edits a tracked file, and never your own hooks, skills, agents or settings keys.
- It does not stop a running old core; close VS Code and agent sessions first so no file is held open.
- It does not touch `AIHUB_*` variables in your environment (the old installers never set any).

## Tests and hooks for tests

`cli/test/legacy.test.ts` builds a fake machine (fake homes, a fake `code` and a fake `reg`, real throw-away git repositories)
with golden copies of old artifacts next to look-alikes that must survive. The command reads these variables for tests and for
isolated runs: `AIHUB_LEGACY_CODE` (the `code` binary), `AIHUB_LEGACY_CODE_ARGS` (a JSON array such as
`["--user-data-dir","/x/data","--extensions-dir","/x/ext"]`, also decides which VS Code user-data folder is scanned) and
`AIHUB_LEGACY_PLATFORM` (`win32`, `darwin`, `linux`).

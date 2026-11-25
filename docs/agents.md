# Agents (optional)

`aihub skills install` also installs two optional agents for opencode, GitHub Copilot, Codex and (on request) Claude Code. They are a thin layer over the skills: the skills stay the source of truth, the agent only says "use the matching skill and its one `aihub` command, ask nothing a skill or `team.yaml` answers". Your default agent is never touched; an aihub agent is only used when you pick it.

| Agent | Kind | For |
|---|---|---|
| `aihub` | primary | Stories, pull requests, pipelines, reviews, Fabric through the skills |
| `aihub-runner` | subagent | Only on request or for independent jobs side by side: one long job (story-run, pipeline-fix, pr-watch, review-process), reported in at most 5 lines. By default the `aihub` agent does long jobs itself, in the chat the user is looking at |
| `aihub-researcher` | subagent | One research angle of a feasibility question (docs, community or live probes); read-only; reports with sources |

The source files live in `agents/<format>/` (`opencode`, `opencode2`, `copilot`, `codex`, `claude`): one body, a front matter per client. `npm run lint:skills` checks that the bodies are equal and that every front matter is valid.

## Where the files go

| Client | Global (`aihub skills install`) | In the repository (`--into-repo`) |
|---|---|---|
| opencode 1.x | `~/.config/opencode/agent/aihub.md`, `aihub-runner.md` (`OPENCODE_CONFIG_DIR` or `XDG_CONFIG_HOME` move it) | `.opencode/agent/` |
| opencode 2.x | `~/.config/opencode/agents/` | `.opencode/agents/` |
| GitHub Copilot (VS Code and Copilot CLI) | `~/.copilot/agents/aihub.agent.md`, `aihub-runner.agent.md` (`COPILOT_HOME` moves it) | `.github/agents/` |
| Codex | `$CODEX_HOME/agents/aihub.toml`, `aihub-runner.toml` (agent name `aihub_runner`: the Codex docs only show underscore names) (default `~/.codex/agents/`) | `.codex/agents/` |
| Claude Code (opt-in: `--client claude`) | `~/.claude/agents/aihub.md`, `aihub-runner.md` (`CLAUDE_CONFIG_DIR` moves it) | `.claude/agents/` |

- **opencode format follows the installed version.** `aihub skills install` runs `opencode --version`: 2.x and newer gets `agents/` with a `permissions` list, everything else (1.x, or opencode not found) gets `agent/` with a `permission` map, which 2.x still translates. If the version changes, `aihub skills update` moves your unmodified aihub files to the other folder; `aihub doctor` shows the version, the format and a fix when the folder is the wrong one.
- Claude Code is not part of `--client all`: opencode also reads `~/.claude/skills`, which would list every skill twice. `--client claude` installs the skills, the slash commands and the agents for Claude Code.
- `--no-agents` skips the agents; `aihub skills uninstall` removes them; `aihub skills update` refreshes them only where they are installed.
- Every file is recorded with its checksum in `.aihub-manifest.json` next to it. A file you edited, or a file with the same name that aihub did not write, is skipped with a message and never overwritten, the same rule as for skills. Your own agents in the same folder are never touched.
- `aihub doctor` has an `agents:<client>` line per client: optional when absent, a fix when the installed copy is older than the CLI.

## Picking the agent

- **opencode**: press Tab in the prompt to cycle through the primary agents and choose `aihub` (or `opencode --agent aihub`), or set `"default_agent": "aihub"` in `opencode.json` to start with it. `aihub-runner` is a subagent: the `aihub` agent does long jobs itself so you can follow them, and uses the runner only when you ask (write `@aihub-runner` in the prompt) or for independent jobs side by side.
- **VS Code (Copilot Chat)**: open chat, select the Copilot harness in the session target, then pick `aihub` in the Agent dropdown. `aihub-runner` is hidden from the dropdown (`user-invocable: false`); the `aihub` agent calls it as a subagent.
  Checked live in VS Code 1.146 (isolated profile, not signed in): `Chat: Open Customizations` > Agents (Local harness) lists `aihub` and `aihub-runner` from `.github/agents/`, from the profile folder `<user data dir>/User/prompts/` and from `~/.copilot/agents/` (it also listed an existing agent there, so the global install location is read). The Copilot harness list stayed empty without a sign-in.
- **Copilot CLI**: type `/agent` and choose `aihub`, or start with `copilot --agent aihub`.
- **Claude Code**: `claude --agent aihub` runs the whole session as the aihub agent; or write "use the aihub-runner subagent to ...". `/agents` shows them.
- **Codex**: agents are subagents of the main thread: write "use the aihub agent for this" or "let aihub-runner follow the pipeline"; `/subagents` shows the threads.

## Permissions

- **opencode**: the agent file carries the permissions, and the `aihub` and `aihub-runner` agents **allow by default**: shell commands (pytest, python, npm, dbt, cat, ls, ...), edits, reads and web fetches run without a prompt. Only a short list is denied: `git push --force`/`-f`, a direct `git push` to `main`, `master`, `staging` or `release/*` (use a pull request), `rm -rf /*` and `rm -rf ~*`, every `az ... delete` (except `az repos pr update`) and `curl|wget ... | sh|bash`; `git reset --hard*` asks. Patterns are ordered, the last match wins. The `aihub-researcher` stays read-only (it asks for anything but `aihub` and `git`). `opencode run` (no terminal to answer) therefore no longer stops on `python -m pytest`. Checked live with opencode 1.19.5 (see docs/live-verification.md); the 2.x `permissions` list is written to the same rules but was not run (no opencode 2.x on the test machine).
- **VS Code and Copilot**: an agent file lists tools (`execute`, `read`, `edit`, `search`, `web`, `agent`) but cannot grant terminal approval. That is the VS Code setting `chat.tools.terminal.autoApprove`, in your user settings. A suggested pattern:

  ```json
  "chat.tools.terminal.autoApprove": {
    "/^aihub\\b/": true,
    "/^git push\\b.*(--force|\\s-f\\b)/": false
  }
  ```

  Allow the commands you trust, for example `"/^(aihub|git|az|npm|python|pytest|dbt)\b/": true`. A `false` rule always asks, and it wins over a `true` rule. VS Code calls the setting a convenience, not a security boundary.
- **Codex**: a custom agent file cannot change the sandbox or approvals; subagents inherit them from the session (`/permissions`). The files therefore carry instructions only. To stop the prompts, start Codex with a profile that sets `approval_policy = "never"` and `sandbox_mode = "workspace-write"` in `~/.codex/config.toml` (`[profiles.aihub]`, then `codex --profile aihub`); the sandbox, not the prompt, then limits what it can touch.
- **Claude Code**: an agent file only lists tools (`Bash, Read, Edit, ...`). Allow the commands in `settings.json`, for example `"permissions": { "allow": ["Bash(aihub:*)", "Bash(git:*)", "Bash(python:*)", "Bash(npm:*)", "Bash(dbt:*)"], "deny": ["Bash(git push --force:*)", "Bash(rm -rf /:*)"] }`. `aihub skills install` prints these settings for the clients it installed.

## The old AI Context Hub

If the old Hub is still installed (its `hub` CLI, skills `aihub-*` with the Hub marker, the Hub rules block, hooks), its skills and rules win over aihub and an agent runs `hub call ...` even when the `aihub` agent is selected. Every aihub agent says never to use the old `hub` CLI; `aihub doctor` reports `legacy-hub` with the fix `aihub legacy remove --dry-run`, and `aihub skills install` prints the same warning. See docs/legacy-removal.md.

## Sources (checked 2026-11-18)

- opencode agents: https://opencode.ai/docs/agents/ ; V1 to V2 changes (`agents/` folder, `permissions` list, `shell` action): https://opencode.ai/docs/migrate-v1 and https://opencode.ai/docs/permissions
- Copilot custom agents: https://docs.github.com/en/copilot/reference/custom-agents-configuration ; https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference ; https://code.visualstudio.com/docs/copilot/customization/custom-agents
- Terminal auto approve: https://code.visualstudio.com/docs/agents/run/approvals
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Codex custom agents (TOML, required keys `name`, `description`, `developer_instructions`): https://learn.chatgpt.com/codex/agent-configuration/subagents

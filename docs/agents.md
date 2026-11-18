# Agents (optional)

`aihub skills install` also installs two optional agents for opencode, GitHub Copilot, Codex and (on request) Claude Code. They are a thin layer over the skills: the skills stay the source of truth, the agent only says "use the matching skill and its one `aihub` command, ask nothing a skill or `team.yaml` answers". Your default agent is never touched; an aihub agent is only used when you pick it.

| Agent | Kind | For |
|---|---|---|
| `aihub` | primary | Stories, pull requests, pipelines, reviews, Fabric through the skills |
| `aihub-runner` | subagent | One long job: story-run, pipeline-fix, pr-watch, review-process; reports in at most 5 lines |

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

- **opencode**: press Tab in the prompt to cycle through the primary agents and choose `aihub` (or `opencode --agent aihub`), or set `"default_agent": "aihub"` in `opencode.json` to start with it. `aihub-runner` is a subagent: the `aihub` agent hands long jobs to it, or you write `@aihub-runner` in the prompt.
- **VS Code (Copilot Chat)**: open chat, select the Copilot harness in the session target, then pick `aihub` in the Agent dropdown. `aihub-runner` is hidden from the dropdown (`user-invocable: false`); the `aihub` agent calls it as a subagent.
  Checked live in VS Code 1.146 (isolated profile, not signed in): `Chat: Open Customizations` > Agents (Local harness) lists `aihub` and `aihub-runner` from `.github/agents/`, from the profile folder `<user data dir>/User/prompts/` and from `~/.copilot/agents/` (it also listed an existing agent there, so the global install location is read). The Copilot harness list stayed empty without a sign-in.
- **Copilot CLI**: type `/agent` and choose `aihub`, or start with `copilot --agent aihub`.
- **Claude Code**: `claude --agent aihub` runs the whole session as the aihub agent; or write "use the aihub-runner subagent to ...". `/agents` shows them.
- **Codex**: agents are subagents of the main thread: write "use the aihub agent for this" or "let aihub-runner follow the pipeline"; `/subagents` shows the threads.

## Permissions

- **opencode**: the agent file carries the permissions. `aihub`, `aihub *`, `cat *`, `git *`, `az repos *`, `az boards *`, `az pipelines *` run without a prompt; `git push` with a force flag and `rm -rf*` ask; every other shell command asks (patterns are ordered, the last match wins). Reading, searching, editing and loading skills keep opencode's default. `opencode run` (no terminal to answer) rejects what would ask. Checked live with opencode 1.19.5: `aihub --version` and `git status` ran, `git push --force origin HEAD` and `echo x` were stopped.
- **VS Code and Copilot**: an agent file lists tools (`execute`, `read`, `edit`, `search`, `web`, `agent`) but cannot grant terminal approval. That is the VS Code setting `chat.tools.terminal.autoApprove`, in your user settings. A suggested pattern:

  ```json
  "chat.tools.terminal.autoApprove": {
    "/^aihub\\b/": true,
    "/^git push\\b.*(--force|\\s-f\\b)/": false
  }
  ```

  A `false` rule always asks, and it wins over a `true` rule. VS Code calls the setting a convenience, not a security boundary.
- **Codex**: a custom agent file cannot change the sandbox or approvals; subagents inherit them from the session (`/permissions`). The files therefore carry instructions only.
- **Claude Code**: an agent file only lists tools (`Bash, Read, Edit, ...`). Allow the commands in `settings.json`, for example `"permissions": { "allow": ["Bash(aihub:*)", "Bash(git:*)"], "ask": ["Bash(git push --force:*)", "Bash(rm -rf:*)"] }`.

## Sources (checked 2026-11-18)

- opencode agents: https://opencode.ai/docs/agents/ ; V1 to V2 changes (`agents/` folder, `permissions` list, `shell` action): https://opencode.ai/docs/migrate-v1 and https://opencode.ai/docs/permissions
- Copilot custom agents: https://docs.github.com/en/copilot/reference/custom-agents-configuration ; https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference ; https://code.visualstudio.com/docs/copilot/customization/custom-agents
- Terminal auto approve: https://code.visualstudio.com/docs/agents/run/approvals
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Codex custom agents (TOML, required keys `name`, `description`, `developer_instructions`): https://learn.chatgpt.com/codex/agent-configuration/subagents

# Agents (optional)

`aihub skills install` also installs two optional agents for opencode and GitHub Copilot. They are a thin layer over the skills: the skills stay the source of truth, the agent only says "use the matching skill and its one `aihub` command, ask nothing a skill or `team.yaml` answers". Your default agent is never touched; an aihub agent is only used when you pick it.

| Agent | Kind | For |
|---|---|---|
| `aihub` | primary | Stories, pull requests, pipelines, reviews, Fabric through the skills |
| `aihub-runner` | subagent | One long job: story-run, pipeline-fix, pr-watch, review-process; reports in at most 5 lines |

The source files live in `agents/opencode/` and `agents/copilot/` (same body, two front matters; `npm run lint:skills` checks that).

## Where the files go

| Client | Global (`aihub skills install`) | In the repository (`--into-repo`) |
|---|---|---|
| opencode | `~/.config/opencode/agents/aihub.md`, `aihub-runner.md` (`OPENCODE_CONFIG_DIR` or `XDG_CONFIG_HOME` move it) | `.opencode/agents/` |
| GitHub Copilot (VS Code and Copilot CLI) | `~/.copilot/agents/aihub.agent.md`, `aihub-runner.agent.md` (`COPILOT_HOME` moves it) | `.github/agents/` |
| Codex | none (see below) | none |

- `--no-agents` skips them; `aihub skills uninstall` removes them; `aihub skills update` refreshes them only where they are installed.
- Every file is recorded with its checksum in `.aihub-manifest.json` next to it. A file you edited, or a file with the same name that aihub did not write, is skipped with a message and never overwritten, the same rule as for skills. Your own agents in the same folder are never touched.
- `aihub doctor` has an `agents:<client>` line per client: optional when absent, a fix when the installed copy is older than the CLI.

## Picking the agent

- **opencode**: press Tab in the prompt to cycle through the primary agents and choose `aihub`, or set `"default_agent": "aihub"` in `opencode.json` to start with it. `aihub-runner` is a subagent: the `aihub` agent hands long jobs to it, or you write `@aihub-runner` in the prompt.
- **VS Code (Copilot Chat)**: open chat, select the Copilot harness in the session target, then pick `aihub` in the Agent dropdown. `aihub-runner` is hidden from the dropdown (`user-invocable: false`); the `aihub` agent calls it as a subagent.
- **Copilot CLI**: type `/agent` and choose `aihub`, or start with `copilot --agent aihub`.

## Permissions

- **opencode**: the agent file carries the permissions. `aihub *`, `git *`, `az repos *`, `az boards *`, `az pipelines *` run without a prompt; `git push` with a force flag and `rm -rf*` ask; every other shell command asks; reading, searching and loading skills are allowed. Edits are not listed, so opencode applies its own default; add `- action: edit` / `resource: "*"` / `effect: allow` to your copy (it then counts as your file and is no longer overwritten) if you want edits without a prompt. Rules are ordered and the last match wins.
- **VS Code and Copilot**: an agent file lists tools (`execute`, `read`, `edit`, `search`, `web`, `agent`) but cannot grant terminal approval. That is the VS Code setting `chat.tools.terminal.autoApprove`, in your user settings. A suggested pattern:

  ```json
  "chat.tools.terminal.autoApprove": {
    "/^aihub\\b/": true,
    "/^git push\\b.*(--force|\\s-f\\b)/": false
  }
  ```

  A `false` rule always asks, and it wins over a `true` rule. VS Code calls the setting a convenience, not a security boundary.

## Claude Code and Codex

- Claude Code reads subagents from `~/.claude/agents/<name>.md`, but `aihub skills install` does not install for Claude Code yet, so there is no aihub agent for it.
- Codex reads agents as TOML files in `~/.codex/agents/` (`name`, `description`, `developer_instructions`). That was found in the Codex docs only through a summary, so aihub does not write them yet; skills and prompts still work as before.

## Sources (checked 2026-11-18)

- opencode agents: https://opencode.ai/docs/agents/ ; V1 to V2 changes (`agents/` folder, `permissions` list, `shell` action): https://opencode.ai/docs/migrate-v1 and https://opencode.ai/docs/permissions
- Copilot custom agents: https://docs.github.com/en/copilot/reference/custom-agents-configuration ; https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference ; https://code.visualstudio.com/docs/copilot/customization/custom-agents
- Terminal auto approve: https://code.visualstudio.com/docs/agents/run/approvals
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Codex subagents: https://learn.chatgpt.com/codex/agent-configuration/subagents

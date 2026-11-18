# Changelog

One `## <version>` heading per release, one bullet per change. `aihub update` shows the bullets between the old and the new version.

## 1.0.3
- `aihub comments reply --reply "<threadId>:<status>:<text>"` (repeatable, no file needed; an agent whose shell may not write files can still answer threads) and a value that starts with `- ` (a markdown bullet, for example `--append-text "- item"`) is accepted after its option.
- `aihub pr list [--mine|--reviewer|--branch] [--status] [--repo] [--json]`, `aihub pr show --pr N [--json]`, reviewers with votes in `aihub status --json` (`pr.reviewers`) and `aihub watch events [--limit] [--since] [--json]` for tools such as the VS Code extension. Shapes: docs/cli-json.md.
- Optional `aihub` and `aihub-runner` agents for opencode (format follows the installed 1.x or 2.x), GitHub Copilot, Codex and Claude Code (`--client claude`, opt-in), installed by `aihub skills install` (`--no-agents` skips, `--into-repo` writes them into the repository, an edited file is never overwritten); `aihub doctor` reports them. Release notes: docs/releases/1.0.3.md.

## 1.0.2
- `/story-run` slash command; `aihub test changed [--run]` runs only the tests for changed files; skills never run the whole suite locally; `aihub commit` names the git hooks it runs and how long they took, `--no-verify` only on request. Release notes: docs/releases/1.0.2.md.

## 1.0.1
- `pr create` fills an empty Changes section from the commits and an empty Tests section with an honest "not run yet"; the agent's text is never overwritten.
- Skills are self-contained (no `_shared` links), so `npx skills add` gives the same skills as `aihub skills install`. Release notes: docs/releases/1.0.1.md.

## 1.0.0
- First stable release: replaces the AI Context Hub with Agent Skills and one daemonless CLI (no MCP). The 0.1.0 command set plus `watch --mine`, `open --last`, `commit`, `repos`, `crossrepo`, `worktree`, `release`, `review`, `wiki`, `workitem`, `evidence`, `port`, `status` and the full `fabric` family (`logs`, `failures`, `auth sp`).
- Benchmark nl: 42/42 correct with aihub against 28/42 for a plain agent, one aihub call per task, no questions. Release notes: docs/releases/1.0.0.md.

## 0.1.0
- `aihub pr create|update`, `comments get|reply`, `story`, `branch`, `cherry-pick`, `pipeline`, `batch`, `work`, `fabric`, `robot` and the other workflow commands.
- `aihub init` proposes team.yaml and the templates as a pull request; it never overwrites a file.
- `aihub skills install|update|diff|uninstall` copies the bundled skills and slash commands into opencode, Codex and Copilot.
- `aihub doctor` checks sign-in, remote, team.yaml, PR template, guideline files and the installed skills.
- `aihub update [--check]` updates the CLI and the skills; `aihub explain <command>` describes a command step by step.
- `--dry-run` prints the writes (git and REST) a command would do; `--verbose` logs the real calls.
- One-line installers (install.ps1, install.sh, Install-aihub.cmd), docs/self-hosting.md and azure-pipelines.yml for teams that run aihub from their own feed.
- `team-pack/`: the copy-ready team files (also the source of `aihub init`), attached to each GitHub release as aihub-team-pack-<version>.zip.
- guidelines: in team.yaml: repository files the agent reads first.

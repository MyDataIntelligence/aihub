# Changelog

One `## <version>` heading per release, one bullet per change. `aihub update` shows the bullets between the old and the new version.

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

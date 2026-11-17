# Changelog

One `## <version>` heading per release, one bullet per change. `aihub update` shows the bullets between the old and the new version.

## 0.1.0
- `aihub pr create|update`, `comments get|reply`, `story`, `branch`, `cherry-pick`, `pipeline`, `batch`, `work`, `fabric`, `robot` and the other workflow commands.
- `aihub init` proposes team.yaml and the templates as a pull request; it never overwrites a file.
- `aihub skills install|update|diff|uninstall` copies the bundled skills and slash commands into opencode, Codex and Copilot.
- `aihub doctor` checks sign-in, remote, team.yaml, PR template, guideline files and the installed skills.
- `aihub update [--check]` updates the CLI and the skills; `aihub explain <command>` describes a command step by step.
- `--dry-run` prints the writes (git and REST) a command would do; `--verbose` logs the real calls.
- One-line installers (install.ps1, install.sh, Install-aihub.cmd), docs/self-hosting.md and zure-pipelines.yml for teams that run aihub from their own feed.
- 	eam-pack/: the copy-ready team files (also the source of ihub init), attached to each GitHub release as ihub-team-pack-<version>.zip.
- guidelines: in team.yaml: repository files the agent reads first.

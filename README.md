# aihub

Agent Skills plus one small CLI that let a coding agent (opencode, GitHub Copilot, Codex) run Azure DevOps team workflows correctly and fast: create and refine stories per template, implement, create and update pull requests, watch them, process review comments, cherry-pick and update branches.

- **Skills** (`skills/`) tell the agent *when* and *how*. They follow the Agent Skills layout (`<skill>/SKILL.md` with optional `scripts/`, `references/`, `assets/`).
- **The CLI** (`cli/`, npm `@ferronhooi/aihub`) does the precise work in one call: templates, the right target branch and merge base, story links, Azure DevOps REST calls. No daemon, no MCP.
- **The VS Code extension** (`vscode/`, `FerronHooi.ai-context-hub`) shows story, branch, PR with votes, pipeline, open threads, Fabric runs and watch events in the status bar and a compact panel. It only reads `aihub ... --json`; actions (`/pr`, `/review`, ...) are put in your chat (Copilot Chat or opencode), never run by the extension. See [vscode/README.md](vscode/README.md).
- **Team knowledge stays in the team repository**: `.agents/skills/_shared/references/team.yaml`, story/commit templates as skill assets, and the pull request template at `.azuredevops/pull_request_template.md`. `aihub init` proposes these files in a pull request and never overwrites existing ones.

## Install

One line (checks Node 18+, installs the CLI and the skills for opencode, Codex and Copilot, runs `aihub doctor`; re-run to update):

```sh
# Windows (PowerShell)
irm https://raw.githubusercontent.com/MyDataIntelligence/aihub/main/install.ps1 | iex
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/MyDataIntelligence/aihub/main/install.sh | sh
```

Or double-click `Install-aihub.cmd`. Flags: `-Next` / `--next` (test version), `-Uninstall` / `--uninstall`, `-WhatIf` / `--dry-run` (print the plan). Or by hand:

```sh
npm i -g @ferronhooi/aihub
aihub skills install
aihub init        # in a team repository: proposes team.yaml + templates as a PR
aihub doctor      # checks sign-in, remote, templates and team file
```

Skills alone, without the installer: `npx skills add MyDataIntelligence/aihub -g -a opencode -a github-copilot -a codex` copies every skill
(each skill folder is self-contained) to `~/.agents/skills`. The slash commands (`/pr`, `/review`, `/story-run`, ...) and the scoped opencode permission for the
skills folder only come from `aihub skills install`, so use that for the full setup.

Status: 1.0.0 (see [docs/releases/1.0.0.md](docs/releases/1.0.0.md)).

## Agents (optional)

`aihub skills install` also installs two optional agents for opencode, GitHub Copilot and Codex (Claude Code with `--client claude`): `aihub` (primary, works through the skills) and `aihub-runner` (subagent, used only on request or for jobs side by side; the `aihub` agent does long jobs itself, where you can follow them). They are a thin layer over the skills; your default agent is untouched and the agents are only used when you pick them. `--no-agents` skips them, `--into-repo` writes them into the repository. How to pick them (opencode Tab, VS Code agent picker, Copilot CLI `/agent`) and the permissions: [docs/agents.md](docs/agents.md).

## Coming from the old AI Context Hub

Had the first AI Context Hub (v1.x/2.x with the Kotlin core, the `hub` command, its skills and hooks, and the old VS Code extension)? One command takes back everything it put on your machine and keeps your own files:

```sh
aihub legacy remove                      # lists what it would remove, changes nothing
aihub legacy remove --yes                # removes it (add --keep-data to keep the old Hub's settings and logs)
aihub legacy remove --yes --repos ~/work # also clean the repositories in ~/work
```

It removes only what is provably the old Hub's (a marker it wrote, a generated shape, an exact name): the old extension below 3.0.0, the CLI package and its PATH entry, its skills, `hub` agent, rules block and hooks for Copilot, opencode and Codex (your own hooks stay), the data under `%LOCALAPPDATA%AIContextHub`, and per repository the `.aihub` folder, Hub lines in `.git/info/exclude` and Hub blocks in git hooks. What it recognises, and how, is in [docs/legacy-removal.md](docs/legacy-removal.md).

## Commands

`aihub pr create|update|changes`, `comments get|reply`, `cherry-pick --from <pr|sha|story> --to <branch>... [--pr]`, `branch update [--rebase]`, `story show|create|refine`, `pipeline follow|status|runs|logs|run`, `batch --select "<query>" --run "<subcommand with {target}>"`, `work`, `pr list|show`, `watch [--pr N|--mine|events]`, `note`, `status`, `repos list|clone`, `workitem create`, `story context`, `pr checks|requeue`, `pipeline retry`, `probe fabric|devops|api` and `research save`, `learn change|repo|validate` (/leer, see [docs/learn.md](docs/learn.md)) (feasibility mode: `/kan-dit`, see [docs/feasibility.md](docs/feasibility.md)). In a worktree set `commit`, `pr create`, `pr update`, `pipeline follow` and `status` take `--all-repos` (one table, unchanged repositories skipped, PRs cross-linked). Every action command appends a line to a local journal (`<git common dir>/aihub/journal.md`, never committed); `status --resume` prints last step, plan done/left and next step without network, `story recall --id N` and `story search "<words>"` find a story back. Prose goes in files (`--body-file`); `--json` is optional everywhere.

`aihub preflight [--plan | --apply]` (/preflight) runs the team's CD deploy-job steps on your PC before a push, from the pipeline YAML itself, in a snapshot of your working tree: local steps by default, `--plan` adds the steps that read your feature workspace, `--apply` the steps that write there (never test, ACC or PRD). `aihub preflight steps` lists the steps to fill the `preflight:` block of team.yaml. See [docs/preflight.md](docs/preflight.md).

Azure DevOps administration (inventory: [docs/devops-inventory.md](docs/devops-inventory.md)): `policy` (branch policies), `library` (variable groups, secrets only via stdin), `repo` (branches, tags, files, commits, statuses, forks), `search code|wiki|items`, `pr abandon|reviewers|vote|labels|status|workitems`, `pipeline def|validate|expand|timeline|tests|coverage|vars|compare|trigger|schedule|authorize|env|approvals|artifacts`, `wiki list|read|create|move|delete|history`, `boards query|sprint|capacity|areas|backlog`, `workitem get|update|comment|link|tag|attach|history`, `testplan`, `artifacts` and `devops` (projects, teams, pools, permissions). Every write has `--dry-run`, every delete needs `--yes`, and ACC/PRD names are refused unless `--allow-env` names them.

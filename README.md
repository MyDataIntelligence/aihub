# aihub

Agent Skills plus one small CLI that let a coding agent (opencode, GitHub Copilot, Codex) run Azure DevOps team workflows correctly and fast: create and refine stories per template, implement, create and update pull requests, watch them, process review comments, cherry-pick and update branches.

- **Skills** (`skills/`) tell the agent *when* and *how*. They follow the Agent Skills layout (`<skill>/SKILL.md` with optional `scripts/`, `references/`, `assets/`).
- **The CLI** (`cli/`, npm `@ferronhooi/aihub`) does the precise work in one call: templates, the right target branch and merge base, story links, Azure DevOps REST calls. No daemon, no MCP.
- **Team knowledge stays in the team repository**: `.agents/skills/_shared/references/team.yaml`, story/commit templates as skill assets, and the pull request template at `.azuredevops/pull_request_template.md`. `aihub init` proposes these files in a pull request and never overwrites existing ones.

## Install

```sh
npm i -g @ferronhooi/aihub
npx skills add MyDataIntelligence/aihub -g -a opencode -a github-copilot -a codex
aihub init        # in a team repository: proposes team.yaml + templates as a PR
aihub doctor      # checks sign-in, remote, templates and team file
```

Status: under construction (see the GitHub issues).

## Commands

`aihub pr create|update|changes`, `comments get|reply`, `cherry-pick --from <pr|sha|story> --to <branch>... [--pr]`, `branch update [--rebase]`, `story show|create|refine`, `pipeline follow|status|runs|logs|run`, `batch --select "<query>" --run "<subcommand with {target}>"`, `work`, `watch`, `note`, `status`. Prose goes in files (`--body-file`); `--json` is optional everywhere.

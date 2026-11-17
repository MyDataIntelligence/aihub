# How it works

```
you / the agent
   |  "maak een PR"                      (words, or a slash command)
   v
skill (SKILL.md)          tells the agent when and how; one command at the end
   |  aihub pr create --body-file pr.md
   v
aihub CLI                 reads team.yaml + templates, runs git, calls the Azure DevOps REST API
   |-- git                (branch, merge-base, commits, push)
   '-- Azure DevOps REST  (pull request, work items, comments, pipelines)
```

The agent decides and writes the prose; the CLI does the precise parts (template, target branch, links, API calls)
in one call. There is no daemon and no MCP server.

## Where files live

| What | Where |
|---|---|
| The CLI | npm package `@ferronhooi/aihub` (or your own scope), `aihub` command |
| Generic skills and slash commands | bundled in the package under `pack/`; `aihub skills install` copies them to `~/.config/opencode/{skills,command}`, `~/.codex/{skills,prompts}`, `~/.copilot/skills` |
| Which files are ours | `.aihub-manifest.json` in each skills folder (checksum per file) and an `aihub <version>` marker in each file |
| Team knowledge | in the team repository: `.agents/skills/_shared/references/team.yaml`, `.agents/skills/_shared/assets/*`, `.azuredevops/pull_request_template.md` |
| Team-specific skills and guidelines | in the team repository (`.agents/skills/`, files listed under `guidelines:`) |

## How update works

`aihub update` asks the registry in your npm config for the newest version. For a global npm install it runs
`npm i -g <package>@latest`; the new CLI then prints the changelog lines between the old and the new version and
rewrites the skills of every client that has them. For other installs it prints the exact command. `--check` only
reports. Files you edited are never overwritten; `aihub skills diff` shows what you changed.

## See and test what happens

`aihub explain <command>`, `--dry-run` (writes are printed, not done) and `--verbose` (real calls on stderr).
`aihub doctor` checks sign-in, remote, team file, templates, guidelines and installed skills.
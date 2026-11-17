# Onboarding

## Install (once per computer)

```sh
npm i -g @ferronhooi/aihub
npx skills add MyDataIntelligence/aihub -g -a opencode -a github-copilot -a codex
```

The first command installs the `aihub` CLI (Node 18 or newer). The second installs the generic skills for opencode,
GitHub Copilot and Codex.

## Per team repository (once per team)

```sh
cd <team-repo>
aihub init      # proposes team.yaml and the templates as a pull request
aihub doctor    # checks sign-in, remote, templates and team file
```

`aihub init` never overwrites existing files. Review and merge the pull request it opens.

## Daily use

Say what you want ("maak een PR", "verwerk de comments") or use a slash command: `/pr`, `/pr-update`, `/cherry-pick`,
`/story`, `/refine`, `/review`, `/watch`. Slash command files are in `commands/opencode/` (opencode) and
`commands/copilot/` (GitHub Copilot prompt files); copy them into the tool's command folder.

## Changing team rules

Team knowledge lives in the team repository, never in this pack:

1. Edit `.agents/skills/_shared/references/team.yaml` (see [team.yaml](team-yaml.md)), the story template
   (`.agents/skills/_shared/assets/story-template.md`), the commit template or `.azuredevops/pull_request_template.md`.
2. Open a pull request and let a teammate review it.
3. After the merge everyone gets the change with a normal pull; run `aihub doctor` to confirm.

Update the generic skills with `npx skills add MyDataIntelligence/aihub -g -a opencode -a github-copilot -a codex`.

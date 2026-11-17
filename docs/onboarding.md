# Onboarding

## Install (once per computer)

```sh
npm i -g @ferronhooi/aihub
aihub skills install --global
```

The first command installs the `aihub` CLI (Node 18 or newer). The second copies the generic skills (bundled in the
npm package) and, where the client supports it, the slash commands into the user directories of opencode
(`~/.config/opencode`, honours `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME`), Codex (`~/.codex`, honours `CODEX_HOME`)
and GitHub Copilot (`~/.copilot/skills`). Use `--client opencode|github-copilot|codex|all` to choose clients. Without
`--global` the skills are installed inside the current repository instead (`.opencode/`, `.agents/skills`, `.github/`).

Every installed file carries an `aihub <version>` marker and is recorded with a checksum in `.aihub-manifest.json`.
Re-running the command updates unchanged files, never overwrites a file you edited, and `aihub skills uninstall
[--global]` removes only files aihub wrote and you did not change.

Alternative without the CLI copy step:

```sh
npx skills add MyDataIntelligence/aihub -g -a opencode -a github-copilot -a codex
```

## Per team repository (once per team)

```sh
cd <team-repo>
aihub init      # proposes team.yaml and the templates as a pull request
aihub doctor    # checks sign-in, remote, templates and team file
```

`aihub init [--repo .] [--no-pr] [--language nl|en]` never overwrites existing files. It prefills `team.yaml` from the git
remote and proposes the story and commit templates, a pull request template (only when none exists where Azure DevOps
looks) and the slash commands (`.opencode/command/`, `.github/prompts/`). It creates the branch `chore/aihub-team-pack`,
commits, pushes and opens a pull request that lists created and skipped files; review and merge it. With `--no-pr` it
only writes the files. `aihub doctor [--json]` prints one `OK` or `FIX` line per check (Node, git, remote, sign-in
method, `team.yaml` against the schema, PR template location, skills per client) with the fix.

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

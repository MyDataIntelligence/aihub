# Onboarding

## For a colleague: five steps

No VS Code extension is needed: aihub is a CLI plus skills for opencode, GitHub Copilot (VS Code chat) and Codex. The AI Context Hub
extension is an optional view on top of the same CLI.

1. **Have Node 18+ and git**, and preferably the Azure CLI (`node -v`, `git --version`, `az version`).
2. **Install the CLI:** `npm i -g @ferronhooi/aihub` (your team may use its own feed: `AIHUB_PACKAGE`, see [self-hosting](self-hosting.md)).
3. **Install the skills:** `aihub skills install`. It writes the skills and slash commands for opencode (`~/.config/opencode`), Codex
   (`~/.codex`) and GitHub Copilot (skills in `~/.copilot/skills`; the slash commands such as `/story-run` as prompt files in VS Code's
   user profile, when VS Code is installed). It prints one note per client about asking before terminal commands.
4. **Sign in to Azure DevOps:** `az login` (or set `AIHUB_ADO_PAT`, or sign in once with git's credential manager).
5. **In your team's repository:** `aihub doctor`. Every line `OK` means you are ready. The team settings (`team.yaml`, templates, the
   language of stories and PRs: `language: nl` or `en`; without it aihub writes English and `aihub doctor` says so) come from the repository; when it has none yet, one person runs `aihub team setup` and `aihub init` once
   (below) and the team merges that pull request.

Then work from the chat: say what you want ("maak een PR", "run story 4711") or use a slash command (`/story-run 4711`, `/pr`, `/review`).
`aihub update` keeps the CLI and the skills current.
## Install (once per computer)

The easy way (checks Node 18+, installs the CLI and the skills, runs `aihub doctor`, prints the next steps; running it again updates):

```sh
irm https://raw.githubusercontent.com/MyDataIntelligence/aihub/main/install.ps1 | iex   # Windows PowerShell
curl -fsSL https://raw.githubusercontent.com/MyDataIntelligence/aihub/main/install.sh | sh   # macOS, Linux
```

`Install-aihub.cmd` does the same on a double-click. Node is never installed silently: if it is missing the script says so and shows `winget install OpenJS.NodeJS.LTS` (or `brew install node`). Flags: `-Next`/`--next`, `-Uninstall`/`--uninstall`, `-WhatIf`/`--dry-run`. From a pipe set `AIHUB_NEXT=1`, `AIHUB_UNINSTALL=1`, `AIHUB_WHATIF=1` (`AIHUB_DRY_RUN=1` for the shell script) or `AIHUB_PACKAGE=@org/aihub` (own feed, see [self-hosting](self-hosting.md)). By hand:

```sh
npm i -g @ferronhooi/aihub
aihub skills install
```

The first command installs the `aihub` CLI (Node 18 or newer). The second copies the generic skills (bundled in the
npm package) and, where the client supports it, the slash commands into the user directories of opencode
(`~/.config/opencode`, honours `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME`), Codex (`~/.codex`, honours `CODEX_HOME`)
and GitHub Copilot (`~/.copilot/skills`). Use `--client opencode|github-copilot|codex|all` to choose clients. Each client gets its
own plain copy. With `--into-repo` the skills go into the current repository instead (`.opencode/`, `.agents/skills`,
`.github/`) for teams that want them there; by default repositories only hold team knowledge.

For opencode the install also writes one scoped rule into `opencode.json` of that config folder:
`permission.external_directory["<config>/skills/**"] = "allow"`. Skills read their templates next to `SKILL.md`, and without the rule opencode asks
first (`opencode run` has no terminal, so it rejects the read and ends the turn). The rule covers the skills folder only, never a global allow;
other keys and rules are kept, a config with comments is not edited (the command prints the line to add), `aihub skills uninstall` removes
the rule again and `aihub doctor` reports it (`permission:opencode`).

Every installed file carries an `aihub <version>` marker and is recorded with a checksum in `.aihub-manifest.json`.
Re-running the command updates unchanged files, never overwrites a file you edited, and `aihub skills update` rewrites the copies of every client that has them from the bundled pack in one go (edited files
stay and are listed), `aihub doctor` flags copies older than the CLI, and `aihub skills uninstall
[--global]` removes only files aihub wrote and you did not change.

More: [how it works](how-it-works.md), [adapting without forking](customize.md), [self-hosting](self-hosting.md). `aihub update`
updates the CLI and the skills (`--check` only reports). Alternative without the CLI copy step (use your team's own repository URL when you self-host):

```sh
npx skills add MyDataIntelligence/aihub -g -a opencode -a github-copilot -a codex
```

## Per team repository (once per team)

```sh
cd <team-repo>
aihub team setup            # detects what it can, writes a proposed team.yaml, lists the open questions
aihub team set <key> <value> # one per answer (the agent asks you and runs it)
aihub init                  # proposes team.yaml and the templates as a pull request
aihub doctor                # checks sign-in, remote, templates and team file
```

`aihub team setup` reads the git remote (organization, project, repository), `origin/HEAD` (default target), the branch
names (feature pattern, release branches), the process of the project (story type, start and finish states), the branch
policies (protected branches, build validation pipelines) and the PR template Azure DevOps already uses; with a Fabric token
at hand also the workspaces named after the repository. What it is sure of goes into the proposal silently; what it can only
guess becomes a numbered question with the choices and the one `aihub team set` command to answer it (at most five). It is not
interactive, so an agent can run it, ask you the questions and run the answers. Detections are cached for a day in the aihub
home. `aihub init` without a `team.yaml` runs the same setup first and stops while questions are open.

The same files are in [`team-pack/`](../team-pack/README.md) (also attached to each release as `aihub-team-pack-<version>.zip`) if you prefer to copy them by hand.

`aihub init [--repo .] [--no-pr] [--language nl|en] [--into-repo]` never overwrites existing files. It prefills `team.yaml` from the git
remote and proposes the story and commit templates, a pull request template (only when none exists where Azure DevOps
looks) (team knowledge only; skills and slash commands live in the user folders and are installed by `aihub skills install`; `--into-repo`
also writes the slash commands into `.opencode/command/` and `.github/prompts/`). With the pack it also proposes (each only when missing) `.github/instructions/<area>.instructions.md` skeletons with `applyTo:` front matter and empty rule bullets for the file types the repository really has, and a short marked block in `AGENTS.md` (created, or appended when the file has no aihub line); `--no-instructions` and `--no-agents-md` skip them. It creates the branch `chore/aihub-team-pack`,
commits, pushes and opens a pull request that lists created and skipped files; review and merge it. With `--no-pr` it
only writes the files. `aihub doctor [--json]` prints one `OK` or `FIX` line per check (Node, git, remote, sign-in
method, `team.yaml` against the schema, keys it could only guess as `aihub team set` lines, Fabric token, PR template location, skills per client) with the fix.

## Daily use

Say what you want ("maak een PR", "verwerk de comments") or use a slash command: `/pr`, `/pr-update`, `/cherry-pick`,
`/story`, `/refine`, `/story-run`, `/review`, `/watch`. `aihub skills install` puts them in place (opencode `command/`, Codex `prompts/`,
GitHub Copilot as prompt files in VS Code's user profile); `aihub skills install --into-repo` puts them in the repository instead.

## Get a notification when something needs you

`aihub watch --mine --notify [--interval 2m]` starts one background poller (no daemon: a detached process that you
can stop) over every active pull request where you are author or reviewer, in the team.yaml project and repositories,
and over the comments of your work items. Per event you get one Windows toast with an Open button (the log line is in
`.git/aihub/events.log`), once per event:

- a new thread or reply by someone else on your PR that you have not answered yet; a reply to a comment of yours on a
  PR you review;
- an @mention of you in a PR thread or a work-item comment;
- a review requested from you (you are a reviewer with no vote yet);
- a vote on your PR (approved, rejected, waiting for the author);
- a failed or broken build policy on your PR;
- your PR completed or abandoned.

The first look only records what already exists (`--include-existing` reports that backlog too). The dedupe state is in
`.git/aihub/watch-state/mine.json`. `aihub watch list` shows it and `aihub watch stop --id mine` ends it. On Windows
`aihub watch --mine --notify --at-logon` also writes a per-user Run entry (`HKCU...Runaihub-watch-mine`) so it starts
at sign-in; `aihub watch --remove-at-logon` removes it. Elsewhere use a login item, cron `@reboot` or a systemd user
unit. Limits: mentions are only found on PRs where you are author or reviewer and on work items assigned to or created by
you (changed in the last 14 days, the newest 25); `--interval` needs a unit (30s, 2m, 1h).

## Changing team rules

Team knowledge lives in the team repository, never in this pack:

1. Change a key with `aihub team set <key> <value>` (keeps comments, checks the schema; `aihub team show` lists the values in use
   and their source) or edit `.agents/skills/_shared/references/team.yaml` (see [team.yaml](team-yaml.md)), the story template
   (`.agents/skills/_shared/assets/story-template.md`), the commit template or `.azuredevops/pull_request_template.md`.
2. Open a pull request and let a teammate review it.
3. After the merge everyone gets the change with a normal pull; run `aihub doctor` to confirm.

Update the generic skills with `aihub skills update` (or the `npx skills add ...` command above).

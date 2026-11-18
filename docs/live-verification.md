# Live verification against ferron-test

Run on 2026-11-17 (Windows, Node 22, `az` signed in) against the synthetic organisation `ferron-test`, project
`test-project`, with a fresh clone of `test-project` (plus `test-developers` for `port`) and `aihub init --no-pr`.
Every object carried the prefix `live-a7c3`; all of it was abandoned, deleted or merged into throw-away branches
afterwards. Second source = `az repos` / `az boards` / `az pipelines` / `az devops wiki` / `git`.

| Command | Live result | Second-source check | Fixed in |
|---|---|---|---|
| `init --no-pr`, `doctor` | team files written, doctor reports skills missing until install | files present, remote parsed | n/a |
| `story create / show / refine` | story 2684 created, no gaps | `az boards work-item show`: title, template sections; Acceptance criteria went into its own field | n/a |
| `story start` | branch created+pushed, linked | **FAIL first**: init writes `active: Active`, Basic process has To do/Doing/Done (bare 400) | PR #20 (error names the project's states) |
| `story link`, `story context` | already linked / PR+branch+files listed | work item relations (Branch, Pull Request) | n/a |
| `pr create` | PR !693, NL characters intact, work item related | `az repos pr show` + `pr work-item list`; **FAIL**: bare `## Related` left as `-` | PR #19 |
| `pr update --section --append-file` | section appended, rest intact | description via `az repos pr show` | n/a |
| `pr changes`, `pr explain`, `pr checks`, `review show` | correct base/head, 5 files, story AB#2684 | compared with the PR in `az` | n/a |
| `pr complete --auto` | message says auto-complete set; PR !710 was completed at once (no policies) | `az repos pr show`: status completed | n/a (message accurate for a policy-less repo) |
| `pr complete` | !711 completed | status completed | n/a |
| `comments get / reply` | thread 1159 replied and set `fixed` | thread via REST: 2 comments, status fixed. Note `resolved` is refused, ADO name is `fixed` | n/a |
| `review post` | thread 1160 on README.md:2 | REST thread has the file and line | n/a |
| `evidence add` | PNG attached, linked in Tests | attachment URL in PR description | n/a |
| `workitem create Task`, `workitem state` | task 2688 child of 2684, To Do -> Doing -> Done | `az boards work-item show` | n/a |
| `workitem create Bug` | refused: the Basic process has no Bug type (VS402323) | project work item types | not a CLI bug (documented) |
| `cherry-pick --from 693 --to release/... --pr` | branch pushed, PR !698 | `git diff` of branch vs target, PR title and refs | n/a |
| `branch update --target` | target merged into the feature branch, pushed | `git log` shows the merge, branch in sync with origin | n/a |
| `port` (test-project -> test-developers) | PR !708 with `src/live/a.txt -> live/a.txt`; a modify of a file missing in the target is reported as conflict, nothing pushed | `git diff` of the port branch; target branch must exist (team.yaml `defaultTarget: main` vs repo default `staging`, error was clear) | n/a |
| `crossrepo status`, `crossrepo link-prs` | 2 PRs in 2 repos, related sections updated | work item has two Pull Request relations | n/a |
| `pipeline runs/status/logs` | runs and failing step log of an existing run | `az pipelines runs list`, timeline | n/a |
| `pipeline run` | queued run 266 on `ci-checks-demo`; **FAIL first**: on a missing branch only "validation errors or warnings" | `az pipelines runs show`: succeeded; REST showed the real reason in `customProperties.ValidationResults` | PR #21 |
| `pipeline follow`, `pipeline retry` | run 266 followed to green; retry of failed run 239 | timeline stage attempt 2 | n/a |
| `release plan / run` | plan from merged PR !711 (story 2700), release branch + PR !712 | `git diff` release branch vs target (b.txt), PR refs | n/a |
| `story finish` | merged branch deleted (local and remote), state Done | `az boards` state Done | n/a |
| `wiki update` (diff, publish, delete) | diff printed, page published, changed, deleted via `az` | `az devops wiki page show` content, then "could not be found" | n/a (Git Bash rewrites `/page` paths: use `MSYS_NO_PATHCONV=1`) |
| `batch --select prs:mine`, `work` | **FAIL first**: 404 on `GET <project>/_apis/connectionData` | after fix 25/25 ok; work lists open stories | PR #18 |
| `status` | story, PR, open threads, next step | matches `az` | n/a |
| `watch --until comment --notify` | event line in `.git/aihub/events.log` within one poll (`--interval` bare number = minutes, use `5s`) | thread added with `az rest` | n/a; toast not captured on screenshot (see below) |
| `open --last --print` | prints the resume command of the event | events.log | n/a |
| `skills install --global`, `skills diff`, `doctor` | into a temp home: 33 skills, 14 commands per client, doctor OK | files in the temp home | n/a |
| `fabric plan`, `robot needed` | read only: no workspaces/suites in team.yaml, nothing to run | n/a | n/a |
| `init` (round 2) | team.yaml prefilled with `active: Doing`, `finished: Done` read from the process states | fresh clone of test-project; `az` states Todo/Doing/Done (categories Proposed/InProgress/Completed) | PR #23 |
| `pr complete --auto` (round 2) | no policies: "completed immediately"; failing Build policy on PR !748: "auto-complete set, it merges when: Build (ruff) is rejected" | `az repos pr show`: completed / active with autoCompleteSetBy | PR #23 |
| `watch --interval 5` (round 2) | refused: "--interval '5' needs a unit: 5s, 5m or 5h" | n/a | PR #23 |
| `repos list / clone` | listed 3 repos; **FAIL first**: `clone --root <missing folder>` gave "git is not available: spawnSync git ENOENT"; the folder is now created | both repos cloned under the root | PR #23 |
| `worktree create / list / remove` (test-project + test-developers) | **FAIL first**: `repositories[].path` in team.yaml was ignored ("not found next to ..."); now honoured. Set created on `feature/2731-live-b2e5-story` in both repos, removed again (branches kept by design) | `git worktree list` in both clones, `git ls-remote` shows the pushed branches | PR #23 |
| `pr requeue` | Build policy of PR !748 (Ruff, fails) requeued | `pr checks`: policy status queued | n/a |
| `crossrepo test-resources` | `tests/test_empty_lines.py` pushed to test-developers as `resources/tests/...` on a test branch | `git diff` origin/staging..branch: one file | n/a |
| `watch --notify` toast (round 2) | event logged and Windows toast delivered: "aihub / PR !748: 1 new comment(s)" with an **Open** button in the notification centre. The banner is suppressed on this machine because Do Not Disturb is on | proof PNGs below | n/a |
| `open --last --print` | `cd '...'; 'codex' 'resume' '--last' 'PR !748: 1 new comment(s) - ga verder'` | matches events.log | n/a |

## Toast proof

Screenshots in `%LOCALAPPDATA%\AIContextHub\proof\`:
- `20261117-230210-L-notification-center.png`: notification centre, Do Not Disturb on, the aihub group.
- `20261117-230242-L-toast-watch-event-in-notification-center.png`: the watch toast "PR !748: 1 new comment(s)" with the **Open** button.

The Open button was not clicked: it runs `codex resume --last` in a terminal, which is what `aihub open --last --print` shows. Do Not Disturb hides the banner, but the notification is in the centre, so delivery works.

## Isolation lesson

`skills install --global` with only `HOME`/`USERPROFILE` overridden still wrote to the real `~/.codex` because
`CODEX_HOME` was set in the environment (clients.ts honours `CODEX_HOME`, `COPILOT_HOME`, `OPENCODE_CONFIG_DIR`,
`XDG_CONFIG_HOME`). The 33 skills and 14 prompts were removed again with `aihub skills uninstall --client codex`
(manifest-tracked files only; the user's own skills were untouched). Override all of them for a temp home.

## Live check in three isolated clients (2026-11-17)

`@ferronhooi/aihub@next` (0.1.0-next.20) installed in a scratch prefix; skills installed with `aihub skills install --client <c>` into isolated homes
(own `HOME`/`USERPROFILE`, `XDG_*`, `OPENCODE_CONFIG_DIR`, `COPILOT_HOME`; `OPENCODE_DISABLE_CLAUDE_CODE=1` and `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`; never the real homes). A fresh clone of
test-project with `aihub init --no-pr`, a story, a feature branch with one local commit and a test release branch per client. Each client ran the four commands
(the slash command text, as the agent runs it) and the end state was checked with `az` and `git`.

| Client | /pr | /pr-update | /review | /cherry-pick | Proof |
|---|---|---|---|---|---|
| opencode 1.19.5, `openai/gpt-6-luna` (shared test auth, own config) | PASS: one `aihub pr create`, sections in template order, target main, story AB# link, work item related | FAIL: bullet added but the Related story link was replaced by the template placeholder (fix: PR #27) | PARTIAL: reply posted, thread status stayed active (fix: PR #28) | PARTIAL: 2 commits pushed on `cherry-pick/pr<N>-to-<target>`, no PR (fix: PR #30) | `20261117-2340-L-live-opencode.png` |
| Copilot CLI (terminal, scratch `@github/copilot`, `COPILOT_HOME` scratch, `GH_TOKEN` from `gh` only in the environment) | PASS | PASS (slow: first searched for the binary) | PARTIAL: reply posted, status stayed active, agent said "resolved" (PR #28) | PARTIAL: branch pushed, agent reported a PR that does not exist (PR #30) | `20261117-2340-L-live-copilot.png` |
| Codex 0.167.0 (`CODEX_HOME` = shared test home for auth, skills in a scratch `HOME/.agents/skills`) | BLOCKED: usage limit until 2026-11-18 13:28 | not run | not run | not run | `20261117-2340-L-live-codex.png` |

Other findings: in non-interactive `opencode run` the skill's asset read outside the project (`.../skills/_shared/assets/...`) is auto-rejected unless
`permission.external_directory` is `allow`, and the turn then ends; the scratch config allows it. Codex needs one re-run after the limit resets (same commands).

Ids created and removed afterwards: stories 2781, 2787, 2804, 2808; PRs 778 and 786 (abandoned); branches `feature/<id>-live-<hex>-story`, `live-<hex>/rel` and
`cherry-pick/pr778-to-live-e8a2-rel`, `cherry-pick/pr786-to-live-a9c4-rel` for the prefixes live-d5f1, live-e8a2, live-f3b7, live-a9c4. An `az` query shows no open PR, work item or
branch with these prefixes.

## Rerun of the red cells on @next.28 (2026-11-18)

Same isolation, installed `@ferronhooi/aihub@0.1.0-next.28` (contains #27 pr-update keeps CLI sections, #28 replies schema, #30 cherry-pick `--pr`, #32 scoped opencode permission).
For opencode `aihub skills install --client opencode` now wrote only
`permission.external_directory["<config>/skills/**"] = "allow"` into `opencode.json` (no global allow, no other permission keys in the scratch config);
`aihub doctor` reported `OK permission:opencode`. End state checked with `az` and `git` (second source).

| Client | /pr | /pr-update | /review | /cherry-pick | Proof |
|---|---|---|---|---|---|
| opencode 1.19.5, `openai/gpt-6-luna` | PASS (!968, template sections, target main, AB# link, work item related; no permission prompt) | PASS (bullet added, AB# story link kept) | PASS (reply posted, thread status `fixed`) | PASS (PR !971 on target `live-b2c6/rel`) | `20261118-0530-L-live-opencode-rerun.png` |
| Copilot CLI | PASS (!969) | PASS (bullet added, AB# kept) | PASS (reply posted, thread `fixed`) | PASS (PR !970 on target `live-c7d1/rel`) | `20261118-0530-L-live-copilot-rerun.png` |
| Codex 0.167.0 | still blocked by the usage limit (until 2026-11-18 13:28) | | | | |

Notes: a first attempt of the rerun did not start because Azure CLI lost its login under the overridden `HOME` (fixed with `AZURE_CONFIG_DIR`, a harness detail, not an aihub problem);
Copilot's first `/review` ran before its thread existed because the harness read the PR number with a wrong regex, so the cell was repeated with the thread in place.
Ids created and removed: stories 3211 and 2840; PRs !968, !969, !970, !971 (abandoned); branches of the prefixes live-b2c6 and live-c7d1 (feature, release, cherry-pick). An `az` query shows
no open PR, work item or branch with these prefixes. The findings table above (17-11, next.20) is kept as the "before".

## Clean install 1.0.0 (2026-11-18)

A clean environment on Windows (Node 22.17.1, npm 10.9.2): a fresh npm prefix and fresh `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`, `XDG_*`, `CODEX_HOME`, `COPILOT_HOME`,
`OPENCODE_CONFIG_DIR` and `AZURE_CONFIG_DIR` under one scratch folder, no `aihub` anywhere on `PATH` before. The installer comes from the extensions repository after the
switch of `installer.menu[0].npm.tag` from `next` to `latest` (extensions PR #827, `check-layout.ps1` and `installer-installable.tests.ps1` green).

| Step | Result |
|---|---|
| `install\install.ps1 -Aihub` | `npm install -g @ferronhooi/aihub@latest` into the scratch prefix, `aihub --version` = **1.0.0**, then `aihub skills install` for all three clients: opencode 36 skills + 15 commands + the scoped permission, github-copilot 36 skills, codex 36 skills + 15 prompts |
| `install\Install.cmd`, menu `[1]` (stdin `1`, no prompts left; `INSTALLER_UPDATE_DONE=1` skips the git pull) | same result, second run `unchanged 36/15/1` |
| `aihub skills install --client opencode\|codex\|github-copilot` | lands in the isolated homes only; each skills folder has `.aihub-manifest.json` with `version 1.0.0` and 36 files with their sha256 |
| `aihub doctor` | `OK` node, git, `skills:opencode`, `permission:opencode`, `skills:github-copilot`, `skills:codex`; `FIX` repository and auth only because the clean env has no clone and no `az` login |
| `npx skills add MyDataIntelligence/aihub -g -a opencode -a github-copilot -a codex` (alternative route) | works in the isolated home: 26 skills copied to `~/.agents/skills` (the universal folder all three read). It brings no slash commands, no `_shared` folder and no opencode permission rule, so the installer route stays the primary one |
| `/pr` in isolated opencode (`gpt-6-luna`, clean env, real `az` login only for the REST calls) on a synthetic branch | PR !972 created: target main, sections Summary/Changes/Tests/Related, `AB#3212` linked, work item related (checked with `az`). The agent left Changes/Tests as `-`; the CLI behaved correctly |
| `install\install.ps1 -Aihub -Uninstall` | skills, commands and the permission rule removed (manifest-tracked files only), `npm rm -g` done, 0 skill files left |

Cleanup: PR !972 abandoned, branches `feature/3212-live-1a2b-story` and `live-1a2b/rel` deleted, story 3212 deleted, the scratch folder removed. An `az` query shows nothing with the prefix.
Proof: `20261118-0600-L-clean-install.png` (rendered summary). Codex cases (one `codex exec` per command) follow after the usage limit resets (2026-11-18 13:28).

## Codex cells on 1.0.1 (2026-11-18)

Codex CLI 0.167.0, `gpt-6-luna`, `@ferronhooi/aihub@1.0.1` (`aihub --version` = 1.0.1), after the usage limit reset (13:28). Auth from the shared test Codex home only (`CODEX_HOME`, never copied),
everything else in a scratch environment; one `codex exec` per case with the slash command text as the prompt; end state checked with `az` and `git`.

| /pr | /pr-update | /review | /cherry-pick | Proof |
|---|---|---|---|---|
| PASS: PR !981, target main, Summary / Changes (commit line + `5 files changed, +71 -0`, filled by the 1.0.1 fallback) / Tests `Not run yet.` / Related `AB#3228`, work item linked | PASS: text appended to Changes, story link and other sections intact | PASS: reply posted on the thread, status `closed` | PASS: PR !984 on target `live-5e9d/rel` | `20261118-1355-L-live-codex-1.0.1.png` |

Finding: a first attempt with the skills only in a scratch `HOME/.agents/skills` found none, because Codex on Windows resolves `~/.agents` through the real user profile and ignores `HOME`; it then searched the
real `~/.agents` and the shared Codex home (read only) and followed legacy Hub rules found there. The attempt created nothing. The valid run uses the skills inside the scratch clone
(`.agents/skills`, git-excluded, without `_shared`, which no skill needs since 1.0.1), the repository route Codex reads natively. Clean-install note: for Codex the repository skills folder is the reliable isolation point.

Ids created and removed: story 3228, PRs !981 and !984 (abandoned), branches of the prefix live-5e9d (feature, release, cherry-pick). An `az` query and `git ls-remote` show nothing left.

## Codex discovers skills from the user-level folder (2026-11-18)

Codex 0.167.0 reads skills from `$CODEX_HOME/skills` (default `~/.codex/skills`), from `<repo>/.agents/skills`, from `~/.agents/skills` (resolved through the real Windows profile, `HOME` does not move it)
and from its system skills (names `codex-home-skills`, `.agents/skills`, `user-agent-skills`, `system-skills` in the binary). `aihub skills install --client codex` writes to `$CODEX_HOME/skills`, so it targets a folder Codex reads.

Proof with a real `/pr`: `aihub@1.0.2` installed into the shared test Codex home (36 skill files, 16 prompts; bench-world had finished its Codex benchmark and handed the home over), a fresh synthetic clone with **no skills copied
into the repository**, one `codex exec -m gpt-6-luna` with the `/pr` text. The agent read `.../shared/skills/pr-create/SKILL.md` and created PR !1063: target main, Summary / Changes (commit + diffstat) / Tests `Not run yet.` /
Related `AB#3370`, work item linked (checked with `az`). Then `aihub skills uninstall --client codex`: 36 + 16 files removed, the `skills/` listing identical to the one taken before, `prompts/` gone as before, no manifest left; bench-world was told the home is clean.

Finding: Codex's log said `failed to load skill ...\pr-watch\SKILL.md: invalid YAML ... line 2 column 158`. The description had unescaped double quotes inside a double-quoted string (introduced with `watch --mine`).
opencode and Copilot tolerated it, Codex skipped the skill. Fixed in PR #52 (single quotes) and the skill lint now parses every front matter with a YAML parser; the old file fails the new check.

Ids created and removed: story 3370, PR !1063 (abandoned), branches of the prefix live-7c1f. An `az` query and `git ls-remote` show nothing left. Proof: `20261118-1850-L-live-codex-userdir.png` (rendered summary).

## Reviewer votes live (2026-11-18)

`aihub pr show --json`, `aihub status --json` (`pr.reviewers`) and `aihub pr list` showed the votes of a fresh PR in ferron-test where the one test identity added itself as reviewer: `az repos pr set-vote --vote approve` gave `{"name":"Ferron Hooi","vote":10,"voteName":"approved","required":false}`
in both JSON views and `wait-for-author` gave vote -5 / "waiting for the author" (also in the text of `pr list` and `pr show`). PR !1078 abandoned, branch `live-9d3e/votes` deleted, nothing left.

## Leftovers

Pipeline run 266 (and the retried attempt of run 239) cannot be deleted in Azure DevOps; they are harmless history.

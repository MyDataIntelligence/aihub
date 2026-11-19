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

## All slash commands through the `aihub` agent (2026-11-18)

`@ferronhooi/aihub@next` (1.0.2-next.53; the /review rerun on next.59) in a scratch prefix, `aihub skills install --client all` into isolated homes (own `HOME`/`XDG_*`/`COPILOT_HOME`/`OPENCODE_CONFIG_DIR`;
opencode auth only through `XDG_DATA_HOME` of the shared test home, never copied; Copilot with `GH_TOKEN` from `gh` in the environment). Per client a fresh synthetic story, feature branch and test release branch in ferron-test; the
slash command text through the `aihub` agent (`opencode run --agent aihub --command <c>`, `copilot -p ... --agent aihub`); `/commit` on an uncommitted change; `/story-run` on a second fresh story. 0 questions in all 12 runs. End state via `az` and `git`.

| Command | opencode 1.19.5 (gpt-6-luna) | Copilot CLI |
|---|---|---|
| /pr | PASS: PR !1080, template sections, `AB#` link, work item related | PASS: PR !1079 |
| /pr-update | PASS: text added to Changes, story link kept | PASS (first try `--append-text "- bullet"` was refused as an ambiguous option; fixed) |
| /review | first run FAIL (below), rerun PASS: reply posted, thread `closed` | PASS: via `aihub-runner`, marker removed, reply posted, thread `fixed` |
| /cherry-pick | PASS: PR !1081 on `live-f4a1/rel` | PASS: PR !1082 on `live-b7c2/rel` |
| /commit | PASS: `chore: commit working changes (AB#3395)` committed and pushed | PASS: `chore: werk wijzigingen bij (AB#3396)` pushed |
| /story-run | PASS: story 3398 -> PR !1083, README line present, honest status (no pipeline configured) | PASS: story 3399 -> PR !1084, README line present |
| VS Code Copilot Chat | not run: needs a signed-in Copilot account, an isolated profile has none and the user's account is not used; the same agent files ran in the Copilot CLI | |

Bugs found and fixed (PR #62, released in next.59): (1) opencode's `aihub` agent only allows `aihub`, `git` and `az` in bash, so `cat > replies.yaml <<EOF ... && aihub comments reply --replies-file` was rejected and /review posted nothing:
`aihub comments reply` now takes repeatable `--reply "<threadId>:<status>:<text>"` without a file and the review-process skill uses it; the rerun posted the reply and closed the thread. (2) A value that starts with `- ` (a markdown bullet) after an option, such as
`--append-text "- item"`, failed as an ambiguous option in Node's parser; it is now accepted.

Cleanup: PRs !1079-!1084 abandoned, all `live-f4a1` and `live-b7c2` branches and stories 3395, 3396, 3398, 3399 deleted, no `aihub watch` process left (the runner had started and stopped one itself); `az` and `git ls-remote` show nothing left.
Proof PNGs (rendered summaries): `20261118-2030-L-agent-e2e-opencode.png`, `-copilot.png`, `-vscode.png` (the last states why it was not run).

## Fabric live in an own workspace (2026-11-18)

`aihub fabric` from `staging` (409f187 plus the fixes below), signed in with `az login`, against Microsoft Fabric. To stay synthetic the check created its own workspace
`aihub-test-dev-20261118` on the trial capacity (`FTL4`, Switzerland North; the only capacity without acc/prd in its name that can run Spark) and wrote only there; other workspaces were
not touched (not even listed beyond `fabric workspaces --filter`). Second sources: Fabric REST through `az rest` and OneLake DFS through `az rest --resource https://storage.azure.com/`; the SQL
endpoint through ODBC 18 (pyodbc with an Entra token). Everything was deleted at the end and verified gone (`GET /workspaces/<id>` answers `WorkspaceNotFound`).

| Case | Result | Second source |
|---|---|---|
| `workspace create` (dry-run, then real on the trial capacity), `show`, `roles`, `workspaces --filter` | ok (Admin: the signed-in user) | REST `GET workspaces/<id>` |
| `item create` Lakehouse, 2 Notebooks (Fabric git format `notebook-content.py`), 2 DataPipelines (Wait; Notebook activity), Environment | ok; a `.ipynb` part is refused by the service with `PyToIPynbFailure` and the CLI prints that message | REST `GET items` |
| `item show`, `item definition --out`, `item rename` (and back), `item update --definition-dir`, `--dry-run` of each | ok; the updated definition contains the edit | `item definition` after `update` |
| `onelake mkdir`, `write`, `list`, `read` a CSV | ok after fix 1 | OneLake DFS GET of the file |
| `lakehouse load` into a table, `lakehouse tables`, `livy run --kind pyspark` | ok after fix 2; the table has 3 rows (`livy ok 3`) | REST `GET lakehouses/<id>/tables`, Livy count |
| `run` the OK notebook, `jobs`, `job show`, `logs --item --job` | Completed in 12 s; driver stdout line `aihub live verification: hello from the ok notebook` visible with `spark logs --log-type driver --file stdout --search` | REST `GET jobs/instances` |
| `run` the failing notebook (`spark.read.table` of a missing table), `failures` | Failed; chain notebook -> Spark session names the failed cell (`cell 12 line 1: df = spark.read.table(...)`), `AnalysisException TABLE_OR_VIEW_NOT_FOUND`, likely cause `missing-table-or-path` (needs the driver log, available a few minutes after the run) | `az rest` `.../livySessions/<id>` state `Failed` |
| capacity full (4 runs failed with `TooManyRequestsForCapacity`) | `failures` said `unknown` before fix 4, now `capacity` | job failure text in REST |
| `run` a DataPipeline (Wait) + `logs` | Completed in 17 s, activity run `wait_five (Wait): Succeeded, 5s` | REST jobs |
| `run` the pipeline with a notebook activity + `logs`; the same when the capacity was full | Completed; activity run `run_nb_ok (TridentNotebook): Succeeded`; failed case: chain pipeline -> activity -> Spark session, cause `capacity` | REST jobs |
| `logs --workspace W --since 1h --status failed` | showed 0 runs before fix 3, 4 runs after | REST jobs (4 failed) |
| `spark stop --all-mine --dry-run` / `--session` (Livy session DELETE, notebook job cancel, dev/feature workspaces only; `fabric run` names it on TooManyRequestsForCapacity) | dry-run live ok; the real stop is in the next rows (third run) | |
| `sql` read-only: guard (`delete from ...` refused: only SELECT/WITH), `--dry-run` | ok | |
| `sql` SELECT on the lakehouse SQL endpoint | **ok, native** (2026-11-18, own workspace `aihub-test-dev-20261118c`, third run): the SQL token needs the audience `https://database.windows.net/` WITH the trailing slash and tedious needs 19.2 or newer (18.6 is closed right after login, whatever the encrypt option; 19.2.2 and 20.3.9 work). With both, `select * from (values (1,'alpha'),(2,'beta'),(3,'gamma'))` returns the 3 rows on the native path (platform forced to linux, so the .NET SqlClient fallback could not run), also without any token variable (token from `az`). `--item lh_test` works although the SQL endpoint has the same name (Lakehouse first). The Windows fallback stays as a safety net. Earlier (second run) the fallback was the only working path | ODBC 18, .NET SqlClient and tedious 20.3 return the same rows |
| `spark stop` against the real monitoring API (third run) | **was broken, fixed**: the dry-run said "cancel the notebook job", the real run called `.../items/undefined/jobs/instances/<id>/cancel` (HTTP 400) because the API names the item in `item.itemId` and writes `itemType` in lower case, and a Lakehouse Livy session reports its own id as job id. Now `--all-mine --yes` closed the Livy session (`spark sessions` 15 s later: `Succeeded`) and `--all-mine` only takes sessions whose `submitter` is the signed-in identity | REST `livySessions` |
| `git status` of an unconnected workspace | clear message `Workspace not connected to Git.` (Fabric's text, HTTP 400) | |
| `auth status` | `signed-in user (az login)`, service principals: none; SP live skipped (none registered, no secret supplied) | |
| `dax`, `kql` | skipped: they need a semantic model / KQL database with data, which a cheap synthetic workspace does not have | |
| ACC/PRD guard on `workspace create`, `item create`, `item delete --yes`, `run`, `workspace delete` with `...-acc` / `...-prd` names | refused before any call (`--dry-run`, no such workspace exists) | |
| `item delete --yes` of every item, `workspace delete --yes` (new, fix 6) | ok; the workspace is gone | REST: `WorkspaceNotFound` |

Fixes (aihub #71 and the workspace-delete PR, each with a vitest): (1) `--lakehouse <name>` of the onelake commands was "ambiguous" because every lakehouse has a SQL endpoint with the same name; (2) `lakehouse load --path Files/x.csv`
became `Files/Files/x.csv`; (3) Fabric job times are UTC without a zone suffix and were read as local time, so `logs --since 1h` hid runs from the last hour; (4) `failures` reported cause `unknown` when the bottom link was
"no Spark session found"; (5) a dropped SQL connection crashed the CLI with a stack trace; (6) `fabric workspace delete --yes` did not exist (only the generic `api delete_workspace`).

Findings that are not bugs of the CLI: a table load and every notebook run open a Spark session; on the trial capacity one idle session (about 20 minutes) blocks the next run with `TooManyRequestsForCapacity` (the CLI has no
way to stop a Spark session, only to wait; `failures` now says so); driver logs of a Spark application appear some minutes after it ended (404 "no available log file" before, which the CLI reports per section).
Proof PNG: `20261118-1951-F-fabric-live.png` in the proof folder of the benchmark machine.

## One story end to end through the `aihub` agent (2026-11-18)

World: opencode 1.19.5 with the `aihub` agent and Luna (`openai/gpt-6-luna`, shared test opencode home through `XDG_DATA_HOME`, auth never copied), `@ferronhooi/aihub@next` (1.0.2-next.58 to 1.0.3-next.75) in a scratch npm prefix, all other homes isolated. A fresh clone of `test-project` (tests plus a git `pre-commit` hook that runs pytest, and a `team.yaml` from `aihub init --no-pr` with `tests.command: "python -m pytest {tests}"`). Prompts were typed as a developer would, in Dutch; every step ran as one `opencode run --agent aihub`.

| Step | Prompt | Result | Second source |
|---|---|---|---|
| story-create | "Maak een story: ..." | story 3397 in 4 tool calls (`aihub story template`, `story create`), 0 questions | `az boards work-item show` |
| story-refine | "Refine story 3397." | proposal shown, no gaps, 0 questions | `aihub story show` |
| `/story-run 3397` | | `aihub-runner` subagent: `story start`, implement, `aihub test changed --run` (only the new tests), commit, push, `pr create`, `pipeline follow`; PR !1087 | `az repos pr show`: active, story linked; `git diff`: 2 files |
| `aihub commit` | | `git hooks running: pre-commit (...)` and `commit hooks took 0.7 s` printed | story 3400 on next.75 |
| pipeline | | `no pipeline run found after waiting`: the only build policy of `test-project` is on `ci-checks-demo`, no pipeline builds `main` or a feature branch. Reported, not green-verified | `az repos policy list`, `az pipelines runs list --branch` |
| 2 review comments | added with `az devops invoke ... pullRequestThreads` | threads 1879 and 1880 | REST |
| `/review 1087` | | runner replied to both threads and closed them in one call, no code change needed (`strip()` and the whitespace test already covered both) | REST: status `closed`, 2 comments each |
| `/cherry-pick` to `release/aihub-e2e-<stamp>` (from main) | | PR !1088, 1 commit | `az repos pr show`; `git diff` release vs cherry-pick branch = the 2 story files |
| questions asked | | 0 in every step | transcript |

Bugs found and fixed (all through PRs to `staging`, vitest, self-merged):

| Bug | Found by | Fix |
|---|---|---|
| `aihub story start` kept `main` checked out because `tests/__pycache__` (untracked) counted as "uncommitted changes"; the work would have been committed on `main` | first run | #61: only changes to tracked files block the switch |
| `aihub status` said "commit the open changes" for untracked `__pycache__`, so the runner stopped; `aihub commit` (`git add -A`) committed the `.pyc` files of a repository without `.gitignore` | second and third run | #64: status and commit ignore untracked build output (`__pycache__`, `*.pyc`, `.pytest_cache`, `node_modules`, `.venv`, `.DS_Store`) |
| the runner started `python -m pytest` after `aihub test changed --run` | first run | #61: runner body says tests run only through `aihub test changed --run` |
| one run committed with plain `git commit` (no hooks line) because `implement` only names `aihub commit` when `team.yaml` has `commits.format` | PR !1087 run | #74: `story-run` says `aihub commit ... --push` |

Not a bug, but worth knowing: `pytest <file>` cannot import top-level packages without a conftest; the run stopped honestly with `ModuleNotFoundError` until `tests.command` was set to `python -m pytest {tests}` in `team.yaml`.

Cleanup: PRs !1077 (earlier check), !1086, !1087, !1088, !1089 abandoned; all feature, cherry-pick and release branches deleted; stories 3397 and 3400 deleted. Proof: `20261118-1953-L-story-e2e.png` and `20261118-1953-L-story-e2e-transcript.txt` in the proof folder of the benchmark machine.

## Green PR and pipeline-fix with a synthetic CI (2026-11-18)

Closes the "green PR" gap of the story e2e above. Same world (opencode 1.19.5, `aihub` agent, Luna, `@next` 1.0.3-next.80 to next.94). In `ferron-test/test-project` I created, on a branch of my own, a small pipeline and a build-validation policy, so that PRs to that branch get a real run.

| Object | Id | Notes |
|---|---|---|
| branch `aihub-e2e-main` | | `main` plus `ci/aihub-e2e.yml` (and later `CHANGELOG.md`); `team.yaml` `defaultTarget: aihub-e2e-main`, so `story start` branches from it and `pr create` targets it |
| pipeline `aihub-e2e-ci` | 12 | Microsoft-hosted `ubuntu-latest`: `python3 -m pytest -q tests`, then a changelog check (the PR needs a `CHANGELOG.md` line containing its `AB#<id>`) |
| build policy on `aihub-e2e-main` | 6, 7, 9, 10 | each push to the branch needs the policy removed first (TF402455: pushes need a PR once a build policy exists); 10 was the last one |

| Run | Result |
|---|---|
| `/story-run` 3401 (PR !1090) | pipeline run 271 succeeded; `aihub pipeline follow` printed "all 1 pipeline run(s) finished green" |
| `/story-run` 3406 (PR !1095) | run 274 **failed** in the changelog step; the runner called `aihub pipeline logs --failed --run 274`, added `AB#3406 ...` to `CHANGELOG.md`, `aihub test changed --run`, `aihub commit --type fix ... --push` (hooks line, 0.6 s) and followed run 275 to green. 0 questions |

Getting a red run first took more tries than expected, because Luna read the repository well: a contract test (every public function must be listed in a text file) and a type-annotation check were both satisfied up front (the runner globbed `**/*`, found the contract test, and writes type hints by default). A rule that depends on the story id and cannot be read off the code (the changelog line) produced the red run.

More findings of these runs (all fixed through PRs to `staging`):

| Finding | Fix |
|---|---|
| `aihub test changed` ran `pytest <file>`, which cannot import top-level packages | #79: default is `python -m pytest {tests}` |
| `story-create` told the agent to write the story with a shell heredoc; on Windows the bash tool is PowerShell, the catch-all `*: ask` rule refused every fallback and the story was not created in 4 of 6 runs | #90 (`cat *` allowed) and #93 (the skill says: write `story.md` with the file tool) |
| the runner once edited a different file than the story named (`repos/...` instead of `orders/__init__.py`) and then read outside the workspace (`external_directory`, rejected in `opencode run`) | not fixed: the story named the file; a clearer story or an `external_directory` rule is a choice for the team |

Cleanup: PRs !1090, !1092, !1094, !1095 abandoned; branches `aihub-e2e-main` and `feature/3401|3403|3405|3406-...` deleted; pipeline 12 deleted (its runs 271 to 275 stay as history); policy 10 deleted; stories 3401, 3403, 3405 and 3406 deleted. **Mistake of mine:** a "delete every Build policy" loop also removed the existing build policy of `test-project` on `ci-checks-demo` (pipeline 5, Ruff). I recreated it (id 11, blocking, display name `ruff`, pipeline 5); settings other than those could not be read back, so compare with the original if it matters. Proof: `20261118-2041-L-story-ci-e2e.png` in the proof folder of the benchmark machine.

## Whole-set work, journal and resume (2026-11-18)

Synthetic worktree set for story 3410 with two repositories of `ferron-test` (`test-project` from `main`, `test-developers` from `staging`), driven with the local build of the CLI; then opencode 1.19.5 with the `aihub` agent and Luna on top of it.

| Command | Result | Second source |
|---|---|---|
| `aihub worktree create --story 3410 --repos test-project,test-developers` | one folder with a worktree per repository on `feature/3410-...` (the first try failed honestly: `test-developers` has no `main`; fixed with `defaultTarget: staging` for it in `team.yaml`) | `git worktree list` |
| `aihub status` in the set | a `Set:` line that names `--all-repos` | n/a |
| `aihub commit --all-repos --type feat --subject ... --push` | one commit and push per repository with changes, one table (changed / pushed / PR / pipeline / result); a repository without changes says `skipped: nothing to commit`; a second call with a change in one repository committed only that one | `git log` per repository |
| `aihub pr create --all-repos --summary-text ...` | PR !1100 (`test-project`) and !1101 (`test-developers`), then `crossrepo link-prs` | PR description has a Related section naming the other PR; the story has 2 `Pull Request` relations |
| `aihub pr update --all-repos --section Tests --append-text ...` | both PRs updated | `az repos pr show` |
| `aihub pipeline follow --all-repos` | one result per repository; a timeout in one is reported and the other is still done | build state per PR |
| `aihub status --all-repos` | one table, next step per repository | `az` |
| journal | `<git common dir>/aihub/journal.md`: time, branch, command, result, next step; one line per repository for `--all-repos`; reads (status, search, ...) are not recorded | file |
| `aihub status --resume` | `Last time: ... · Plan done: ...; left: ... · Next step: ...`, the newest private note and the set, no network call (a unit test asserts 0 fetches); Dutch labels for a Dutch team | journal |
| `aihub story recall --id 3410` | story, PRs and pipelines per repository from ADO, the journal lines of both repositories, open ends | `az` |
| `aihub story search "set demo"` | story by title words plus journal lines | WIQL |
| agent, Luna: "Commit en push alles in alle repos van deze set" | `aihub commit ... --push --all-repos`, 3 tool calls, 0 questions | `git log` |
| agent, Luna: "Nieuwe chat. Waar was ik gebleven?" | skill `resume`, `aihub status --resume`, correct summary | journal |

Found while testing, all fixed in the same PR: the first journal format lost lines that did not name the story (the branch is recorded now and resume/recall select by it); `--all-repos` wrote one line for the first repository only (now one per repository); a plain `aihub commit` in a set silently ignored the other repositories (now prints `note: set story-N: <repo> also has uncommitted changes; aihub commit --all-repos ...`); `aihub worktree list` found no set from inside a set; Luna did not route "in alle repos" or "waar was ik" until the `commit`, `worktrees` and new `resume` skills named them.

Policy check after the earlier mishap: the original Ruff build policy of `test-project` was id 3 (created 2026-10-08, deleted by me on 2026-11-18). Its revision 1 and the recreated id 11 have the same settings: build definition 5, display name `ruff`, blocking, enabled, `manualQueueOnly` false, `queueOnSourceUpdateOnly` false, `validDuration` 0, scope `refs/heads/ci-checks-demo`. Only the id and the creation date differ.

Cleanup: PRs !1100 and !1101 abandoned, both `feature/3410-...` branches deleted, story 3410 deleted, the worktree set removed. Proof: `20261118-2230-L-whole-set.png` and `20261118-2230-L-whole-set-transcript.txt` in the proof folder of the benchmark machine.

## Data before/after and the environment release plan (2026-11-18)

**`aihub pr data-diff`** live: two own Fabric dev workspaces on the trial capacity (`aihub-test-dev-3f2a-base` / `-feat`, a Lakehouse `lh_orders` each, a table `orders` loaded from a 4-row and a 6-row CSV), PR !1098 in ferron-test, `team.yaml` with
`fabric.workspaces` (target branch -> base, `feature/*` -> feat) and `dataChecks` on `dbo.orders`. The output (SQL endpoint) was count 4 -> 6 (+2, +50%), nulls_customer_id 0 -> 1, sum_amount 375.75 -> 715.75 (+340), distinct_customer_id 3 -> 4;
second source: the two input CSVs computed separately (identical numbers). `--write` put the table, the verdict and the "Measured (read-only)" line in the PR section "Data before/after" (checked with `az repos pr show`);
`--baseline ACC-shared` was refused before any call. Not live: the Livy fallback (the capacity's Spark was full, HTTP 430 `TooManyRequestsForCapacity`; unit tested with an injected runner).
Bugs found live and fixed: (1) a lakehouse name is ambiguous with its SQL endpoint, `fabric sql --item lh_orders` failed: `dataChecks.itemType` (default Lakehouse) is always passed as `--type` (PR #98); (2) a stale cached token made OneLake answer
"not signed in" until the cache file was deleted: a 401 now drops the cache and retries once (PR #91). Table loads need Spark: on the trial capacity they waited for free Spark compute for about 25 minutes. Both workspaces and lakehouses were deleted afterwards (the workspaces filter shows nothing).

**`aihub release plan --from DEV --to ACC`** live (git side): branches `live-3f2a/dev` and `live-3f2a/acc` in ferron-test, story 3402, PR !1091 adding `nb_live.Notebook/` completed into the dev branch, `fabric.environments` DEV/ACC in team.yaml. The plan listed
1 commit, 1 PR, the item `Notebook nb_live` as changed with `PRs !1091` and `stories AB#3402`, the cherry-pick list and release notes; `--out` wrote a plan with the merge commit that `aihub release run` can execute. Bug found live and fixed (PR #89):
a GET of the pull request does not list `workItemRefs`, the first run showed 0 stories; the stories now come from `/pullrequests/<id>/workitems`. Not live: the Fabric deployment pipeline compare (no deployment pipeline is visible to this
account, `fabric deployment list` says so); new and deleted items are covered by tests with an injected stage reader, and without a pipeline the plan says "git only".

Cleanup: PRs !1091 (merged into a test branch) and !1098 (abandoned), every `live-3f2a` branch, story 3402 and the workspaces; `az`, `git ls-remote` and `fabric workspaces --filter 3f2a` show nothing. Proof PNGs (rendered summaries):
`20261118-2115-L-data-diff.png`, `20261118-2115-L-release-env.png`.

## PR gold-standard helpers live (2026-11-18)

In ferron-test on a PR into `ci-checks-demo` (a branch with a blocking Build policy; the change fails ruff on purpose so nothing can merge), `team.yaml` with `pullRequest.afterCreate: {storyState: Doing, autoComplete: true}`:
`aihub pr create` printed "after create: story AB#3409 -> Doing; auto-complete set, it merges when: Build (ruff) is queued" (`az boards`: state Doing; `az repos pr show`: active, autoCompleteSetBy set).
`aihub pr tests add --from-run 266` and `--from-robot 15` created the table of the Tests section with a row each (name, result `pass`, link, duration `12s` / `32s`) as the description shows (`az repos pr show`).
`aihub pr comment --closed --title "Looptijd per stap" --link-section Tests` posted thread 1906 with status `closed` (REST) and the section got `Details: [Looptijd per stap](...?_a=overview&discussionId=1906)`.
Not live: `--from-fabric-job` (the Fabric test workspaces had been deleted; unit tested against a faked Fabric API). Cleanup: PR abandoned (auto-complete gone), branch and story deleted; `az` and `ls-remote` empty.
Proof PNG (rendered summary): `20261118-2230-L-pr-gold-helpers.png`.
## dbt (2026-11-18)

**`aihub dbt ...`** live against a synthetic project (`shop`, dbt-core 1.12.7 + dbt-duckdb 1.11.1 in a scratch venv, never a work repo): 5 models (2 staging views, 3 marts), 2 seeds, 1 source with freshness, 1 exposure (`meta.fabric_item`), 11 data tests (two fail on purpose: a null `amount`, a `cancelled` status) and a unit test; git branch `feature/amount-fix` with one changed model against `main`.
Run, with the real output checked against dbt's own `run_results.json` and `dbt ls`: `detect`, `check`, `build` (exit 1, 1 fail, 8 skipped), `failures` (compiled SQL and the first failing rows from `dbt show`; run_results.json stays intact because samples go to `target/aihub-show`), `lineage`, `impact` (files mode: `stg_orders` changed, 3 downstream models, 7 tests, the exposure and its Fabric item `Revenue report`), `impact --state auto` (merge base parsed in a temporary worktree, dbt's `state:modified+` gave the same sets), `test changed --run` (ran `aihub dbt build --select stg_orders+`), `yaml check`, `yaml scaffold <model> --write` and `--unit-test --write` (the entry was added to the existing `schema.yml` and `dbt test --select test_type:unit` ran it: the skeleton fails until the expected rows are filled, as intended), `freshness`, `ls`, `show --inline`. A profile target of adapter `fabric` made `aihub dbt build --target fab` stop before dbt ran, with the pointer to `aihub fabric dbt run`; `freshness` still ran.
**`impact --write`** live on a synthetic PR in ferron-test: branches `live-d4e1/base` (dbt project) and `live-d4e1/feature` (one changed model), PR !1102; `aihub dbt impact --project dbt-live --write` put the section "dbt impact" (changed model, 3 downstream models, tests, exposure with its Fabric item) in the description, the existing "Wijzigingen" section stayed intact (`az repos pr show`), a second run replaced the section instead of adding one; PR abandoned, both branches deleted (`git ls-remote` shows none).
Bugs found live and fixed: `dbt --version` took `--project-dir` and failed (version never shown); `dbt show` of a sample overwrote `run_results.json` (samples now use their own target path); `dbt show --select <model>` also previewed the model's tests (`--indirect-selection empty`); the global `--dry-run` simulation swallowed the command's own dry-run; on Windows with `core.autocrlf=true` `--state auto` flagged files with other line endings (fixed: both sides are parsed from LF copies; rechecked live with autocrlf=true and a CRLF file). Proof PNG: `20261118-2209-D-dbt.png`.
Not live: the Fabric adapters (`fabric`, `fabricspark`; only the guard and the profile checks are exercised, the workspace-guarded run stays `aihub fabric dbt run`); HTTP 430 handling (unit tested).

## Pipelines live (2026-11-18)

In ferron-test / test-project with a throw-away YAML pipeline `aihub-pipe-<stamp>` (file `ci/aihub-pipe-<stamp>.yml` on a branch of its own: publishes JUnit results with one failing test, Cobertura coverage and an artifact; a second stage deploys to environment `aihub-dev-<stamp>` that has an approval check), run 280 (`flavour=alpha`) and 281 (`flavour=beta`):
`pipeline def create/show/list` (#16), `def update --dry-run`, `run --params-file`, `approvals list/approve`, `authorize --resource environment:...`, `env create/list/show/checks/deployments`, `timeline`, `tests`, `coverage`, `vars`, `compare --run 280 --with 281`, `artifacts` (list and `--download`), `validate` and `expand` (valid file and a broken one), `cancel --run 280`, `schedule list`, `trigger show`, `securefiles list`, `connections list`, `devops pools`. Second source: `az pipelines runs show/artifact list`, REST `test/runs` (3 tests, 2 passed), `test/codecoverage` (lines 2 of 3), `pipelines/checks/runs`: all equal the CLI output. `env create aihub-prd-<stamp>` is refused by the PRD guard.
**Found live and fixed:** (1) `pipeline artifacts --download` refused the download address of a pipeline artifact (`artprodweu2.artifacts.visualstudio.com`, two sub-domain labels); the address check now accepts any depth under `dev.azure.com` / `visualstudio.com`. (2) `pipeline approvals list` showed an empty environment: the approvals API does not name the environment; it is now found through the run timeline (checkpoint) and `pipelines/checks/runs`, so the ACC/PRD guard sees the real environment name instead of only the pipeline name. (3) `env checks` printed `()` for an approver the API only returns by id; it prints the id.
Not live: the ACC/PRD refusal of an approval (a PRD environment cannot be created by the CLI, so no PRD approval exists; unit tested), a real `def update` PUT and a schedule list with entries (would change existing objects or need a schedule), populated secure files and connections (none in ferron-test). Cleanup: pipeline #16, environment #3 (with its check) and the branch were deleted with the CLI / `git push --delete`; `az pipelines list`, `env list` and `ls-remote` are empty for the stamp. Proof PNG (rendered summary): `20261118-2226-L-pipelines.png`.

## Leftovers

Pipeline run 266 (and the retried attempt of run 239), and runs 280 and 281 of the deleted pipeline `aihub-pipe-11182217`, cannot be deleted in Azure DevOps; they are harmless history.

Workspace `aihub-test-dev-20261118b` (second round, sql fix, spark stop) was deleted on 2026-11-18 with `fabric workspace delete --yes`; the Fabric API answers WorkspaceNotFound for its id.

## `aihub watch --run` and `--fabric-job` live (2026-11-18)

- **Toast with the Fix button.** `watch --run` on build 239 (failed, feature branch, ferron-test) with `--notify` raised a real Windows toast (Do Not Disturb was on, so it sat in the notification centre): `aihub: run 239 (AI-Context-Hub-Ruff-Check) failed on feature/1915-story-run-herhaling` with a **Fix** button. Proof PNG `20261118-2155-L-watch-toast-fix.png`. The button was not clicked (it opens the chat through `aihub://`, which is not registered for the dev build).
- **Fabric job.** Own workspace `aihub-test-dev-watch1` on the trial capacity, DataPipeline `pl_wait` (Wait 20 s): `fabric run` printed the job id, `watch --fabric-job <ws>/pl_wait/<job>` followed it in the background and recorded `Fabric job ... completed`; the watch ended itself. The workspace was deleted afterwards (`WorkspaceNotFound`). Proof PNG `20261118-2157-L-watch-fabric-job.png`.
- **Test Plans and Artifacts** (`aihub testplan`, `aihub artifacts`): reads live in ferron-test (runs and results of build 265, feeds); creating a plan answered 403 (no Test Plans license), so the writes are covered by tests only. Proof PNG `20261118-2212-L-testplan-artifacts.png`.

## The opencode `aihub` agent allows by default (2026-11-18)

opencode 1.19.5 with Luna (`openai/gpt-6-luna`, shared test opencode home through `XDG_DATA_HOME`, auth never copied), all other homes isolated, the agent files installed by this build (`aihub skills install --client opencode`). One `opencode run --agent aihub` with three shell commands and the instruction not to ask:

| Command | Result |
|---|---|
| `python -m pytest --version` | ran without a prompt: `pytest 7.4.4` |
| `dbt --version` | ran without a prompt (`dbt` is not installed on this machine: `command not found` from the shell, not a permission stop) |
| `git push origin main` | refused by the agent's rule (`"git push * main": deny`); the bare origin still has only `init` |

Not run: opencode 2.x (the `permissions` list has the same rules), Copilot/VS Code, Codex and Claude Code (their settings are documented in docs/agents.md and printed by `aihub skills install`, not exercised).

## Regression smoke of the npm build (2026-11-18)

`@ferronhooi/aihub` from npm into a scratch prefix (`npm i -g --prefix <scratch> @ferronhooi/aihub@next`), isolated `HOME`/`XDG_*`/`COPILOT_HOME`/`CODEX_HOME`/`OPENCODE_CONFIG_DIR`, `aihub skills install --client all`, a local clone of the synthetic `test-project` with origin set to `ferron-test`, real `az login` for the REST calls only. 1.0.4 is not on npm yet (`latest` 1.0.3, `next` 1.0.3-next.117), so the tested build is **1.0.3-next.117**; the `doctor` line `legacy-hub` (PR #121) is therefore not in it. Read-only calls only; `--help` ran in an empty folder.

| Family | Command | Result |
|---|---|---|
| help | `aihub <group> --help` for all 49 command groups, and `aihub --help` | OK (usage text, no stack trace) |
| install | `skills install --client all` into the isolated homes (46 skills, 22 prompts, 3 agents per client) | OK |
| doctor | in the clone | OK for node, git, remote, auth, skills, agents, permission; FIX only for `team.yaml` and `pr-template` (the clone has no team pack, expected) |
| PR | `pr list --mine`, `pr show --pr 174`, `comments get --pr 174`, `review prepare --pr 174` | OK |
| story / work | `status`, `story show --id 1670`, `work`, `standup --since 2d`, `handoff` | OK |
| pipelines | `pipeline runs --branch ...`, `pipeline timeline --run 239` | OK |
| policy / library / repo | `policy list`, `library list`, `repo branch list`, `repos list` | OK |
| search | `search code --text`, `search wiki --text`, `search items --text` | OK |
| wiki / boards / test plans / artifacts | `wiki pages`, `boards query run --mine`, `testplan runs --build 265`, `artifacts feeds` | OK |
| watch / fix | `watch list`, `fix known --error ...` | OK ("no known fixes yet" in this project) |
| dbt | `dbt detect` in a synthetic dbt project | OK (project shop, 5 models) |
| learn / probe / research | `learn repo`, `probe devops feature wiki|testplans`, `research template` | OK |
| fabric | `fabric workspaces --filter aihub-test-dev` | OK (no match: no test workspace is left) |
| other | `robot needed`, `worktree list` | OK |
| expected refusal | `crossrepo impact --from 174` without `crossRepo.pathMaps` | message names the missing key (correct) |

First pass counted 4 FAIL, all wrong arguments of the smoke script, not product bugs: `pr list --top`, `search code --query`, `probe devops` without `feature <name>`, and `help: (no command)` matching my own regex; they passed with the right arguments (the usage lines were clear in each case). No product failure was found, so no fix PR.
## Pipelines: the remaining live rows (2026-11-18)

Synthetic pipeline, environment, secure file and service connection in ferron-test/test-project, prefix `live-1771c1` (branch `live-1771c1/pipe`). Proof: PNG 20261118-2245-L-pipelines-live in the AIContextHub proof folder.

| Row | Result |
|---|---|
| `pipeline schedule list` | YAML cron `0 3 * * 1-5 on live-1771c1/pipe (always)` shown |
| `pipeline def update` (PUT) | name and `--status paused` changed, then restored; `def show` confirmed `[paused]` |
| `pipeline approvals reject` | worked on a pending approval of an environment with an Approval check |
| ACC refusal | **bug found**: the approvals API answer has no `resource`, so the ACC/PRD guard saw no name and rejected an approval of `live-1771c1-acc`. Fixed: the environment is read from the run's YAML, and the command refuses when it cannot tell. Live rerun: refused, then `--allow-env acc` rejected. Vitest: `test/pipeline-approval-env.test.ts` |
| `securefiles list`, `connections list|show` | the synthetic file and generic connection shown; the connection answer holds no credential (`TOPSECRET` count 0) |

Created and removed (all verified gone): pipeline #17, environment #4, secure file 48cd5a2e-22a0-4c52-93a2-4c5c9bfc6d63, connection 07ad2871-bdb5-47d2-8802-77e850b6efed, branch `live-1771c1/pipe`. Runs 283 and 284 stay (builds cannot be deleted; both ended on the rejected approval). Evidence of pipelines-build's earlier live rows: PR #125.


### Rerun on the released 1.0.4 (2026-11-18)

Same isolated setup with `@ferronhooi/aihub@latest` = **1.0.4** (`npm view` dist-tags: latest 1.0.4, next 1.0.4-next.121). Result: the same table as above, all OK (76 of 81 lines at the first pass; the other 5 are the script's own wrong arguments and the expected `crossrepo impact` refusal, as before). Additions for 1.0.4:

| Check | Result |
|---|---|
| `aihub skills install --client all` | OK; prints the old-Hub warning, the opencode note, and the Copilot/Codex auto-approve notes |
| `aihub doctor` `legacy-hub` | `FIX legacy-hub: the old AI Context Hub is still installed (the old hub CLI) ... -> aihub legacy remove --dry-run` in the shell as it is: the user's real old `hub` CLI is on the PATH (`%LOCALAPPDATA%\AIContextHub\cli`), nothing was touched. With that folder taken out of the PATH: `OK legacy-hub: no old AI Context Hub found` |
| opencode 1.19.5 + Luna, agent files from the npm 1.0.4 package, isolated homes | `python -m pytest --version` ran without a prompt (pytest 7.4.4); `git push origin main` was refused by the agent's rule and the bare origin stayed at `init` (the first attempt ended with an opencode server error, the retry ran) |

## Pipeline coverage with data (2026-11-18)

Synthetic pipeline `live-8cd052-cov` in ferron-test/test-project: one script step wrote a Cobertura file (3 of 4 lines, 1 of 2 branches covered) and `PublishCodeCoverageResults@1` published it (run 285, succeeded). `aihub pipeline coverage --run 285` answered Lines 3/4 75 % and Branches 1/2 50 %, as JSON too. Proof: PNG 20261118-2250-L-pipeline-coverage-live in the AIContextHub proof folder. Removed afterwards (verified): pipeline #18 and branch `live-8cd052/cov`; run 285 stays (builds cannot be deleted).
## The Fix button clicked in the notification centre (2026-11-18)

Real click on the **Fix** button of the toast raised by `aihub watch --run 239 --notify --client opencode` (failed feature build 239, ferron-test), Windows Notification Centre opened with Win+N, desktop lock held. The `aihub://` handler was re-registered by the product itself (a watch with `--notify` registers it when it points elsewhere); for the test only, the registered command was wrapped by a script that sets the isolated opencode home (shared test home, never the real one) and then runs the same `aihub open --url`; the product command was restored afterwards.

- **Bug found (first click)**: the window opened opencode, but with `--continue` in the shared data home it resumed another project's newest session (a story 3410 worktree) and the `/fix` prompt was not there. Proof: `20261118-2259-L-fix-click-after-first-try.png` (before: `20261118-2259-L-fix-click-before.png`).
- **Fix**: without a session id the opencode plan no longer uses `--continue`; it starts a new session in the repository with `--agent aihub --prompt "/fix <run-url>"` (vitest updated).
- **After the fix, real click**: opencode opened in the repository, agent Aihub, `/fix https://dev.azure.com/ferron-test/.../_build/results?buildId=239` submitted, skill `pipeline-fix` loaded and a subagent started. Proof: `20261118-2304-L-fix-click-after-fix-opencode.png` (before: `20261118-2304-L-fix-click-before-retry.png`). The agent then answered that `aihub` is not on the PATH of the window the click opened (the test wrapper does not set PATH); that is a property of the test setup, not of the click path.
- Test caveat: every `watch --notify` start re-registers the handler, so a wrapper must be set after the watch has started. Windows opened by this test were closed; the watch was stopped.

## Clean install of the release 1.0.5 and the VS Code extension 3.0.0 (2026-11-18)

Fresh isolated environment (own `HOME`, `APPDATA`, `LOCALAPPDATA`, `XDG_*`, `CODEX_HOME`, `COPILOT_HOME`, `OPENCODE_CONFIG_DIR`, `NPM_CONFIG_PREFIX`, an isolated VS Code profile; real `az login` and `gh` only for the calls). `Install-Extensions.ps1` from the extensions repository **without `-IncludeDev`**, on the day the release was published (`npm latest` = 1.0.5, GitHub release `vscode-v3.0.0`, not a pre-release).

| Run | Result |
|---|---|
| 1 (nothing installed) | `aihub installed 1.0.5 (npm @latest + skills for all clients)`, `pycharm-git-vscode installed 0.9.0`, `dbt-lens installed 0.1.1`, `fabric-workbench-vscode installed 0.1.1`, `ai-context-hub installed 3.0.0 (ai-context-hub-3.0.0.vsix from vscode-v3.0.0, sha256 verified)`, `fabric-navigator manual` (the Chrome extension line); exit 0. The installer picked the non-pre-release `vscode-v*` release on its own: no fix needed |
| 2 (second run) | all five `unchanged` (aihub 1.0.5, 0.9.0, 0.1.1, 0.1.1, 3.0.0); `fabric-navigator manual` again |
| `aihub doctor` in a synthetic test-project clone | OK node, git, remote, auth, skills/agents for opencode, Copilot and Codex, permission, **`legacy-hub: no old AI Context Hub found`**; FIX only `team.yaml` and `pr-template` (the clone has no team pack) |
| Regression smoke on 1.0.5 | the same table as for 1.0.4: 76 OK of 81 lines (the other 5 are the script's own wrong arguments and the expected `crossrepo impact` refusal) |
| VS Code, extension 3.0.0 in an isolated profile | `FerronHooi.ai-context-hub@3.0.0` listed and activated (`ExtensionService#_doActivateExtension FerronHooi.ai-context-hub ... onStartupFinished` in the extension host log), the Explorer shows the **Worktree Sets** and **Learn** views; screenshot `20261118-2356-L-vscode-3.0.0-isolated.png`. The status bar of this clone (branch `main`, no story) shows no story text, so the bar was only visible as its icon and the views, not with data |

Environment notes: the installed VS Code 1.146 on the test PC cannot start a second instance (`Code is currently being updated`, the pending self-update), so the profile was opened with a downloaded VS Code 1.147 (`@vscode/test-electron`); `Install-Extensions` itself used the installed `code` CLI, which works. An earlier attempt to switch to my window by title brought the user's own VS Code window forward by mistake; it was minimized again at once and nothing in it was touched.

Finding: the tag `vscode-v3.0.0` matched the npm release workflow's `v*` filter and left one red run (`npm version` with an invalid version); fixed in the aihub repository (tag filter `v[0-9]*`).

## Final proofs (1.0.5 / 3.0.0) (2026-11-19)

Isolated homes (`HOME`, `APPDATA`, `LOCALAPPDATA`, `XDG_*`, `CODEX_HOME`, `COPILOT_HOME`, `OPENCODE_CONFIG_DIR`, `AIHUB_LEARN_HOME`), `@ferronhooi/aihub@1.0.5` from npm into a scratch prefix, a fresh clone of the synthetic `test-project` (ferron-test). Real `az login` only for the calls. Desktop lock held and released.

**1. Learn CLI on real data.** Run: `learn repo`, `change --pr 137` and `--branch`, `diagram` (architecture, lineage, repo, flow, and architecture with `--pr`), `flow`, `glossary`, `week --days 30`, `onboarding`, `item` (a python file, `main.py`, a pipeline yaml, a dbt model), `level`, `list`, `concepts`. Second source (git ls-files / git diff --stat / git grep / git log / the files): file and language counts (13 py, 3 md, 3 yaml, 3 json), folder counts, `+60 -0` of PR 137, the 2 added files, the `calculate_payment_cost` user (`tests/test_payment_costs.py:3`), the dbt edge `stg_orders -> fct_daily_totals`, and the week count (5 commits in 30 days by `git log --all --since --author`; 35 vs 37 over 400 days is the two merge commits that `--no-merges` leaves out) all equal the CLI output. Notes, not bugs: `learn week` uses the local git author, so a fresh clone with another identity shows 0; `change --branch` compares with `origin/main`, the PR with its real target (`staging`).
**Bug found and fixed (PR #140):** `learn item` on a pipeline yaml printed `jobs: ["ValidatePR", null, null, null]` because `- template:` entries have no `job` name; they now show as `template <path>` (steps too). Vitest case added.
**`/leer` in opencode 1.19.5 with Luna** (agent `aihub`, shared test home through `XDG_DATA_HOME` only): the agent loaded the `learn` skill, called `learn flow`, `week`, `onboarding`, `repo` and `level` and answered with the flow picture and an honest "no commits this week", but **did not write or save a lesson**; a later run died with a TLS error (infra) before saving. Fix in the skill (PR "learn skill orientation saves"): a question without a PR is still a lesson, write `explanation.json` and save it. Not proven live after the fix. To fill the Learn view the lesson was written and saved by hand with `learn validate` and `learn save`. Note: `schema.md` says `tellAColleague` is "at least 2 sentences" while the validator wants a list of at least 2.

**2. VS Code 3.0.0 bar with data.** `ai-context-hub-3.0.0.vsix` from the `vscode-v3.0.0` release (sha256 verified), isolated profile, VS Code 1.147. Story 3413, branch `feature/3413-final-proof-bar`, PR !1104 (own vote: approved with suggestions), one open thread added with `az devops invoke`. The bar showed the branch, `#3413 Final proof bar`, `!1104 1` with the vote tick, `no pipeline` (this repository has no pipeline for the branch) and `1` thread; the Learn view listed the saved lesson and its concept. Second source `aihub status --json`: story 3413, PR 1104 active, reviewer vote 5, `openThreads: 1`, `pipeline: []`. Not shown with data: a pipeline state (none exists for this synthetic branch; pipeline states are covered in the pipelines sections above). Cleanup (verified): PR !1104 abandoned, branch deleted on origin, story 3413 deleted, my windows closed.
Proof PNGs: `20261119-0056-L-final-learn-cli.png` (rendered summary), `20261119-0056-L-final-bar-300.png`.

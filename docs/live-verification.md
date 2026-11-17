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

## Leftovers

Pipeline run 266 (and the retried attempt of run 239) cannot be deleted in Azure DevOps; they are harmless history.

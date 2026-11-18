# Azure DevOps inventory: what the legacy Hub had, what a dev team needs, where it lives in `aihub`

Sources: (a) the legacy Hub (`MyDataIntelligence/extensions`, tag `legacy/hub-surface-v2-2026-11-17`): the 469 tools of `HubApiToolMatrixTest` (the Azure DevOps ones are the `ado_*`, `pr_*`, `pipeline_*`, `workitem_*`, `testplan_*`, `wiki_*`, `release_*`, `boards_*`, `git_post_commit_status` and `test_*` tools), `core/azure-devops-core` and the table-driven Hub Lite port `archive/copilot-lite/lib/hub_lite/tools/*.py`; (b) the Azure DevOps REST areas that matter to a development team.

Column **Old Hub** names the legacy tool (`-` = the old Hub did not have it). Column **Status**: `exists` (already an `aihub` command), `build` (to build in this round), `out` (out of scope, with the reason).

## Rules for everything that is built
- Every command has a compact text form and `--json`; lists take `--top`/`--filter` and never dump more than a screen by default.
- Every write has `--dry-run` (prints the REST call it would make) and deletes need `--yes`. Prose and bodies go in files (`--body-file`, `--query-file`); a secret goes in with `--value-stdin`, never on the command line.
- Secret values are never printed: variable-group values flagged secret and Key Vault references are shown as `***` / `keyvault:<vault>/<secret>`; secure files and service connections are read as metadata only.
- ACC and PRD protection (same words as Fabric: `acc`, `acceptance`, `acceptatie`, `uat`, `prd`, `prod`, `production`, `productie`; PRD wins): approving or rejecting a pipeline approval, running a pipeline against, or changing a variable group or environment of such a name is refused before any call unless `--allow-env <acc|prd>` names it. Reads work everywhere.
- Synthetic live checks only (`ferron-test`): reads are live-verified; writes only on objects the check creates and removes.

## Repos: branches, tags, files, commits, forks
| Capability | Old Hub | REST (`_apis/git/repositories/{repo}/...`) | `aihub` command | Status |
|---|---|---|---|---|
| List repositories, clone | ado_repo_list | `git/repositories` | `aihub repos list|clone` | exists |
| Repository details (default branch, size, URLs) | - | `git/repositories/{repo}` | `aihub repo show` | built |
| List branches (filter, ahead/behind) | git_check_conflicts (partly) | `refs?filter=heads/`, `stats/branches` | `aihub repo branch list` | built |
| Create a branch on the server (from a branch or commit) | git_create_branch (local only) | `refs` (POST update) | `aihub repo branch create` | built |
| Delete a branch | story_finish (own branch only) | `refs` (POST newObjectId 0) | `aihub repo branch delete --yes` | built |
| Lock / unlock a branch | - | `refs?filter=heads/x` (PATCH isLocked) | `aihub repo branch lock|unlock` | built |
| Update a branch from its target | git_update_from_target | local git | `aihub branch update` | exists |
| List / create / delete tags (lightweight, annotated) | git_tag (local) | `refs?filter=tags/`, `annotatedtags` | `aihub repo tag list|create|delete` | built |
| Folder tree of a branch | ado_repo_tree | `items?scopePath&recursionLevel` | `aihub repo tree` | built |
| Read a file at a branch, tag or commit | ado_repo_read_file | `items?path&versionDescriptor` | `aihub repo file` | built |
| Commits (filter by path, author, date) and one commit with changes | git_get_history, git_get_commit | `commits`, `commits/{id}/changes` | `aihub repo commits|commit` | built |
| Diff between two refs | git_get_diff | `diffs/commits` | `aihub repo diff` | built |
| Pushes (who pushed what, when) | - | `pushes` | `aihub repo pushes` | built |
| Commit statuses (post and read; the PR checks of a custom CI) | git_post_commit_status | `commits/{id}/statuses` | `aihub repo status post|list` | built |
| Code search across repositories | ado_code_search | `almsearch.dev.azure.com/.../codesearchresults` | `aihub search code` | built |
| Forks: list, create | - | `forks/{repoId}`, `repositories` (POST parentRepository) | `aihub repo forks list|create` | built (unit only: forks create leaves a repository the CLI cannot delete) |
| Create / delete / rename a repository, import | - | `git/repositories` | - | out: repository lifecycle belongs to project admins and Terraform (skill `terraform`) |
| Repository permissions and policies of a repo | - | `accesscontrolentries`, `policy/configurations` | `aihub devops permissions`, `aihub policy` | built |
| Add repository files to a context pack | ado_repo_add_to_context | - | - | out: the agent reads files with its own tools |
| Push a commit through REST | - | `pushes` (POST) | - | out: local `git push` does it |
| Cherry-pick one PR or commit to other branches | git_cherry_pick* | `cherrypicks` / local git | `aihub cherry-pick` | exists |

## Pull requests
| Capability | Old Hub | REST (`git/repositories/{repo}/pullrequests/...`) | `aihub` command | Status |
|---|---|---|---|---|
| Create (template, story link, target) and update sections | pr_create_or_describe, pr_make, pr_create_draft_for_branch | `pullrequests` | `aihub pr create|update` | exists |
| List and show (mine, as reviewer, by branch) | pr_search, pr_list_my_reviews, pr_get_current, pr_get_status | `pullrequests`, `pullrequests/{id}` | `aihub pr list|show` | exists |
| Changed files and diff | pr_get_branch_changes, git_get_file_diff | `iterations/{n}/changes` | `aihub pr changes` | exists |
| Explain a PR | pr_review_someones_pr | `iterations`, `threads` | `aihub pr explain` | exists |
| Comment threads: read, reply, set status | pr_get_threads, pr_reply_threads, pr_post_comments, pr_post_summary | `threads` | `aihub comments get|reply`, `aihub review show|post` | exists |
| Policy evaluations (what blocks completion) and requeue a build policy | pr_list_policies, pr_requeue_policy | `policy/evaluations` | `aihub pr checks|requeue` | exists |
| Complete (squash/merge strategy, delete source) and set auto-complete | pr_complete | `pullrequests/{id}` (PATCH) | `aihub pr complete [--auto]` | exists |
| Abandon / reactivate | pr_abandon, pr_reactivate | PATCH status | `aihub pr abandon|reactivate` | built |
| Publish a draft / turn a PR into a draft | pr_publish | PATCH isDraft | `aihub pr publish|draft` | built |
| Reviewers: list, add (required or optional), remove | pr_set_reviewers, pr_remove_reviewer | `reviewers` | `aihub pr reviewers list|add|remove` | built |
| Vote (approve, approve with suggestions, wait, reject, reset) | pr_vote | `reviewers/{id}` (PUT vote) | `aihub pr vote` | built |
| Labels: list, add, remove | pr_set_labels | `labels` | `aihub pr labels list|add|remove` | built |
| Statuses on a PR (post and read) | pr_post_status | `statuses` | `aihub pr status post|list` | built |
| Linked work items: list, add, remove | pr_link_story_siblings (partly) | `workitems`, `wit/workitems/{id}` relations | `aihub pr workitems list|add|remove` | built |
| Iterations (pushes within the PR) and what changed since | - | `iterations` | `aihub pr iterations` | built |
| Cancel auto-complete | - | PATCH autoCompleteSetBy null | `aihub pr autocomplete --cancel` | built |
| Change target branch of a PR | - | PATCH targetRefName | `aihub pr update --target` | exists |
| Merge a PR via REST for another repo of a set | pr_link_story_siblings | - | `aihub crossrepo link-prs` | exists |
| Pull request attachments (screenshots) | pr_post_comments (attach) | `attachments/{name}` | `aihub evidence add` | exists |
| PR explanation status, review worktrees | pr_explanation_status, pr_review_worktree | - | - | out: Hub UI states; the agent uses git worktrees (`aihub worktree`) |

## Policies (branch policies)
| Capability | Old Hub | REST (`policy/configurations`) | `aihub` command | Status |
|---|---|---|---|---|
| List the policy types (ids and names; the commands resolve a type by its display name, no ids to remember) | - | `policy/types` | `aihub policy types` | built |
| List policies of a repo/branch (enabled, blocking, scope) | pr_list_policies (evaluations only) | `policy/configurations?repositoryId&refName` | `aihub policy list` | built |
| Show one policy in readable form | - | `policy/configurations/{id}` | `aihub policy show` | built |
| Minimum number of reviewers (count, creator may vote, reset on push) | - | policy type "Minimum number of reviewers" | `aihub policy create|update --type min-reviewers` | built |
| Build validation (definition, expiry, trigger, filter) | - | policy type "Build" | `--type build` | built |
| Work item linking required | - | policy type "Work item linking" | `--type work-item-linking` | built |
| Comment resolution required | - | policy type "Comment requirements" | `--type comment-resolution` | built |
| Required reviewers (identities, paths) | - | policy type "Required reviewers" | `--type required-reviewers` | built |
| Merge strategy (squash, rebase, merge, no fast-forward) | - | policy type "Require a merge strategy" | `--type merge-strategy` | built |
| Status check policy | - | policy type "Status" | `--type status` | built |
| Update (enable/disable, blocking), delete | - | PUT/DELETE `policy/configurations/{id}` | `aihub policy update|delete --yes` | built |
| Policy evaluations of a PR | pr_list_policies | `policy/evaluations` | `aihub pr checks` | exists |
| Path filter, automatic reviewers by path | - | `settings.scope[].matchKind/refName`, `filenamePatterns` | `--path` on the policy types that take it | built |

## Pipelines (Build and YAML)
| Capability | Old Hub | REST | `aihub` command | Status |
|---|---|---|---|---|
| Definitions: list (by name/folder/repo) and show | pipeline_list | `build/definitions`, `pipelines` | `aihub pipeline def list|show` | built |
| Create a YAML definition for a repo file | pipeline_create_definition | POST `build/definitions` | `aihub pipeline def create` | built |
| Update a definition (name, folder, variables, triggers) | - | PUT `build/definitions/{id}` | `aihub pipeline def update` | built |
| Delete a definition | - | DELETE `build/definitions/{id}` | `aihub pipeline def delete --yes` | built |
| Runs: list, status, follow, logs, search logs | pipeline_list_runs, pipeline_status, pipeline_get_failure, pipeline_get_logs, pipeline_search_logs, pipeline_follow | `build/builds`, `timeline`, `logs` | `aihub pipeline runs|status|follow|logs` | exists |
| Run a pipeline (branch, parameters) | pipeline_run | POST `pipelines/{id}/runs` | `aihub pipeline run` | exists |
| Retry a failed stage | pipeline_retry_stage | PATCH `build/builds/{id}/stages/{stage}` | `aihub pipeline retry` | exists |
| Cancel a run | pipeline_cancel | PATCH `build/builds/{id}` cancelling | `aihub pipeline cancel` | built (unit only: no way to keep a run queued on the test project; a completed run is read live) |
| Watch a run and notify | pipeline_watch, pipeline_unwatch | polling | `aihub watch` | exists |
| Preview / validate YAML (expanded YAML, errors) | pipeline_preview_yaml | POST `pipelines/{id}/runs` previewRun | `aihub pipeline validate` | built |
| Artifacts: list and download | pipeline_download_artifact | `build/builds/{id}/artifacts` | `aihub pipeline artifacts list|download` | built (unit only: no run with artifacts in the test project; download is unit only) |
| Test results of a run | test_publish_results (write) | `test/runs`, `test/results` | `aihub testplan runs|results` | built |
| Environments: list, show, create | pipeline_list_environments | `pipelines/environments` | `aihub pipeline env list|show|create` | built |
| Environment deployments (what ran where) | pipeline_environment_deployments | `pipelines/environments/{id}/environmentdeploymentrecords` | `aihub pipeline env deployments` | built |
| Approvals and checks: list | pipeline_list_approvals, pipeline_list_checks | `pipelines/approvals`, `pipelines/checks/configurations` | `aihub pipeline approvals list`, `pipeline env checks` | built |
| Approve or reject an approval (refused for ACC/PRD unless `--allow-env`) | pipeline_approve | PATCH `pipelines/approvals` | `aihub pipeline approvals approve|reject` | built (unit only: needs an environment with an approval check; unit only) |
| Variable groups = Library (see below) | pipeline_list_variable_groups, pipeline_get_variable_group, pipeline_update_variable_group | `distributedtask/variablegroups` | `aihub library ...` | built |
| Secure files: list (metadata only, never content) | pipeline_list_secure_files | `distributedtask/securefiles` | `aihub pipeline securefiles list` | built |
| Service connections: list and show (metadata only, no credentials) | pipeline_list_service_connections | `serviceendpoint/endpoints` | `aihub pipeline connections list|show` | built |
| Agent pools and agents: read | - | `distributedtask/pools`, `pools/{id}/agents` | `aihub devops pools` | built |
| Pipeline fix plan / prepare repair / apply | pipeline_fix_plan, pipeline_fix_apply, pipeline_prepare_repair | - | skill `pipeline-fix` (the agent edits and commits) | out: agent behaviour, not a REST tool |
| Pipeline evidence runs for the PR | pipeline_evidence_runs | `build/builds` | `aihub evidence add` + `pipeline runs` | exists |
| Run timeline: stages, jobs, failing tasks with errors, durations, retry attempts | pipeline_get_failure (failing step only) | `build/builds/{id}/timeline` | `aihub pipeline timeline --run N [--failed|--tasks]` | built |
| Failed tests of a run with message, stack head and a flaky marker over earlier runs | - | `test/runs`, `test/runs/{id}/results` | `aihub pipeline tests --run N [--history n]` | built |
| Code coverage of a run | - | `test/codecoverage` | `aihub pipeline coverage --run N` | built (unit only: no run in the test project publishes coverage) |
| Resolved variables: system, definition (secrets hidden), variable groups, queue-time parameters | - | `build/builds/{id}`, `build/definitions/{id}` | `aihub pipeline vars --run N` | built |
| Compare two runs: commits between, parameters, stage result and duration | - | timelines, `commits` | `aihub pipeline compare --run A --with B` | built |
| Expanded YAML with templates resolved | pipeline_preview_yaml | `pipelines/{id}/runs` previewRun | `aihub pipeline expand [--file f.yml]` | built |
| Triggers (CI, PR), resources and parameters of a YAML pipeline | - | the YAML in the repository | `aihub pipeline trigger show --pipeline P` | built |
| Schedules (YAML cron and classic) | - | the YAML, `build/definitions` | `aihub pipeline schedule list` | built (unit only: no scheduled pipeline in the test project) |
| Authorize a pipeline for an environment, variable group, service connection, secure file | - | `pipelines/pipelinePermissions/{type}/{id}` | `aihub pipeline authorize --pipeline P --resource environment:dev` | built |
| Team conventions for pipelines (names, branches they validate, required templates) | - | team.yaml `pipelines:` | `aihub pipeline validate` (reports a missing required template) | built |
| Pipeline knowledge for the agent | - | skill `pipeline-author` + `references/azure-pipelines.md`, `pipeline-fix` reads timeline and tests first | skills | built |
| Release pipelines (classic, `vsrm.dev.azure.com`) | - | `release/definitions`, `release/releases` | - | out: classic release pipelines are retired in favour of YAML environments; read them in the portal |
| Queue-time variables, run parameters | pipeline_run | `pipelines/{id}/runs` templateParameters | `aihub pipeline run --params-file` | exists |

## Library: variable groups (Key Vault-linked included)
| Capability | Old Hub | REST (`distributedtask/variablegroups`) | `aihub` command | Status |
|---|---|---|---|---|
| List groups (filter by name) | pipeline_list_variable_groups | GET | `aihub library list` | built |
| Show a group (variables, secret flags, Key Vault link; secret values never shown) | pipeline_get_variable_group | GET `{id}` | `aihub library show` | built |
| Create a group (plain variables, secret variables, Key Vault provider) | - | POST | `aihub library create --vars-file F [--keyvault <connection>/<vault>]` | built (unit only: the test organisation has no Key Vault service connection; Key Vault creation is unit only) |
| Set / change one variable (secret via `--value-stdin`) | pipeline_update_variable_group | PUT `{id}` | `aihub library set --group G --name N [--secret] [--value-stdin|--value V]` | built |
| Remove a variable, delete a group | - | PUT / DELETE | `aihub library unset|delete --yes` | built |
| Which pipelines use a group | - | `build/definitions` scan | `aihub library usage` | built |
| Pipeline permissions on a group (authorize a pipeline) | - | `pipelines/pipelinePermissions/variablegroup/{id}` | `aihub library authorize --pipeline P` | built |
| Compare two groups (acc against prd) | - | GET x2 | `aihub library diff` | built |

## Boards: work items, queries, iterations
| Capability | Old Hub | REST (`wit/...`, `work/...`) | `aihub` command | Status |
|---|---|---|---|---|
| Show a work item (fields, relations, comments) | workitem_get, workitem_get_context | `workitems/{id}?$expand=all` | `aihub story show`, `aihub workitem get` | exists / built |
| Create (story, task, bug) with template sections | workitem_create, workitem_create_tasks, story_create_or_update | POST `workitems/${type}` | `aihub story create`, `aihub workitem create` | exists |
| Refine a story | workitem_refine_round, workitem_prepare_refinement | PATCH | `aihub story refine` | exists |
| Change state | workitem_set_state, workitem_undo_state | PATCH | `aihub workitem state` | exists |
| Update any field (title, area, iteration, assigned to, priority, custom) | workitem_update | PATCH | `aihub workitem update --field name=value` | built |
| Delete / restore (recycle bin) | - | DELETE `workitems/{id}` | `aihub workitem delete --yes` | built |
| Comments: add, list | workitem_add_comment, workitem_list_comments | `workItems/{id}/comments` | `aihub workitem comment|comments` | built |
| History (revisions) | workitem_history | `workItems/{id}/revisions` | `aihub workitem history` | built |
| Links and relations: parent/child, related, predecessor, PR, branch, commit | workitem_link, workitem_unlink, story_link | PATCH relations | `aihub workitem link|unlink` (`story link` exists for branches) | built |
| Tags: add, remove, list | - | PATCH `System.Tags`, `wit/tags` | `aihub workitem tag|untag`, `aihub boards tags` | built |
| Attachments: add, list, download | workitem_attach | `wit/attachments` | `aihub workitem attach|attachments` | built |
| Work item types and states of the project process | workitem_metadata | `wit/workitemtypes`, `states` | `aihub workitem types` | built |
| WIQL query (inline or from a file) | workitem_query | POST `wit/wiql` | `aihub boards query run` | built |
| Saved queries: list, run, show, create | workitem_saved_queries, workitem_run_saved_query | `wit/queries` | `aihub boards query list|run|show|create` | built |
| My work, search | workitem_list_mine, workitem_search, boards_lookup | WIQL | `aihub work`, `aihub boards query run --mine` | exists |
| Iterations / sprints: list, current, items of a sprint | workitem_iterations | `work/teamsettings/iterations`, `iterations/{id}/workitems` | `aihub boards sprint list|current|items` | built |
| Team capacity of a sprint (read; set) | - | `iterations/{id}/capacities` | `aihub boards capacity show|set` | built (unit only: the test team has no capacity entries; set is unit only) |
| Area paths and iteration paths (classification nodes): list, create | - | `wit/classificationnodes` | `aihub boards areas|iterations list|create` | built (unit only: classification nodes cannot be deleted again from the CLI; create is unit only) |
| Board columns, swimlanes, card rules (read) | - | `work/boards`, `columns`, `rows` | `aihub boards show` | built |
| Teams and team members | - | `core/teams`, `members` | `aihub devops teams` | built |
| Backlog levels (epics, features, stories) | - | `work/backlogs` | `aihub boards backlog` | built |
| Delivery plans, analytics views, OData reports | - | `work/plans`, `analytics.dev.azure.com` | - | out: portal reporting; the WIQL tool answers the same questions in text |
| Import an agent answer as stories | workitem_import_answer, story_import_answer, story_write_proposal | - | skill `story-create` (the agent writes the file) | out: Hub chat flow |
| Move to ready, refine lane | workitem_move_to_ready, story_refine_lane | PATCH | `aihub story refine`, `workitem state` | exists |

## Wiki
| Capability | Old Hub | REST (`wiki/wikis/...`) | `aihub` command | Status |
|---|---|---|---|---|
| List wikis (project wiki, code wikis) | wiki_get_context | `wiki/wikis` | `aihub wiki list` | built |
| Page tree and one page (markdown) | wiki_get_context, wiki_prepare | `pages?recursionLevel`, `pages?path&includeContent` | `aihub wiki pages|read` | built |
| Update / publish a page (diff first) | wiki_propose_update, wiki_publish, wiki_import_answer | PUT `pages?path` with ETag | `aihub wiki update [--publish]` | exists |
| Create a page (with parent) | wiki_create_page | PUT `pages?path` | `aihub wiki create` | built |
| Move / rename a page | - | POST `pagemoves` | `aihub wiki move` | built |
| Delete a page | - | DELETE `pages?path` | `aihub wiki delete --yes` | built |
| Search wiki text | - | `almsearch.dev.azure.com/.../wikisearchresults` | `aihub search wiki` | built |
| Page attachments | - | `attachments?name` | `aihub wiki attach` | built |
| Page revisions / history | - | `pages/{id}/stats`, `pagesBatch` | `aihub wiki history` | built |
| Create a wiki, publish a repo folder as code wiki | wiki_create_wiki, wiki_link_page | POST `wiki/wikis` | `aihub wiki create-wiki` | built (unit only: would leave a wiki the CLI does not delete; unit only) |

## Test Plans
| Capability | Old Hub | REST (`testplan/...`, `test/...`) | `aihub` command | Status |
|---|---|---|---|---|
| Plans, suites (tree), test cases of a suite | - | `testplan/plans`, `suites`, `TestCase` | `aihub testplan plans|suites|cases` | exists |
| Test points of a suite and their outcome | testplan_list_points | `suites/{id}/TestPoint` | `aihub testplan points` | exists |
| Set the outcome of a point | testplan_set_outcome | PATCH `TestPoint` | `aihub testplan outcome --dry-run` | exists |
| Test runs and results (failed first) of a build | test_publish_results (write side) | `test/runs`, `results` | `aihub testplan runs|results` | exists |
| Publish results (Robot, JUnit) | test_publish_results, robot_post_results | `test/runs` (POST) | `aihub robot` | exists |
| Create plans, suites and cases | - | POST `testplan/...` | `aihub testplan create-plan|create-suite|create-case` | exists |
| Test configurations, test variables | - | `testplan/configurations` | - | out: configuration is portal work |

Test Plans note: the test organisation has no Test Plans license, so plan, suite and point reads answer empty and writes answer 403 there; the commands are covered by vitest and the dry-run only ("unit only").

## Artifacts (feeds)
| Capability | Old Hub | REST (`feeds.dev.azure.com`) | `aihub` command | Status |
|---|---|---|---|---|
| Feeds (project and organisation) | - | `packaging/feeds` | `aihub artifacts feeds` | exists |
| Packages of a feed (filter, type) | - | `feeds/{feed}/packages` | `aihub artifacts packages` | exists |
| Versions of a package | - | `packages/{id}/versions` | `aihub artifacts versions` | exists |
| Publish, promote, delete a package version | - | views, `pkgs.dev.azure.com` | - | out: publishing is part of the pipeline that builds the package, promotion is a release decision |
| Feed permissions and retention | - | `packaging/feeds/{id}/permissions` | `aihub devops permissions` (read) | built |

## Search, dashboards, notifications, security (read only)
| Capability | Old Hub | REST | `aihub` command | Status |
|---|---|---|---|---|
| Code search | ado_code_search | `almsearch ... codesearchresults` | `aihub search code` | built |
| Wiki search | - | `almsearch ... wikisearchresults` | `aihub search wiki` | built |
| Work item search | workitem_search | `almsearch ... workitemsearchresults` | `aihub search items` | built |
| Dashboards: list and widgets (read) | - | `dashboard/dashboards` | `aihub devops dashboards` | built |
| Notification subscriptions (mine, team) | - | `notification/subscriptions` | `aihub devops subscriptions` | built |
| Security namespaces and permissions of a user or group on a repo, branch or pipeline | - | `securitynamespaces`, `accesscontrolentries`, `permissionsreport` | `aihub devops permissions` | built |
| Projects and teams of the organisation | - | `projects`, `teams` | `aihub devops projects|teams` | built |
| Agent pools and queues (read) | - | `distributedtask/pools` | `aihub devops pools` | built |
| Change dashboards, subscriptions or permissions | - | PUT/POST | - | out: access and notification changes are administrator work, never an agent write |
| Service hooks, extensions, billing, audit log | - | `hooks`, `extensionmanagement`, `auditservice` | - | out: organisation administration |

## Cross-cutting tools of the old Hub that are not Azure DevOps REST
Hub-internal and removed with the Hub, listed so no tool is unaccounted for: context packs (`context_*`, 14 tools), approvals gate (`approval_*`, `plan_approve`, `hook_*`, `contract_*`), chat and workflow state (`chat_*`, `workflow_*`, `autopilot_*`), settings and templates (`settings_*`, `template_*`, `prompt_skill_*`; now `team.yaml`), notes (`notes_*`; `aihub note`), learning (`learn_*`), failure memory and quality (`failure_memory_*`, `quality_*`, `editor_problems_*`), knowledge and IaC lookups (`knowledge_*`, `iac_*`, `docs_*`), repository scope and mapping (`repository_*`, `repo_set_switch`, `azure_target_set`; now team.yaml `repositories`), cross-repo impact (`crossrepo_*`; `aihub crossrepo`), Robot (`robot_*`; `aihub robot`), local git (`git_*`: the agent uses its own git), release train (`release_*`; `aihub release`), worktrees (`story_worktrees`, `story_add_repository`; `aihub worktree`).

## Counts

| Area | Rows | Old Hub had | exists (before this round or added by the parallel testplan/artifacts change) | built | of which unit only | out |
|---|---|---|---|---|---|---|
| Repos: branches, tags, files, commits, forks | 21 | 14 | 3 | 15 | 1 | 3 |
| Pull requests | 20 | 17 | 10 | 9 | 0 | 1 |
| Policies (branch policies) | 13 | 2 | 1 | 12 | 0 | 0 |
| Pipelines (Build and YAML) | 35 | 22 | 6 | 27 | 5 | 2 |
| Library: variable groups (Key Vault-linked included) | 8 | 3 | 0 | 8 | 1 | 0 |
| Boards: work items, queries, iterations | 24 | 16 | 6 | 16 | 2 | 2 |
| Wiki | 10 | 5 | 1 | 9 | 1 | 0 |
| Test Plans | 7 | 4 | 6 | 0 | 0 | 1 |
| Artifacts (feeds) | 5 | 0 | 3 | 1 | 0 | 1 |
| Search, dashboards, notifications, security (read only) | 10 | 2 | 0 | 8 | 0 | 2 |
| **Total** | **153** | **85** | **36** | **105** | **10** | **12** |

Every row that was `build` in the first version of this file is delivered (pull requests: policy, library, repo and search, pr administration, pipeline administration and `aihub devops`, wiki, boards and workitem, pipeline knowledge, test plans and artifacts). `unit only` rows are covered by vitest with fake REST routes and, where the test organisation cannot exercise them, say why. Every `out` row has its reason in the table. The counts are generated from the tables by a small script, so they follow the rows.

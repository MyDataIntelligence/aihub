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
| Repository details (default branch, size, URLs) | - | `git/repositories/{repo}` | `aihub repo show` | build |
| List branches (filter, ahead/behind) | git_check_conflicts (partly) | `refs?filter=heads/`, `stats/branches` | `aihub repo branch list` | build |
| Create a branch on the server (from a branch or commit) | git_create_branch (local only) | `refs` (POST update) | `aihub repo branch create` | build |
| Delete a branch | story_finish (own branch only) | `refs` (POST newObjectId 0) | `aihub repo branch delete --yes` | build |
| Lock / unlock a branch | - | `refs?filter=heads/x` (PATCH isLocked) | `aihub repo branch lock|unlock` | build |
| Update a branch from its target | git_update_from_target | local git | `aihub branch update` | exists |
| List / create / delete tags (lightweight, annotated) | git_tag (local) | `refs?filter=tags/`, `annotatedtags` | `aihub repo tag list|create|delete` | build |
| Folder tree of a branch | ado_repo_tree | `items?scopePath&recursionLevel` | `aihub repo tree` | build |
| Read a file at a branch, tag or commit | ado_repo_read_file | `items?path&versionDescriptor` | `aihub repo file` | build |
| Commits (filter by path, author, date) and one commit with changes | git_get_history, git_get_commit | `commits`, `commits/{id}/changes` | `aihub repo commits|commit` | build |
| Diff between two refs | git_get_diff | `diffs/commits` | `aihub repo diff` | build |
| Pushes (who pushed what, when) | - | `pushes` | `aihub repo pushes` | build |
| Commit statuses (post and read; the PR checks of a custom CI) | git_post_commit_status | `commits/{id}/statuses` | `aihub repo status post|list` | build |
| Code search across repositories | ado_code_search | `almsearch.dev.azure.com/.../codesearchresults` | `aihub search code` | build |
| Forks: list, create | - | `forks/{repoId}`, `repositories` (POST parentRepository) | `aihub repo forks list|create` | build |
| Create / delete / rename a repository, import | - | `git/repositories` | - | out: repository lifecycle belongs to project admins and Terraform (skill `terraform`) |
| Repository permissions and policies of a repo | - | `accesscontrolentries`, `policy/configurations` | `aihub devops permissions`, `aihub policy` | build (see below) |
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
| Abandon / reactivate | pr_abandon, pr_reactivate | PATCH status | `aihub pr abandon|reactivate` | build |
| Publish a draft / turn a PR into a draft | pr_publish | PATCH isDraft | `aihub pr publish|draft` | build |
| Reviewers: list, add (required or optional), remove | pr_set_reviewers, pr_remove_reviewer | `reviewers` | `aihub pr reviewers list|add|remove` | build |
| Vote (approve, approve with suggestions, wait, reject, reset) | pr_vote | `reviewers/{id}` (PUT vote) | `aihub pr vote` | build |
| Labels: list, add, remove | pr_set_labels | `labels` | `aihub pr labels list|add|remove` | build |
| Statuses on a PR (post and read) | pr_post_status | `statuses` | `aihub pr status post|list` | build |
| Linked work items: list, add, remove | pr_link_story_siblings (partly) | `workitems`, `wit/workitems/{id}` relations | `aihub pr workitems list|add|remove` | build |
| Iterations (pushes within the PR) and what changed since | - | `iterations` | `aihub pr iterations` | build |
| Cancel auto-complete | - | PATCH autoCompleteSetBy null | `aihub pr complete --cancel-auto` | build |
| Change target branch of a PR | - | PATCH targetRefName | `aihub pr update --target` | build |
| Merge a PR via REST for another repo of a set | pr_link_story_siblings | - | `aihub crossrepo link-prs` | exists |
| Pull request attachments (screenshots) | pr_post_comments (attach) | `attachments/{name}` | `aihub evidence add` | exists |
| PR explanation status, review worktrees | pr_explanation_status, pr_review_worktree | - | - | out: Hub UI states; the agent uses git worktrees (`aihub worktree`) |

## Policies (branch policies)
| Capability | Old Hub | REST (`policy/configurations`) | `aihub` command | Status |
|---|---|---|---|---|
| List the policy types (ids and names; the commands resolve a type by its display name, no ids to remember) | - | `policy/types` | `aihub policy types` | build |
| List policies of a repo/branch (enabled, blocking, scope) | pr_list_policies (evaluations only) | `policy/configurations?repositoryId&refName` | `aihub policy list` | build |
| Show one policy in readable form | - | `policy/configurations/{id}` | `aihub policy show` | build |
| Minimum number of reviewers (count, creator may vote, reset on push) | - | policy type "Minimum number of reviewers" | `aihub policy create|update --type min-reviewers` | build |
| Build validation (definition, expiry, trigger, filter) | - | policy type "Build" | `--type build` | build |
| Work item linking required | - | policy type "Work item linking" | `--type work-item-linking` | build |
| Comment resolution required | - | policy type "Comment requirements" | `--type comment-resolution` | build |
| Required reviewers (identities, paths) | - | policy type "Required reviewers" | `--type required-reviewers` | build |
| Merge strategy (squash, rebase, merge, no fast-forward) | - | policy type "Require a merge strategy" | `--type merge-strategy` | build |
| Status check policy | - | policy type "Status" | `--type status` | build |
| Update (enable/disable, blocking), delete | - | PUT/DELETE `policy/configurations/{id}` | `aihub policy update|delete --yes` | build |
| Policy evaluations of a PR | pr_list_policies | `policy/evaluations` | `aihub pr checks` | exists |
| Path filter, automatic reviewers by path | - | `settings.scope[].matchKind/refName`, `filenamePatterns` | `--path` on the policy types that take it | build |

## Pipelines (Build and YAML)
| Capability | Old Hub | REST | `aihub` command | Status |
|---|---|---|---|---|
| Definitions: list (by name/folder/repo) and show | pipeline_list | `build/definitions`, `pipelines` | `aihub pipeline def list|show` | build |
| Create a YAML definition for a repo file | pipeline_create_definition | POST `build/definitions` | `aihub pipeline def create` | build |
| Update a definition (name, folder, variables, triggers) | - | PUT `build/definitions/{id}` | `aihub pipeline def update` | build |
| Delete a definition | - | DELETE `build/definitions/{id}` | `aihub pipeline def delete --yes` | build |
| Runs: list, status, follow, logs, search logs | pipeline_list_runs, pipeline_status, pipeline_get_failure, pipeline_get_logs, pipeline_search_logs, pipeline_follow | `build/builds`, `timeline`, `logs` | `aihub pipeline runs|status|follow|logs` | exists |
| Run a pipeline (branch, parameters) | pipeline_run | POST `pipelines/{id}/runs` | `aihub pipeline run` | exists |
| Retry a failed stage | pipeline_retry_stage | PATCH `build/builds/{id}/stages/{stage}` | `aihub pipeline retry` | exists |
| Cancel a run | pipeline_cancel | PATCH `build/builds/{id}` cancelling | `aihub pipeline cancel` | build |
| Watch a run and notify | pipeline_watch, pipeline_unwatch | polling | `aihub watch` | exists |
| Preview / validate YAML (expanded YAML, errors) | pipeline_preview_yaml | POST `pipelines/{id}/runs` previewRun | `aihub pipeline validate` | build |
| Artifacts: list and download | pipeline_download_artifact | `build/builds/{id}/artifacts` | `aihub pipeline artifacts list|download` | build |
| Test results of a run | test_publish_results (write) | `test/runs`, `test/results` | `aihub testplan runs|results` | build |
| Environments: list, show, create | pipeline_list_environments | `pipelines/environments` | `aihub pipeline env list|show|create` | build |
| Environment deployments (what ran where) | pipeline_environment_deployments | `pipelines/environments/{id}/environmentdeploymentrecords` | `aihub pipeline env deployments` | build |
| Approvals and checks: list | pipeline_list_approvals, pipeline_list_checks | `pipelines/approvals`, `pipelines/checks/configurations` | `aihub pipeline approvals list`, `pipeline env checks` | build |
| Approve or reject an approval (refused for ACC/PRD unless `--allow-env`) | pipeline_approve | PATCH `pipelines/approvals` | `aihub pipeline approvals approve|reject` | build |
| Variable groups = Library (see below) | pipeline_list_variable_groups, pipeline_get_variable_group, pipeline_update_variable_group | `distributedtask/variablegroups` | `aihub library ...` | build |
| Secure files: list (metadata only, never content) | pipeline_list_secure_files | `distributedtask/securefiles` | `aihub pipeline securefiles list` | build |
| Service connections: list and show (metadata only, no credentials) | pipeline_list_service_connections | `serviceendpoint/endpoints` | `aihub pipeline connections list|show` | build |
| Agent pools and agents: read | - | `distributedtask/pools`, `pools/{id}/agents` | `aihub devops pools` | build |
| Pipeline fix plan / prepare repair / apply | pipeline_fix_plan, pipeline_fix_apply, pipeline_prepare_repair | - | skill `pipeline-fix` (the agent edits and commits) | out: agent behaviour, not a REST tool |
| Pipeline evidence runs for the PR | pipeline_evidence_runs | `build/builds` | `aihub evidence add` + `pipeline runs` | exists |
| Release pipelines (classic, `vsrm.dev.azure.com`) | - | `release/definitions`, `release/releases` | - | out: classic release pipelines are retired in favour of YAML environments; read them in the portal |
| Queue-time variables, run parameters | pipeline_run | `pipelines/{id}/runs` templateParameters | `aihub pipeline run --params-file` | exists |

## Library: variable groups (Key Vault-linked included)
| Capability | Old Hub | REST (`distributedtask/variablegroups`) | `aihub` command | Status |
|---|---|---|---|---|
| List groups (filter by name) | pipeline_list_variable_groups | GET | `aihub library list` | build |
| Show a group (variables, secret flags, Key Vault link; secret values never shown) | pipeline_get_variable_group | GET `{id}` | `aihub library show` | build |
| Create a group (plain variables, secret variables, Key Vault provider) | - | POST | `aihub library create --vars-file F [--keyvault <connection>/<vault>]` | build |
| Set / change one variable (secret via `--value-stdin`) | pipeline_update_variable_group | PUT `{id}` | `aihub library set --group G --name N [--secret] [--value-stdin|--value V]` | build |
| Remove a variable, delete a group | - | PUT / DELETE | `aihub library unset|delete --yes` | build |
| Which pipelines use a group | - | `build/definitions` scan | `aihub library usage` | build |
| Pipeline permissions on a group (authorize a pipeline) | - | `pipelines/pipelinePermissions/variablegroup/{id}` | `aihub library authorize --pipeline P` | build |
| Compare two groups (acc against prd) | - | GET x2 | `aihub library diff` | build |

## Boards: work items, queries, iterations
| Capability | Old Hub | REST (`wit/...`, `work/...`) | `aihub` command | Status |
|---|---|---|---|---|
| Show a work item (fields, relations, comments) | workitem_get, workitem_get_context | `workitems/{id}?$expand=all` | `aihub story show`, `aihub workitem get` | exists / build |
| Create (story, task, bug) with template sections | workitem_create, workitem_create_tasks, story_create_or_update | POST `workitems/${type}` | `aihub story create`, `aihub workitem create` | exists |
| Refine a story | workitem_refine_round, workitem_prepare_refinement | PATCH | `aihub story refine` | exists |
| Change state | workitem_set_state, workitem_undo_state | PATCH | `aihub workitem state` | exists |
| Update any field (title, area, iteration, assigned to, priority, custom) | workitem_update | PATCH | `aihub workitem update --field name=value` | build |
| Delete / restore (recycle bin) | - | DELETE `workitems/{id}` | `aihub workitem delete --yes` | build |
| Comments: add, list | workitem_add_comment, workitem_list_comments | `workItems/{id}/comments` | `aihub workitem comment|comments` | build |
| History (revisions) | workitem_history | `workItems/{id}/revisions` | `aihub workitem history` | build |
| Links and relations: parent/child, related, predecessor, PR, branch, commit | workitem_link, workitem_unlink, story_link | PATCH relations | `aihub workitem link|unlink` (`story link` exists for branches) | build |
| Tags: add, remove, list | - | PATCH `System.Tags`, `wit/tags` | `aihub workitem tag|untag`, `aihub boards tags` | build |
| Attachments: add, list, download | workitem_attach | `wit/attachments` | `aihub workitem attach|attachments` | build |
| Work item types and states of the project process | workitem_metadata | `wit/workitemtypes`, `states` | `aihub workitem types` | build |
| WIQL query (inline or from a file) | workitem_query | POST `wit/wiql` | `aihub boards query run` | build |
| Saved queries: list, run, show, create | workitem_saved_queries, workitem_run_saved_query | `wit/queries` | `aihub boards query list|run|show|create` | build |
| My work, search | workitem_list_mine, workitem_search, boards_lookup | WIQL | `aihub work`, `aihub boards query run --mine` | exists |
| Iterations / sprints: list, current, items of a sprint | workitem_iterations | `work/teamsettings/iterations`, `iterations/{id}/workitems` | `aihub boards sprint list|current|items` | build |
| Team capacity of a sprint (read; set) | - | `iterations/{id}/capacities` | `aihub boards capacity show|set` | build |
| Area paths and iteration paths (classification nodes): list, create | - | `wit/classificationnodes` | `aihub boards areas|iterations list|create` | build |
| Board columns, swimlanes, card rules (read) | - | `work/boards`, `columns`, `rows` | `aihub boards show` | build |
| Teams and team members | - | `core/teams`, `members` | `aihub devops teams` | build |
| Backlog levels (epics, features, stories) | - | `work/backlogs` | `aihub boards backlog` | build |
| Delivery plans, analytics views, OData reports | - | `work/plans`, `analytics.dev.azure.com` | - | out: portal reporting; the WIQL tool answers the same questions in text |
| Import an agent answer as stories | workitem_import_answer, story_import_answer, story_write_proposal | - | skill `story-create` (the agent writes the file) | out: Hub chat flow |
| Move to ready, refine lane | workitem_move_to_ready, story_refine_lane | PATCH | `aihub story refine`, `workitem state` | exists |

## Wiki
| Capability | Old Hub | REST (`wiki/wikis/...`) | `aihub` command | Status |
|---|---|---|---|---|
| List wikis (project wiki, code wikis) | wiki_get_context | `wiki/wikis` | `aihub wiki list` | build |
| Page tree and one page (markdown) | wiki_get_context, wiki_prepare | `pages?recursionLevel`, `pages?path&includeContent` | `aihub wiki pages|read` | build |
| Update / publish a page (diff first) | wiki_propose_update, wiki_publish, wiki_import_answer | PUT `pages?path` with ETag | `aihub wiki update [--publish]` | exists |
| Create a page (with parent) | wiki_create_page | PUT `pages?path` | `aihub wiki create` | build |
| Move / rename a page | - | POST `pagemoves` | `aihub wiki move` | build |
| Delete a page | - | DELETE `pages?path` | `aihub wiki delete --yes` | build |
| Search wiki text | - | `almsearch.dev.azure.com/.../wikisearchresults` | `aihub search wiki` | build |
| Page attachments | - | `attachments?name` | `aihub wiki attach` | build |
| Page revisions / history | - | `pages/{id}/stats`, `pagesBatch` | `aihub wiki history` | build |
| Create a wiki, publish a repo folder as code wiki | wiki_create_wiki, wiki_link_page | POST `wiki/wikis` | `aihub wiki create-wiki` | build |

## Test Plans
| Capability | Old Hub | REST (`testplan/...`, `test/...`) | `aihub` command | Status |
|---|---|---|---|---|
| Plans, suites (tree), test cases of a suite | - | `testplan/plans`, `suites`, `TestCase` | `aihub testplan plans|suites|cases` | build |
| Test points of a suite and their outcome | testplan_list_points | `suites/{id}/TestPoint` | `aihub testplan points` | build |
| Set the outcome of a point | testplan_set_outcome | PATCH `TestPoint` | `aihub testplan outcome --dry-run` | build |
| Test runs and results (failed first) of a build | test_publish_results (write side) | `test/runs`, `results` | `aihub testplan runs|results` | build |
| Publish results (Robot, JUnit) | test_publish_results, robot_post_results | `test/runs` (POST) | `aihub robot` | exists |
| Create plans, suites and cases | - | POST `testplan/...` | `aihub testplan create-plan|create-suite|create-case` | build |
| Test configurations, test variables | - | `testplan/configurations` | - | out: configuration is portal work |

## Artifacts (feeds)
| Capability | Old Hub | REST (`feeds.dev.azure.com`) | `aihub` command | Status |
|---|---|---|---|---|
| Feeds (project and organisation) | - | `packaging/feeds` | `aihub artifacts feeds` | build |
| Packages of a feed (filter, type) | - | `feeds/{feed}/packages` | `aihub artifacts packages` | build |
| Versions of a package | - | `packages/{id}/versions` | `aihub artifacts versions` | build |
| Publish, promote, delete a package version | - | views, `pkgs.dev.azure.com` | - | out: publishing is part of the pipeline that builds the package, promotion is a release decision |
| Feed permissions and retention | - | `packaging/feeds/{id}/permissions` | `aihub devops permissions` (read) | build |

## Search, dashboards, notifications, security (read only)
| Capability | Old Hub | REST | `aihub` command | Status |
|---|---|---|---|---|
| Code search | ado_code_search | `almsearch ... codesearchresults` | `aihub search code` | build |
| Wiki search | - | `almsearch ... wikisearchresults` | `aihub search wiki` | build |
| Work item search | workitem_search | `almsearch ... workitemsearchresults` | `aihub search items` | build |
| Dashboards: list and widgets (read) | - | `dashboard/dashboards` | `aihub devops dashboards` | build |
| Notification subscriptions (mine, team) | - | `notification/subscriptions` | `aihub devops subscriptions` | build |
| Security namespaces and permissions of a user or group on a repo, branch or pipeline | - | `securitynamespaces`, `accesscontrolentries`, `permissionsreport` | `aihub devops permissions` | build |
| Projects and teams of the organisation | - | `projects`, `teams` | `aihub devops projects|teams` | build |
| Agent pools and queues (read) | - | `distributedtask/pools` | `aihub devops pools` | build |
| Change dashboards, subscriptions or permissions | - | PUT/POST | - | out: access and notification changes are administrator work, never an agent write |
| Service hooks, extensions, billing, audit log | - | `hooks`, `extensionmanagement`, `auditservice` | - | out: organisation administration |

## Cross-cutting tools of the old Hub that are not Azure DevOps REST
Hub-internal and removed with the Hub, listed so no tool is unaccounted for: context packs (`context_*`, 14 tools), approvals gate (`approval_*`, `plan_approve`, `hook_*`, `contract_*`), chat and workflow state (`chat_*`, `workflow_*`, `autopilot_*`), settings and templates (`settings_*`, `template_*`, `prompt_skill_*`; now `team.yaml`), notes (`notes_*`; `aihub note`), learning (`learn_*`), failure memory and quality (`failure_memory_*`, `quality_*`, `editor_problems_*`), knowledge and IaC lookups (`knowledge_*`, `iac_*`, `docs_*`), repository scope and mapping (`repository_*`, `repo_set_switch`, `azure_target_set`; now team.yaml `repositories`), cross-repo impact (`crossrepo_*`; `aihub crossrepo`), Robot (`robot_*`; `aihub robot`), local git (`git_*`: the agent uses its own git), release train (`release_*`; `aihub release`), worktrees (`story_worktrees`, `story_add_repository`; `aihub worktree`).

## Counts

| Area | Rows | Old Hub had | exists | build | out |
|---|---|---|---|---|---|
| Repos: branches, tags, files, commits, forks | 21 | 14 | 3 | 15 | 3 |
| Pull requests | 20 | 17 | 9 | 10 | 1 |
| Policies (branch policies) | 13 | 2 | 1 | 12 | 0 |
| Pipelines (Build and YAML) | 24 | 20 | 6 | 16 | 2 |
| Library: variable groups (Key Vault-linked included) | 8 | 3 | 0 | 8 | 0 |
| Boards: work items, queries, iterations | 24 | 16 | 6 | 16 | 2 |
| Wiki | 10 | 5 | 1 | 9 | 0 |
| Test Plans | 7 | 4 | 1 | 5 | 1 |
| Artifacts (feeds) | 5 | 0 | 0 | 4 | 1 |
| Search, dashboards, notifications, security (read only) | 10 | 2 | 0 | 8 | 2 |
| **Total** | **142** | **83** | **27** | **103** | **12** |

Every `build` row is delivered in this round (see the pull request list in the release notes of the aihub version that ships it); every `out` row has its reason in the table. Rows marked `exists` are covered by a command of 1.0.x. The counts are generated from the tables by a small script, so they follow the rows.

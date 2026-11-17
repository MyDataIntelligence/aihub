# Parity with the legacy AI Context Hub

Every workflow of the legacy Hub and where it lives now. A workflow is a skill (when and how) plus an `aihub` command (the precise work). "Separate change" means a command or skill delivered by a parallel change (stories and pull request flows, install, Fabric and Robot); the name is the target, not a gap.

| Legacy workflow | Skill | `aihub` command | Status |
|---|---|---|---|
| start-here (routing) | `start-here` | slash commands `/start /finish /review-pr /explain /release /wiki` plus the older ones | done |
| story-start | `story-start` | `aihub story start --id N [--repos a,b] [--base B]` | done |
| link-story-branch | `story-start` | `aihub story link --id N` | done |
| worktrees, worktree sets (multi-repo) | `worktrees` | `aihub worktree create\|list\|remove --story N` | done |
| implement | `implement` | none (agent writes code and tests) | done |
| create-pr | `pr-create`, `pr-update` | `aihub pr create\|update` | done |
| pr-comments (process review comments) | `review-process` | `aihub comments get\|reply` | done |
| release-cherry-pick (one PR to other branches) | `branch-sync` | `aihub cherry-pick` | done (separate change) |
| release train (stories to main and staging) | `release` | `aihub release plan\|run`, `aihub batch` | done |
| fix-pipeline | `pipeline-fix` | `aihub pipeline follow\|status` | done (separate change) |
| pipeline run or queue | `pipeline-fix`, `story-run` | `aihub pipeline run --name P` | done (separate change) |
| change-template | `team-settings` | edit `team.yaml` or a template through a PR, `aihub doctor` | done |
| settings | `team-settings` | `team.yaml`, `aihub init`, `aihub doctor` | done |
| story-finish | `story-finish` | `aihub story finish --id N` | done |
| story-run (end-to-end autopilot) | `story-run` | chains the commands above | done |
| robot-tests (run, write a test for a new flow) | `test-run` | `aihub robot` | done (separate change) |
| fabric-items | `test-run` | `aihub fabric` | done (separate change) |
| wiki | `wiki` | `aihub wiki update --page P --body-file F [--publish]` | done |
| voice-notes | `voice-notes` | `aihub story create`, `aihub story refine` | done |
| evidence (screenshots in the PR) | `evidence` | `aihub evidence add --pr N --file img.png` | done |
| diagnose | `start-here` (If it fails) | `aihub doctor` | done |
| subagents | host feature | the agent's own subagents, no pack part | dropped: no Hub-managed agents needed |
| review someone else's PR, post review comments | `pr-review` | `aihub review show --pr N`, `aihub review post --pr N --comments-file F` | done |
| explain a PR | `pr-explain` | `aihub pr explain --pr N` | done |
| work item state | `story-finish` | `aihub workitem state --id N --to S` | done |
| PR auto-complete | `story-finish` | `aihub pr complete --pr N [--auto] [--delete-source] [--squash]` | done |
| refine and create stories | `story-create`, `story-refine` | `aihub story create\|refine\|show` | done (separate change) |
| background watch with notification ("laat het me weten") | `pr-watch` | `aihub watch --pr N\|--branch B [--until done\|comment\|vote] [--notify]`, `watch list\|stop` | done |
| back to the session from a watch notification (even when the session was closed) | `pr-watch` | `aihub open --event ID\|--last\|--url aihub://open?event=ID [--print]`; `aihub watch --client C --session S`; the toast's Open button uses a per-user `aihub://` link (HKCU, no admin) | done (Windows button; macOS and Linux print the command) |
| branch notes woven into the PR description | `pr-create` | `aihub note add "text"\|--file F`, `note list`; `pr create\|update` weave them (`--no-notes` skips) | done |
| story state and resume ("Vorige keer ... Volgende stap ...") | `start-here`, `story-run` | `aihub status [--json]` | done |
| story context for implementing (files, linked PRs and branches) | `implement` | `aihub story context --id N [--repos a,b] [--top 15]` | done |
| bug and task work items | `story-create` | `aihub workitem create --type Bug\|Task --title T --body-file F [--parent N]` (templates: `workItems.templates`) | done |
| PR policy evaluations and requeue | `story-finish`, `pipeline-fix` | `aihub pr checks --pr N`, `aihub pr requeue --pr N [--policy build]` | done |
| retry a failed pipeline stage | `pipeline-fix` | `aihub pipeline retry --run ID [--stage S]` | done |
| devops-repos (list and clone the project's repositories) | `devops-repos` | `aihub repos list [--filter t]`, `repos clone --name a,b` | done |
| terraform (find and explain, never apply) | `terraform` | none: own tools, plans only through `aihub pipeline run` after the user's yes | done (skill only) |

## Legacy generated skills (decisions)

| Legacy skill | Decision |
|---|---|
| `setup` | covered by `aihub init`, `aihub doctor` and `aihub update` (install track) |
| `devops-repos` | `devops-repos` skill plus `aihub repos list\|clone`; searching and reading stay with the agent's own tools |
| `terraform` | `terraform` skill only; the legacy inventory tool had no real workflow beyond grep, and `terraform plan\|apply` is never run by the agent |
| `cross-repo-test` | `aihub crossrepo` and `aihub port` (cross-repo track) |
| `tool-index` | not needed: there are no tools to index; `aihub --help` lists the commands and `start-here` routes intents |

## Dropped on purpose

| Legacy part | Why it is gone |
|---|---|
| MCP server and Hub API | the CLI is called directly; no daemon, no MCP |
| Approvals and YOLO mode, hooks | Azure DevOps branch policies and required reviewers are the guard; `aihub pr complete` never bypasses policies |
| VS Code bar and PyCharm plugin UI | the agent (opencode, GitHub Copilot, Codex) is the interface |
| Microsoft Copilot route (hub-actions JSON) | not part of this product |

## Safety rules that replace the approvals

- `story finish` and `worktree remove` never remove uncommitted or unpushed work, never use force, and keep a branch whose pull request is not completed.
- `release run` never force-pushes, refuses an existing branch name, and works in a scratch worktree so the working tree stays untouched.
- `review post`, `wiki update` and `pr complete` change shared content only on an explicit command; the skills ask once before posting a review or publishing a page, and `wiki update` shows a diff first.

## Not verified against a real organisation

All commands are tested with synthetic fixtures and temporary git repositories only. These endpoints have no live proof yet: work item links to branches and pull requests, attachment upload, wiki page update with its version header, pipeline run parameters, policy evaluation endpoints (`policy/evaluations`, preview 7.1) and stage retry (`build/builds/{id}/stages/{stage}`, preview 7.1), the OS notification, its Open button, the `aihub://` link registration, the resume commands of each client and the detached start of `aihub watch`, auto-complete user lookup, and the REST shape of review threads. Check each once against a test project before the first release.

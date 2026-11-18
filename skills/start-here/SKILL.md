---
name: start-here
description: "Use when the user starts an Azure DevOps team task and it is unclear which workflow applies, or sends a dev.azure.com link, a slash command, or says 'where do I start', 'waar begin ik', 'wat kan aihub', 'help met mijn story/PR'."
---
# Start here

## When
Any Azure DevOps team request. Route it at once; do not explain the pack.

## Steps
A direct command needs no routing: "maak een PR" -> run `aihub pr create --summary-text "..."`; "voeg onder <sectie> toe" with a PR link -> `aihub pr update --pr <url> --section "<heading>" --append-text "..."`. No exploring first. Otherwise map the intent:

| Intent or input | Skill |
|---|---|
| new story, bug or task | story-create |
| refine, "verfijn" | story-refine |
| "implementeer", "werk uit" | implement |
| "maak een PR", "create PR" | pr-create |
| "update de PR" | pr-update |
| PR link, "watch", "volg de build" | pr-watch |
| "verwerk de comments" | review-process |
| cherry-pick, "update branch" | branch-sync |
| failing pipeline, "build is rood" | pipeline-fix |
| write or check pipeline YAML | pipeline-author |
| "start story 123" | story-start |
| "rond af", clean up, complete the PR | story-finish |
| worktree set, several repos | worktrees |
| "run story 123" | story-run |
| review someone else's PR | pr-review |
| "leg de PR uit", explain a PR | pr-explain |
| wiki, other repo, Terraform | wiki, devops-repos, terraform |
| policies, groups, boards, search | devops-admin |
| screenshot, voice notes | evidence, voice-notes |
| change team.yaml or a template | team-settings |
| release, release train | release |

Resumed session: run `aihub status`.

Example: a pullrequest link means pr-watch with that id.

## What the CLI fills
Templates, target branch, story links and repository come from `team.yaml` (`aihub doctor` checks it); never ask the user for them. Read the `guidelines:` files first.

## If it fails
Run `aihub doctor` and show its output. No `team.yaml`: the user runs `aihub init` in the team repo.

Rules: a direct command ("maak een PR") runs at once, 0 questions. Local git uses your own tools. Content follows the team template language. Never invent work item ids or links.

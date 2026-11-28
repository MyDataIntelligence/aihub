---
name: start-here
description: "Use when the user starts an Azure DevOps team task and it is unclear which workflow applies, or sends a dev.azure.com link, a slash command, or says 'where do I start', 'waar begin ik', 'wat kan aihub', 'help met mijn story/PR'."
---
# Start here

## When
Any Azure DevOps team request. Route it at once.

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
| "draai de CD lokaal" | preflight |
| "start story 123" | story-start |
| "rond af", clean up, complete the PR | story-finish |
| worktree set, "repo X on branch Y" | worktrees |
| "run story 123" | story-run |
| review someone else's PR | pr-review |
| "leg de PR uit" | pr-explain, learn |
| "kan dit?" | feasibility |
| not cloned, several repos | remote-repos |
| wiki, other repo, Terraform | wiki, devops-repos, terraform |
| policies, groups, PR admin | devops-admin |
| screenshot, voice notes | evidence, voice-notes |
| team.yaml, a template | team-settings |
| release, release train | release |
| "ga verder", "waar was ik", new chat | resume |

New chat: `aihub status`.

## What the CLI fills
The CLI applies `team.yaml` (templates, target, links); never read it or ask for these. On `missing team setting`: ask that one question, run its `aihub team set`, repeat. Read the `guidelines:` files first.

## If it fails
Show `aihub doctor`. No `team.yaml`: `aihub team setup`.

Rules: a direct command runs at once, 0 questions. Unreadable skill: `aihub <command> --help`. No closing question. Local git: your own tools. Content in the team language. Never invent ids.

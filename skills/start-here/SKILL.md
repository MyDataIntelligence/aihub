---
name: start-here
description: "Use when the user starts an Azure DevOps team task and it is unclear which workflow applies, or sends a dev.azure.com link, a slash command, or says 'where do I start', 'waar begin ik', 'wat kan aihub', 'help met mijn story/PR'."
---
# Start here

## When
Any Azure DevOps team request. Route it at once; do not explain the pack.

## Steps
Map the intent to a skill, then follow that skill:

| Intent or input | Skill |
|---|---|
| new story | story-create |
| refine, "verfijn" | story-refine |
| "implementeer", "werk uit" | implement |
| "maak een PR", "create PR" | pr-create |
| "update de PR" | pr-update |
| PR link, "watch", "volg de build" | pr-watch |
| "verwerk de comments" | review-process |
| cherry-pick, "update branch" | branch-sync |
| failing pipeline, "build is rood" | pipeline-fix |
| "start story 123" | story-start |
| "rond af", clean up, complete the PR | story-finish |
| worktree set, several repos | worktrees |
| "run story 123" | story-run |
| review someone else's PR | pr-review |
| "leg de PR uit", explain a PR | pr-explain |
| wiki page | wiki |
| screenshot in a PR | evidence |
| transcript, voice notes | voice-notes |
| change team.yaml or a template | team-settings |
| release, release train | release |

Resumed session ("ga verder", "continue"): run `aihub status`, open with "Last time ... Next step ..." in the user's language.

Slash commands `/pr /pr-update /cherry-pick /story /refine /review /watch /start /finish /review-pr /explain /release /wiki` map to the same skills.

Example: the user sends a pullrequest link, so follow pr-watch with that id.

## What the CLI fills
Templates, target branch, story links and repository come from `team.yaml` (see the [team schema](../_shared/references/team.schema.yaml)). Never ask the user for them.

## If it fails
Run `aihub doctor` and show its output. If `team.yaml` is missing, tell the user to run `aihub init` in the team repo.

Rules: a direct command ("maak een PR") is executed at once with 0 questions. Local git (status, diff, commit, push of the own branch) uses your own tools. Write content in the language of the team template. Never invent work item ids or links.

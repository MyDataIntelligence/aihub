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
| new story, "maak een story" | story-create |
| refine, "verfijn", story id without code | story-refine |
| build a story, "implementeer", "werk uit" | implement |
| "maak een PR", "create PR" | pr-create |
| "update de PR", new commits on open PR | pr-update |
| PR link `.../pullrequest/<id>`, "watch", "volg de build" | pr-watch |
| review comments, "verwerk de comments" | review-process |
| cherry-pick, "update branch", merge target | branch-sync |
| failing pipeline, "build is rood" | pipeline-fix |
| release, "maak een release", several repos | release |

Slash commands `/pr /pr-update /cherry-pick /story /refine /review /watch` map to the same skills.

Example: the user sends a pullrequest link, so follow pr-watch with that id.

## What the CLI fills
Templates, target branch, story links and repository come from `team.yaml` (see the [team schema](../_shared/references/team.schema.yaml)). Never ask the user for them.

## If it fails
Run `aihub doctor` and show its output. If `team.yaml` is missing, tell the user to run `aihub init` in the team repo.

Rules: a direct command ("maak een PR") is executed at once with 0 questions. Local git (status, diff, commit, push of the own branch) uses your own tools. Write content in the language of the team template. Never invent work item ids or links.

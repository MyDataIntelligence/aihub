---
description: Works for the team through the aihub skills (stories, pull requests, pipelines, Fabric)
mode: primary
permissions:
  - action: shell
    resource: "*"
    effect: ask
  - action: shell
    resource: "aihub *"
    effect: allow
  - action: shell
    resource: "git *"
    effect: allow
  - action: shell
    resource: "az repos *"
    effect: allow
  - action: shell
    resource: "az boards *"
    effect: allow
  - action: shell
    resource: "az pipelines *"
    effect: allow
  - action: shell
    resource: "git push *--force*"
    effect: ask
  - action: shell
    resource: "git push -f*"
    effect: ask
  - action: shell
    resource: "git push * -f*"
    effect: ask
  - action: shell
    resource: "rm -rf*"
    effect: ask
  - action: read
    resource: "*"
    effect: allow
  - action: glob
    resource: "*"
    effect: allow
  - action: grep
    resource: "*"
    effect: allow
  - action: skill
    resource: "*"
    effect: allow
---
You work for this team through the aihub skills. The skills are the source of truth; do not restate or improvise their steps.

- For Azure DevOps, pull request, story, pipeline, review or Fabric work, load the matching skill (`start-here` when unsure) and run its one `aihub` command.
- Ask nothing that a skill, `team.yaml` or `aihub status` already answers. Ask only when two readings lead to different actions.
- Content you write (stories, pull requests, comments) follows the team template and its language; pass prose to the CLI as a file (`--body-file`), never inline.
- Use `git` and `az` directly only when no skill covers the job.
- Never force-push, and change nothing in Azure DevOps outside the story or pull request you were given.
- Hand long jobs (story-run, pipeline-fix, pr-watch, review-process) to the `aihub-runner` agent (`aihub_runner` in Codex) and relay its short report.

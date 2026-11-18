---
description: Works for the team through the aihub skills (stories, pull requests, pipelines, Fabric)
mode: primary
permissions:
  - action: shell
    resource: "*"
    effect: allow
  - action: shell
    resource: "git reset --hard*"
    effect: ask
  - action: shell
    resource: "git push *--force*"
    effect: deny
  - action: shell
    resource: "git push -f*"
    effect: deny
  - action: shell
    resource: "git push * -f*"
    effect: deny
  - action: shell
    resource: "git push * main"
    effect: deny
  - action: shell
    resource: "git push * main *"
    effect: deny
  - action: shell
    resource: "git push * *:main"
    effect: deny
  - action: shell
    resource: "git push * master"
    effect: deny
  - action: shell
    resource: "git push * master *"
    effect: deny
  - action: shell
    resource: "git push * *:master"
    effect: deny
  - action: shell
    resource: "git push * staging"
    effect: deny
  - action: shell
    resource: "git push * staging *"
    effect: deny
  - action: shell
    resource: "git push * *:staging"
    effect: deny
  - action: shell
    resource: "git push * release/*"
    effect: deny
  - action: shell
    resource: "git push * *:release/*"
    effect: deny
  - action: shell
    resource: "rm -rf /*"
    effect: deny
  - action: shell
    resource: "rm -rf ~*"
    effect: deny
  - action: shell
    resource: "az * delete*"
    effect: deny
  - action: shell
    resource: "az repos pr update*"
    effect: allow
  - action: shell
    resource: "curl *| sh*"
    effect: deny
  - action: shell
    resource: "curl *|sh*"
    effect: deny
  - action: shell
    resource: "curl *| bash*"
    effect: deny
  - action: shell
    resource: "wget *| sh*"
    effect: deny
  - action: read
    resource: "*"
    effect: allow
  - action: edit
    resource: "*"
    effect: allow
  - action: webfetch
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
- Never use the old `hub` CLI or `hub call` (the old AI Context Hub). If its skills or rules are present, tell the user to run `aihub legacy remove`.

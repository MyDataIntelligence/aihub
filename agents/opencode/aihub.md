---
description: Works for the team through the aihub skills (stories, pull requests, pipelines, Fabric)
mode: primary
permission:
  edit: allow
  read: allow
  webfetch: allow
  bash:
    "*": allow
    "git reset --hard*": ask
    "git push *--force*": deny
    "git push -f*": deny
    "git push * -f*": deny
    "git push * main": deny
    "git push * main *": deny
    "git push * *:main": deny
    "git push * master": deny
    "git push * master *": deny
    "git push * *:master": deny
    "git push * staging": deny
    "git push * staging *": deny
    "git push * *:staging": deny
    "git push * release/*": deny
    "git push * *:release/*": deny
    "rm -rf /*": deny
    "rm -rf ~*": deny
    "az * delete*": deny
    "az repos pr update*": allow
    "curl *| sh*": deny
    "curl *|sh*": deny
    "curl *| bash*": deny
    "wget *| sh*": deny
---
You work for this team through the aihub skills. The skills are the source of truth; do not restate or improvise their steps.

- For Azure DevOps, pull request, story, pipeline, review or Fabric work, load the matching skill (`start-here` when unsure) and run its one `aihub` command.
- Ask nothing that a skill, `team.yaml` or `aihub status` already answers. Ask only when two readings lead to different actions.
- Content you write (stories, pull requests, comments) follows the team template and its language; pass prose to the CLI as a file (`--body-file`), never inline.
- Use `git` and `az` directly only when no skill covers the job.
- Never force-push, and change nothing in Azure DevOps outside the story or pull request you were given.
- Hand long jobs (story-run, pipeline-fix, pr-watch, review-process) to the `aihub-runner` agent (`aihub_runner` in Codex) and relay its short report.
- Never use the old `hub` CLI or `hub call` (the old AI Context Hub). If its skills or rules are present, tell the user to run `aihub legacy remove`.

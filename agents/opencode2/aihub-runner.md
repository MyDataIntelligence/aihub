---
description: Runs one long aihub job (story-run, pipeline-fix, pr-watch, review-process) and reports in five lines
mode: subagent
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
You run one long aihub job to the end and report. Jobs: story-run, pipeline-fix, pr-watch, review-process.

1. Load the matching skill and follow it exactly; its one `aihub` command does the work.
2. Go through the retries and waits the skill describes. Ask the caller nothing that a skill or `team.yaml` answers.
3. Stop and report at once when a skill says to ask, when a command stops with `missing team setting` (report its question and `aihub team set` line), or when the same step failed twice.
4. Run tests only through `aihub test changed --run`; never start `pytest` or another test runner yourself.
5. Report in at most 5 lines: what was done, the links (pull request, pipeline run), the result, and what is left for the user.
6. Never use the old `hub` CLI or `hub call` (the old AI Context Hub). If its skills or rules are present, tell the user to run `aihub legacy remove`.

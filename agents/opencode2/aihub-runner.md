---
description: Runs one long aihub job (story-run, pipeline-fix, pr-watch, review-process) and reports in five lines
mode: subagent
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
You run one long aihub job to the end and report. Jobs: story-run, pipeline-fix, pr-watch, review-process.

1. Load the matching skill and follow it exactly; its one `aihub` command does the work.
2. Go through the retries and waits the skill describes. Ask the caller nothing that a skill or `team.yaml` answers.
3. Stop and report at once when a skill says to ask, or when the same step failed twice.
4. Run tests only through `aihub test changed --run`; never start `pytest` or another test runner yourself.
5. Report in at most 5 lines: what was done, the links (pull request, pipeline run), the result, and what is left for the user.

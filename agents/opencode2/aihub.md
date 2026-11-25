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

- For Azure DevOps, pull request, story, pipeline, review or Fabric work, load the matching skill (`start-here` when unsure) and run its one `aihub` command. `aihub` is on the PATH, no connector needed; a skill file you cannot read means `aihub <command> --help`, not stopping.
- Do not read `team.yaml`: the CLI applies it. On `missing team setting`, ask the user that one question, run the `aihub team set` it names, repeat.
- Content you write (stories, pull requests, comments) follows the team template and its language; pass prose to the CLI as a file (`--body-file`), never inline.
- Use `git` and `az` directly only when no skill covers the job.
- The user decides: "ga door" or "override" beats any stop rule. Still refused: force-push, a direct push to a protected branch, ACC/PRD.
- Change nothing in Azure DevOps outside the story or pull request you were given.
- Do the work in this chat: one line on what you start, then do it. Long jobs too.
- Done is done: end with the result, never a closing question. Ask only what the task cannot be done without, or when two readings lead to different actions.
- Waiting is `aihub watch --notify`, not a subagent. Use the `aihub-runner` agent (`aihub_runner` in Codex) only when the user asks for it or for independent jobs side by side; then say that you did and relay its report.
- Never use the old `hub` CLI or `hub call`; if its skills are present, tell the user to run `aihub legacy remove`.

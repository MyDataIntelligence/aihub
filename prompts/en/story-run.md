---
title: Run End to End
slash: /story-run
goal: A green pull request to {{target}} with every acceptance criterion proven.
reads: The story, the criteria with how tested and proof, the set and team.yaml.
produces: A plan, commits, a test per criterion, a PR with the criteria table, an honest report.
---
# Goal
Finish {{story.type}} #{{story.id}} {{story.title}} by the definition of done below and deliver a green pull request
to {{target}}. Work on your own, report honestly and stop at the stop rules.

## Context
- Story: #{{story.id}} {{story.title}} ({{story.state}}, {{story.iteration}}) in {{story.project}}, assigned to {{story.assignedTo}}.
- Link: {{story.url}}
- Feature branch: {{branch}}. Target branch: {{target}}.
- Repos: {{repos}}
- Fabric workspace of the feature: {{workspace}}. Run only there.
- Acceptance criteria from Azure DevOps, each with how tested and proof:
{{criteria}}
- Tasks: {{tasks}}

## Definition of done
Done is done only when everything below is true. If something is not true, say so; do not make it look better.
1. Acceptance criteria: every criterion is testable and has How tested and Proof.
   - A vague criterion ("fast", "good")? Sharpen it first and show it to me. Do not build on.
   - How tested or Proof missing, or no criteria: propose them with /story-criteria {{story.id}} and wait for my OK.
2. A test per criterion: a unit or integration test{{#if fabric}}, a Fabric run in {{workspace}}{{/if}}, or a data check with a query and the
   expected outcome. No criterion without a test.{{#if fabric}} Test on Fabric only in {{workspace}}.{{/if}}{{#if noFabric}} Run nothing on Fabric.{{/if}}
3. Run only the targeted tests (the files and models you touch), never the whole suite: `aihub test changed --run`.
4. Commit with aihub, small, with the story number in the message: `aihub commit --type <type> --subject "<what>" --push`.
5. Record the outcome per criterion: `aihub criteria record --id {{story.id}} --criterion <n> --result pass|fail --evidence <link> --reason "<why>"`.
   A criterion that did not run stays "not run yet". Never invent an outcome.
6. A pull request to {{target}} by the team template, in {{language}}, without technical noise: `aihub pr create`.
   aihub writes the section Acceptance criteria from the criteria and their status. Not all proven: create it only as a
   draft (`--draft`) and say what is missing.
7. The PR's pipeline is green. Follow it with `aihub watch --pr <n> --notify`; red: read the log, fix, push, again.
8. Review threads are handled: answer every thread or change the code, and resolve it.
9. Report: PR link, pipeline, criteria (x of {{criteria.count}} proven), what did not run and why.

{{#if planFirst}}
## Plan first
Show a plan first: steps per repo, the criteria per step and the tests. Wait for my OK.
If the work later differs from the plan, say so before you go on.
{{/if}}
{{#if setActive}}
## State of the story
The story is Active and assigned to me. When every criterion is proven and the PR's pipeline is green, set it to
Resolved: `aihub workitem state --id {{story.id}} --to Resolved`. Otherwise leave the state.
{{/if}}

## Progress
Report every step with `aihub story progress --id {{story.id}} --step <k> --total <n> --label "<step>"` (steps: plan, build,
targeted tests, Fabric test per criterion, pull request, pipeline, review threads, report). At the end: `--done`.

## Stop rules
- The same error three rounds in a row: stop, show the error and the state, ask how to go on.
- A sign-in problem (`aihub doctor`) or a conflict you cannot resolve safely: stop and show the exact error.
- In doubt about what the story asks: ask, do not guess.

## Limits
{{limits}}

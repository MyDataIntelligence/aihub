---
name: story-run
description: "Use when the user wants a story done end to end without questions: 'run story 123', 'pak story 123 helemaal op', 'maak het af tot een groene PR', 'story-run'."
---
# Story run

## When
The story exists and the user wants a finished, green pull request. Ask nothing except a genuinely ambiguous choice (two plausible repositories, a contradiction in the story).

## Steps
Resuming a run? Run `aihub status` first: it shows the story, PR, pipeline, open threads and the next step; continue from there instead of starting over.

Chain these skills, each at once, and carry the ids forward:
1. story-start: `aihub story start --id 123` (add `--repos` when the story names several repositories).
2. implement: code and tests for the story; run only the changed tests (`aihub test changed --run`), never the whole suite; commit and push with `aihub commit --type <type> --subject "<what changed>" --push`, never plain `git commit`.
3. pr-create, then pr-watch: `aihub pr create`, `aihub pipeline follow`.
4. Red pipeline: pipeline-fix, push, watch again. Stop after 3 red fix rounds and report the failing step.
5. Open threads: review-process, then watch again.
6. Green and no open threads: report the PR link, the story state and what was not done. Do not complete the PR; that is story-finish and the user's call.

Example: "run story 123" is story-start, implement, `aihub pr create`, `aihub pipeline follow`, and a one-line result.

## What the CLI fills
Branch, base, links, PR template, target, pipeline state, thread context. Do not ask the user for any of it.

## If it fails
After 3 red rounds, a sign-in problem (`aihub doctor`) or a conflict you cannot resolve safely: stop, show the exact error and the state reached. Never invent ids, links or test results.

Rules: no questions, no destructive git, no merging, no pipeline changes. Report in at most 5 lines.

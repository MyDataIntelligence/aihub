---
name: story-run
description: "Use when the user wants a story done end to end without questions: 'run story 123', 'pak story 123 helemaal op', 'maak het af tot een groene PR', 'story-run'."
---
# Story run

## When
The story exists and the user wants a finished, green pull request. Ask nothing except a genuinely ambiguous choice (two plausible repositories, a contradiction in the story).

## Steps
Resuming, new chat or compaction? `aihub status` once (it includes the last step on this branch); continue from there. Only the story id: `aihub story recall --id N`.

Chain these skills at once, carrying the ids forward:
1. story-start: `aihub story start --id 123` (add `--repos` when the story names several repositories).
2. implement: code and tests for the story; run only the changed tests (`aihub test changed --run`), never the whole suite; commit with `aihub commit --type <type> --subject "<what>" --push`, never plain git.
3. pr-create, then pr-watch in the background: `aihub pr create`, `aihub watch --pr <n> --notify`. Say "ik volg het op de achtergrond"; `pipeline follow` only when asked to wait.
4. Red pipeline: pipeline-fix, push, watch again. Stop after 3 red fix rounds and report the failing step.
5. Open threads: review-process, then watch again.
6. Green and no open threads: report the PR link, the story state and what was not done. Do not complete the PR; that is story-finish and the user's call.

Example: "run story 123": story-start, implement, `aihub pr create`, `aihub watch --pr <n> --notify`, one-line result.

## What the CLI fills
Branch, base, links, PR template, target, pipeline state, thread context. Do not ask the user for any of it.

## If it fails
After 3 red rounds, a sign-in problem (`aihub doctor`) or a conflict you cannot resolve safely: stop, show the exact error and the state reached. Never invent ids, links or test results.

In a worktree set (`Set:` in `aihub status`) add `--all-repos` to `aihub commit`, `pr create`, `pipeline follow` and `status`: one table, unchanged repositories skipped.

Rules: no questions, no destructive git, no merging, no pipeline changes. Report in at most 5 lines.

---
name: resume
description: "Use when the user asks where they left off or continues earlier work: 'waar was ik', 'wat was de vorige keer', 'ga verder', 'continue', a new chat, or after a compaction; also 'welke story was dat', 'zoek de story over ...'."
---
# Resume earlier work

## When
The conversation starts without context, was compacted, or the user wants to pick up a story: where was I, what is done, what is next.

## Steps
1. In the repository or worktree: `aihub status --resume`. It is local and instant (no network) and prints `Last time: ... · Plan done: ...; left: ... · Next step: ...`, the latest private note and the worktree set.
2. Live state when it matters: `aihub status` (story, PR, pipeline, open threads); in a worktree set `aihub status --all-repos`.
3. Only the story id is known: `aihub story recall --id 123` (story, PRs per repository, pipeline, the latest journal lines of this machine, open ends).
4. Only words are known: `aihub story search "<words>"`, then recall the one that fits.

Then continue with the printed next step (usually story-run, pr-watch or review-process). Park a decision for later with `aihub note add "<why>"`: it shows up in the next resume.

Example: new chat, "ga verder" -> `aihub status --resume`, then do its Next step.

## What the CLI fills
Every aihub action is logged as one line (time, branch, command, result, next step) in the local journal of the repository (`<git dir>/aihub/journal.md`, never committed); resume and recall read it. Do not read or edit the journal yourself.

## If it fails
Nothing recorded yet: run `aihub status` for the live state. Unknown story id: `aihub doctor`. Never invent what was done before.

Rules: 0 questions, one command first.

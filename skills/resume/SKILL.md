---
name: resume
description: "Use when the user asks where they left off or continues earlier work: 'waar was ik', 'waar was ik gebleven', 'wat was de vorige keer', 'ga verder', 'continue', a new chat, or after a compaction; also 'welke story was dat', 'zoek de story over ...'."
---
# Resume earlier work

## When
The conversation starts without context, was compacted, or the user wants to pick up a story: where was I, what is done, what is next.

## Steps
1. One call in the repository or worktree: `aihub status`. It prints the story, the PR, the pipeline of the PR, open threads, the working tree, `Last time:` (the last aihub step on THIS branch), the latest private note and `Next step:`. Do not also run `status --resume` or `pipeline status`, and do not read files or `team.yaml` first.
2. Answer in two or three lines: where the work stands and the next step. Then stop, or do the next step only when the user asked to continue ("ga verder").

Other cases:
- Offline or not signed in: `aihub status --resume` (local journal only, no network).
- A worktree set: `aihub status --all-repos`.
- Only the story id is known: `aihub story recall --id 123`.
- Only words are known: `aihub story search "<words>"`, then recall the one that fits.

Park a decision for later with `aihub note add "<why>"`: the next status shows it.

Example: new chat, "waar was ik?" is `aihub status`, then two lines. Nothing else.

## What the CLI fills
Every aihub action is logged as one line (time, branch, command, result, next step) in the local journal of the repository (`<git dir>/aihub/journal.md`, never committed). Status and resume read only the lines of the current branch. Do not read or edit the journal yourself.

## If it fails
Nothing recorded yet on this branch: the live state of `aihub status` is the answer. Unknown story id: `aihub doctor`. Never invent what was done before.

Rules: 0 questions, one command.

Done is done: end with the result and at most one statement about the next step, never with a question.

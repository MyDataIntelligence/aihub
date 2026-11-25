---
name: review-process
description: "Use when review comments on your own pull request must be handled: 'verwerk de comments', 'verwerk de review', 'process the review', 'reageer op de review', '/review', open threads on a pull request."
---
# Process review comments

## When
A PR has open reviewer threads. Everything you need comes from the commands below: no `aihub --help`, no `workitem` or `story` lookup, no `team.yaml` read (the CLI applies it).

## Steps
1. Read them: `aihub comments get` (add `--pr <url|N>` when the PR is not the branch's). It prints every open thread with its id, file, line and text.
2. Fix each valid point in code with your own tools. A question ("why 100?") with a clear answer in the comment itself: change the code as asked. Unclear: answer with the question and status `closed`, do not guess.
3. Commit and push in one call: `aihub commit --type fix --subject "<what>" --push`.
4. Answer ALL threads in ONE call. Every thread gets a reply and a status: `fixed` (done), `wontFix` (declined, say why), `closed` (answered).

```sh
aihub comments reply --reply "7:fixed:Aangepast: null-check toegevoegd." --reply "8:wontFix:Bewust zo: de API vereist het."
```

Format `<threadId>:<status>:<text>`; the text may contain colons. For long replies write `replies.yaml` (`threadId`, `text`, `status`) and use `--replies-file replies.yaml`.

5. Report in one line (what changed, threads answered) and stop.

Example: three threads are `aihub comments get`, the code edits, `aihub commit --type fix --subject "verwerk review" --push`, one `aihub comments reply` with three `--reply`: three aihub calls.

## What the CLI fills
PR id, thread lookup and the status change. Do not post replies one by one and never leave a thread `active` after you answered it.

## If it fails
Unknown thread id: rerun `aihub comments get`. Disagree with a comment: reply with the reason and `wontFix`. Never invent ids.

Done is done: end with the result and at most one statement about the next step, never with a question.

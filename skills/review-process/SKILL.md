---
name: review-process
description: "Use when review comments must be handled: 'verwerk de comments', 'process the review', 'reageer op de review', '/review', open threads on a pull request."
---
# Process review comments

## When
A PR has open reviewer threads.

## Steps
1. Read them: `aihub comments get` (add `--pr <url|N>` when the PR is not the branch's).
2. Fix each valid point in code with your own tools; commit with `aihub commit` and push (`--push`).
3. Answer ALL threads in ONE call: write the yaml and run the command in the same shell call. Every thread gets a reply and a status: `fixed` (done), `wontFix` (declined, say why), `closed` (answered).

```sh
cat > replies.yaml <<'EOY'
- threadId: 7
  text: "Aangepast: null-check toegevoegd."
  status: fixed
EOY
aihub comments reply --replies-file replies.yaml
```

Example: three threads give one `replies.yaml` with three entries and one command.

## What the CLI fills
PR id, thread lookup and the status change. Do not post replies one by one and never leave a thread `active` after you answered it.

## If it fails
Unknown thread id: rerun `aihub comments get`. Disagree with a comment: reply with the reason and `wontFix`. Never invent ids.

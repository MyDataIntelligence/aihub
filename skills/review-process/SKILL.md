---
name: review-process
description: "Use when review comments must be handled: 'verwerk de comments', 'process the review', 'reageer op de review', '/review', open threads on a pull request."
---
# Process review comments

## When
A PR has open reviewer threads.

## Steps
1. Read them: `aihub comments get`.
2. Fix each valid point in code with your own tools. Commit per the commit template and push the own branch with git.
3. Write one reply per thread into a file, in the team language, short and factual (what changed, or why not):

```yaml
- thread: 7
  text: "Aangepast: null-check toegevoegd."
  resolve: true
```

4. Send them in one call:

```sh
aihub comments reply --replies-file replies.yaml
```

Example: three threads give one `replies.yaml` with three entries and one command.

## What the CLI fills
PR id, thread lookup, author tags and status. Do not post replies one by one.

## If it fails
Unknown thread id: rerun `aihub comments get`. Disagree with a comment: say so in the reply, do not resolve. Never invent ids.

Rules: no questions for the direct command. Local git uses your own tools.

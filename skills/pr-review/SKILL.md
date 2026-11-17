---
name: pr-review
description: "Use when the user wants someone else's pull request reviewed: 'review PR 42', 'bekijk deze PR', a dev.azure.com pullrequest link plus 'review', '/review-pr'. Not for processing comments on your own PR (review-process)."
---
# Review a pull request

## When
The user asks for a review of a PR written by someone else.

## Steps
1. Read it: `aihub review show --pr 42`. It prints the description, the changed files with diffs and the existing threads.
2. Review the diff against the story and the team rules. Only concrete findings: bug, missing test, unclear name, risk. Skip style nits the pipeline checks.
3. Write the findings to a file and show them to the user as a short list. Ask once: "post these comments?"
4. After a yes:

```sh
aihub review post --pr 42 --comments-file review.yaml
```

```yaml
- file: src/search.py
  line: 12
  text: "This loop is quadratic for large inputs; use a set."
- text: "Please add a test for the empty result."
```

Example: "review 42" is `aihub review show --pr 42`, then the question, then `aihub review post`.

## What the CLI fills
Diffs, thread context, file paths and thread creation. A comment without `file` becomes a general thread.

## If it fails
Run `aihub doctor`. A huge PR is cut off: pass `--max-files` or review per file. Never post without the yes, never vote.

Rules: write comments in the team language, polite and specific. Do not change code.

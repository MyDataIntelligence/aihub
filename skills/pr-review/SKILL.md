---
name: pr-review
description: "Use when the user wants someone else's pull request reviewed: 'review PR 42', 'bekijk deze PR', a dev.azure.com pullrequest link plus 'review', '/review-pr', 'pre-review'. Not for processing comments on your own PR (review-process)."
---
# Pre-review a pull request

## When
The user asks for a review of a PR written by someone else. Nothing is posted until the user picks findings.

## Steps
1. Read it: `aihub review prepare --pr 42`. It prints the description, the changed files with numbered diff lines, the open threads and the file to write your findings to.
2. Review the diff against the story and the team rules. Only concrete findings: bug, missing test, unclear name, risk. Skip style nits the pipeline checks.
3. Write the findings to that file as a numbered YAML list (severity blocker, major, minor or nit; line = new-file line number from the diff):

```yaml
- n: 1
  severity: major
  file: src/search.py
  line: 12
  text: "This loop is quadratic for large inputs."
  suggestion: "Use a set."
- n: 2
  severity: minor
  text: "Please add a test for the empty result."
```

4. Show the numbered list (number, severity, file:line, text) and ask which to post.
5. Post only the chosen ones, each as a thread on its line:

```sh
aihub review post --pr 42 --pick 1,3
```

Without `--pick`, `aihub review post --pr 42` only lists the findings. A wrong number posts nothing.

## What the CLI fills
Diffs with line numbers, the findings path, thread creation on the right file and line, `[severity]` prefix and the suggestion in the comment text.

## If it fails
Run `aihub doctor`. A huge PR is cut off: pass `--max-files`, or review per file. Never post without a pick, never vote.

Rules: write comments in the team language, polite and specific. Do not change code.

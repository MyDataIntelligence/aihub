---
name: pr-review
description: "Use when the user wants someone else's pull request reviewed: 'review PR 42', 'bekijk deze PR', 'beoordeel PR 42', a dev.azure.com pullrequest link plus 'review', '/review-pr', 'pre-review'. Not for processing comments on your own PR (review-process)."
---
# Pre-review a pull request

## When
The user asks for a review of a PR written by someone else. Do not read `team.yaml` or the PR template: the CLI applies them.

## Steps
1. Read it: `aihub review prepare --pr 42`. It prints the description, the changed files with numbered diff lines, the open threads and the findings file (its folder exists). That is all the context you need: no `rg` or file reads unless a line is unclear.
2. Only concrete findings: bug, missing test, unclear name, risk. Skip style nits the pipeline checks.
3. Write the findings to that file as a numbered YAML list (severity blocker, major, minor or nit; line = new-file line number from the diff):

```yaml
- n: 1
  severity: major
  file: src/search.py
  line: 12
  text: "This loop skips the first item."
  suggestion: "Start at index 0."
```

4. Post:
   - The user said "zet ze er direct op", "post them" or similar: post all at once, no question, with `--pick all`.
   - Otherwise show the numbered list (number, severity, file:line, text), ask which to post, then post the chosen ones.

```sh
aihub review post --pr 42 --pick all
aihub review post --pr 42 --pick 1,3
```

5. Report the threads created in one line and stop.

Example: "review PR 42 en zet je bevindingen er direct op" is `aihub review prepare --pr 42`, write the file, `aihub review post --pr 42 --pick all`: two calls.

## What the CLI fills
Diffs with line numbers, the findings path, threads on the right file and line, the `[severity]` prefix and the suggestion. Without `--pick` it only lists; a wrong number posts nothing.

## If it fails
Run `aihub doctor`. A huge PR is cut off: pass `--max-files`, or review per file. Never vote.

Rules: write comments in the team language, polite and specific. Do not change code.

Done is done: end with the result and at most one statement about the next step, never with a question.

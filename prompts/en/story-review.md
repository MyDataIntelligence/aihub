---
title: Review Pull Request Comments
slash: /story-review
goal: Every review thread answered or handled.
reads: The open threads of the story's PR.
produces: Answers and fixes, threads resolved.
---
# Review Pull Request Comments
Handle the review threads of the pull request of story #{{story.id}} ({{branch}}).

## Do
1. `aihub comments get` shows the open threads with their context.
2. Per thread: change the code or explain why not. Commit with `aihub commit ... --push`.
3. Answer and close in one go: `aihub comments reply --replies-file replies.yaml` (status fixed, wontFix or closed).
4. A fix that touches a criterion: test that criterion again and record the outcome with `aihub criteria record`.

## Limits
{{limits}}

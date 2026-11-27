---
title: Write Tests for Criteria
slash: /story-tests
goal: One unit or data test per criterion.
reads: The criteria, the changed files and models.
produces: Tests in the repo, run targeted, the outcome per criterion recorded.
---
# Write Tests for Criteria
Write one test per acceptance criterion for story #{{story.id}} {{story.title}}.

## Criteria
{{criteria}}

## Do
1. Pick the smallest test that proves each criterion: unit test, dbt test or data check. Name the test after the criterion.
2. Run only the targeted tests: `aihub test changed --run`.
3. Commit with `aihub commit --type test --subject "<what>" --push`.
4. Record per criterion: `aihub criteria record --id {{story.id}} --criterion <n> --result pass|fail --evidence "<test name>" --reason "<outcome>"`.

## Limits
{{limits}}

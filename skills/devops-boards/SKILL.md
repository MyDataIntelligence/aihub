---
name: devops-boards
description: "Use when the user works with Azure DevOps boards, test plans or artifacts beyond one story: update a work item field, comment, link, tag, attach, history, my work or a query, the sprint, capacity, board columns, test plans and test points, test results of a build, package feeds."
---
# Boards, test plans and artifacts

## When
Work items beyond `aihub story`, the sprint and board, Test Plans, or Azure Artifacts feeds. Reads at once; writes support `--dry-run`, deletes need `--yes`.

## Steps
1. One work item: `aihub workitem get --id 12`, `update --field "title=New" --field "assignedto=Anna"`, `comment --text-file c.md`, `link --type parent --to 9`, `tag --tags a,b`, `attach --file x.png`, `history`, `delete --yes`. Types and states: `aihub workitem types`.
2. Find work: `aihub boards query run --mine`, `--query-file q.wiql` or `--saved "Open bugs"`; `aihub boards query list`.
3. Sprint and board: `aihub boards sprint list|items`, `capacity show`, `areas list`, `iterations list`, `show`, `backlog`, `tags`.
4. Test plans: `aihub testplan plans`, `suites --plan 1`, `points --plan 1 --suite 3`, `outcome --plan 1 --suite 3 --point 100 --to passed`. Results of a build: `testplan runs --build 265`, then `results --run 48` (failures first).
5. Packages: `aihub artifacts feeds`, `packages --feed F --filter lib`, `versions --feed F --package lib-core`. Read only.

```sh
aihub workitem tag --id 12 --tags blocked
aihub testplan runs --build 265
```

## What the CLI fills
Field names (title, state, assignedto, area, iteration, priority, tags), link types, JSON patch, the default team, the feed hosts, paging.

## If it fails
403 on test plans: the account needs the Test Plans license. Not signed in: `aihub doctor`. Never delete what you did not create.

Rules: prose goes in files; `--json` when you parse.

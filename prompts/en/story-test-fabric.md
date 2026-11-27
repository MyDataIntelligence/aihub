---
title: Test on Fabric
slash: /story-test-fabric
goal: Proof per criterion that the feature works, with a link to the proof.
reads: The criteria with how tested and proof; the feature workspace from team.yaml.
produces: A table criterion, how tested, outcome, link; the test status on the story.
---
# Test on Fabric
Test story #{{story.id}} per criterion in the workspace of the feature branch.

## Read
- the story's criteria with "How tested" and "Proof":
{{criteria}}
- the workspace of the feature branch: {{workspace}}

## Do
1. Find the workspace {{workspace}}. It does not exist: stop and say so.
2. Sync the branch {{branch}} and run what "How tested" names (`aihub fabric run`, `aihub fabric sql`).
3. Run the check per criterion: a query with the expected outcome, or the run.
4. Record per criterion: `aihub criteria record --id {{story.id}} --criterion <n> --result pass|fail --evidence <link> --reason "<outcome>"`.

## Deliver
A table: criterion, how tested, outcome, link. Every criterion gets an outcome; write "not run yet" when something did not
run. `aihub criteria status --id {{story.id}}` shows the state.

## Limits
{{limits}}

---
title: Refine with Agent
slash: /story-refine
goal: Description, criteria and tasks by the team template.
reads: The story, the empty sections of the template.
produces: A proposal per part; the user picks what is applied.
---
# Refine with Agent
Refine {{story.type}} #{{story.id}} {{story.title}}. Write nothing to Azure DevOps.

## Do
1. Ask for the proposal file: `aihub stories refine-ask --id {{story.id}}` (the answer names `proposalFile` and the gaps).
2. Write a `## <heading>` from the team template per part you would change, and `## Tasks` with one `- <task>` line per
   new task. Keep the facts of the current text; leave out parts you would not change.
3. Acceptance criteria get `How tested:` and `Proof:` under each criterion.
4. Then answer only "Proposal ready" and stop.

## Limits
{{limits}}

---
title: Define Acceptance Criteria
slash: /story-criteria
goal: Testable acceptance criteria, each with how tested and proof.
reads: The story, its current criteria and the team template.
produces: A proposal in the proposal file; the user ticks what is saved.
---
# Define Acceptance Criteria
Propose testable acceptance criteria for {{story.type}} #{{story.id}} {{story.title}}. Write nothing to Azure DevOps.

## Read
- The story: `aihub stories show --id {{story.id}}` (description, current criteria, tasks).
- Current criteria:
{{criteria}}

## Do
1. Turn every criterion into an observable result. Vague words ("fast", "good", "clean") become a number or a concrete
   outcome; if you cannot decide that yourself, write the question with it.
2. Give every criterion two lines under it:
   - `How tested:` Fabric run, data check (with query and expected outcome), unit test or manual (who confirms what).
   - `Proof:` what counts as proof (run link, query and outcome, test name, a comment on the story).
3. For a Bug: criteria for what must provably work after the fix, including the case from Repro Steps.
4. Write the proposal to the file `aihub criteria proposal-file --id {{story.id}}` names, in this format:
   ```
   1. <criterion>
      How tested: <kind>: <how>
      Proof: <what>
   ```
5. Then answer only "Proposal ready" and stop. The user ticks in the story browser what is saved.

## Limits
{{limits}}

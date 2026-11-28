---
title: Create / Update Pull Request
slash: /story-pr
goal: A pull request by the team template, with the criteria table.
reads: The commits, the team template, the criteria and their status.
produces: A PR (or draft) to the target branch, without technical noise.
---
# Create / Update Pull Request
Create or update the pull request for story #{{story.id}} {{story.title}} from {{branch}} to {{target}}.

## Do
1. Write only the team template's headings, short and for the reviewer, in {{language}}. No unit-test counts, no
   environment problems, no internal coordination.
2. `aihub pr create --body-file <file>` (when the PR exists the same command updates it). aihub writes the section
   Acceptance criteria and "N/M proven" itself.
3. Not all criteria proven: aihub stops with the choices: test first (/story-test-fabric {{story.id}}), as a draft
   (`--draft`) or anyway (`--anyway`).{{#if draft}} I chose: as a draft; use `--draft`.{{/if}}{{#if anyway}} I chose: create anyway; use `--anyway`.{{/if}}{{#if askChoice}} Put the choice to me; never pick `--anyway` yourself.{{/if}}
4. Report the PR link and how many criteria are proven.

## Limits
{{limits}}

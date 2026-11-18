---
name: feasibility
description: "Use when the user asks whether something can be done: 'kan dit?', 'is het mogelijk om ...', 'kan Fabric of DevOps dit', 'hoe zou dat kunnen', 'can this be done', '/kan-dit', '/can-it'."
---
# Is this possible? Research it, then answer

## When
An idea about what Fabric or Azure DevOps can do. Research it, never guess.

## Steps
1. Restate the question in one line, and first run `aihub research template > report.md`: your answer is that file, filled in.
2. Research three angles for Fabric and Azure DevOps both, in parallel with `aihub-researcher` subagents if available:
   - **Docs**: Microsoft Learn, REST reference, release notes, roadmap, limits.
   - **Community**: GitHub issues, Q&A, Stack Overflow, Reddit, each with its date.
   - **Live probes**, read-only: `aihub probe fabric endpoint workspaces/{workspace}/copyJobs` (no leading slash), `aihub probe fabric capacity`, `aihub probe devops feature pipelines`, `aihub probe api --get <docs url>`.
3. A proof of concept only after one yes, in an `aihub-test-dev-*` workspace or synthetic Azure DevOps objects, cleaned up.
4. Fill every section of `report.md` in the team language, none left out; **Waar hoort het** covers Fabric, Azure DevOps and Samen and ends with one advice line (`references/where.md`). Mark what has no source or probe `niet geverifieerd`. Then show the file.
5. `aihub research save --file report.md` checks the headings and keeps the report; `--wiki <page>` only after a yes.

## What the CLI fills
Probes use the user's sign-in and print YES, NO or UNKNOWN with the raw status, never item contents.

## If it fails
Not signed in: `aihub doctor`. UNKNOWN is not NO: report a 403 as open.

## Example
"Kan een variable library per stage andere waarden hebben?"
```sh
aihub probe fabric capacity --feature variablelibrary
aihub probe api --get https://learn.microsoft.com/fabric/cicd/variable-library/variable-library-overview
```
YES: the item type exists here; the docs excerpt gives the rule. Verdict: Ja.

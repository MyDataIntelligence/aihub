---
name: feasibility
description: "Use when the user asks whether something can be done: 'kan dit?', 'is het mogelijk om ...', 'kan Fabric of DevOps dit', 'hoe zou dat kunnen', 'can this be done', '/kan-dit', '/can-it'."
---
# Is this possible? Research it, then answer

## When
An idea about what Fabric, Azure DevOps or another service can do. Research it; never answer from memory.

## Steps
1. Restate the question in one line.
2. Research three angles, in parallel with the `aihub-researcher` subagent if your client has subagents, else one after the other:
   - **Docs**: Microsoft Learn, REST reference, release notes, roadmap, known limits.
   - **Community**: GitHub issues, Microsoft Q&A, Stack Overflow, Reddit. Note each date.
   - **Live probes** on the user's tenant, read-only: `aihub probe fabric endpoint workspaces/{workspace}/copyJobs` (no leading slash), `aihub probe fabric capacity`, `aihub probe devops feature`, `aihub probe api --get <docs url>`.
3. A proof of concept only after one yes from the user, in an `aihub-test-dev-*` Fabric workspace or synthetic Azure DevOps objects, cleaned up afterwards.
4. Answer in the team language with exactly these headings: **Verdict** (Ja / Nee / Deels, with workaround), **Hoe**, **Bewijs** (probe output, PoC), **Bronnen** (link and date), **Grenzen en risico's**, **Inschatting inspanning**, **Open vragen**. Mark what has no source or probe as `niet geverifieerd`.
5. Offer `aihub research save --file report.md`; add `--wiki <page>` only after a yes.

## What the CLI fills
Probes use the user's own sign-in and print YES, NO or UNKNOWN with the raw status and the answer shape, never item contents.

## If it fails
Not signed in: `aihub doctor`. UNKNOWN is not NO: a 403 is a permission or tenant setting, report it as open.

## Example
"Kan een variable library per stage andere waarden hebben?"
```sh
aihub probe fabric capacity --feature variablelibrary
aihub probe api --get https://learn.microsoft.com/fabric/cicd/variable-library/variable-library-overview
```
YES: the item type exists here. The docs excerpt gives the rule. Verdict: Ja, with the page date.

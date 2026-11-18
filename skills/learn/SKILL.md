---
name: learn
description: "Use when the user wants to understand a change or a repository: 'leg deze PR uit', 'wat doet deze wijziging', 'leer me deze repo', 'explain this change', 'walk me through it', '/leer'."
---
# Learn: explain a change or a repository, visually

## When
The user wants to understand what a PR, branch or the whole repository does and why. The CLI gives facts; you write the lesson, with pictures first.

## Steps
1. Get the facts: `aihub learn change --json > facts.json` (add `--pr 42` or `--range a..b`), or `aihub learn repo --json` for the repository. Read nothing else first.
2. Read only the changed hunks and the places the facts name (callers, tests, dbt models). Never invent a file, function or number: if the facts do not show it, leave it out or say `niet geverifieerd`.
3. Write `explanation.json` in the team language, as `references/schema.md` says. Pictures first: Mermaid `diagram.before` and `diagram.after`, then `diagrams` for flow, architecture or dbt lineage taken from the facts.
4. `aihub learn validate --file explanation.json --facts facts.json`; fix every line it names, then validate again.
5. Show the user the lesson: one sentence, the before/after pictures (Mermaid blocks), what changed per file and why, who is affected, risks, then three quiz questions.

## What the CLI fills
Files, hunks, changed names, who uses them, tests and dbt lineage, from git in about a second. It is a text search, not a call graph.

## If it fails
No target branch: pass `--range origin/main..HEAD`. PR not found locally: `git fetch origin`, then retry.

## Example
`/leer` on a branch that adds a guard to `scale`:
```sh
aihub learn change --json > facts.json
aihub learn validate --file explanation.json --facts facts.json
```
Picture: `flowchart LR` with the new `factor negatief?` decision highlighted; affected: `report.py` calls `scale`.

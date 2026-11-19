---
name: learn
description: "Use when the user wants to understand a change or a repository: 'leg deze PR uit', 'wat doet deze wijziging', 'leer me deze repo', 'explain this change', 'walk me through it', '/leer'."
---
# Learn: explain a change or a repository, visually

## When
The user wants to understand what a PR, branch or the whole repository does and why. The CLI gives facts; you write the lesson, with pictures first.

## Steps
1. Get the facts: `aihub learn change --json > facts.json` (add `--pr 42` or `--range a..b`), or `aihub learn repo --json` for the repository.
2. Read only the changed hunks and the places the facts name (callers, tests, dbt models). Never invent a file, function or number: if the facts do not show it, leave it out or say `niet geverifieerd`.
2b. More pictures and orientation from facts: `aihub learn diagram|flow|glossary|week|onboarding|item` (`references/more.md`).
3. Run `aihub learn level --json` and write `explanation.json` in the team language in that level's `style`, as `references/schema.md` says. Pictures first: Mermaid `diagram.before` and `diagram.after`, then `diagrams` for flow, architecture or dbt lineage taken from the facts.
4. `aihub learn validate --file explanation.json --facts facts.json`; fix every line it names, then validate again.
5. `aihub learn save --file explanation.json --facts facts.json` keeps it in the user's personal store; tell them to open it in VS Code (AI Context Hub: Learn). In the chat give one sentence and the before/after pictures as Mermaid blocks.
6. No PR or branch ("how does this team work", "what changed this week")? Still a lesson: use `flow`, `week` or `onboarding`, write `explanation.json`, save it; never chat only.

## What the CLI fills
Files, hunks, changed names, who uses them, tests and dbt lineage, from git in about a second. It is a text search, not a call graph.

## If it fails
No target branch: pass `--range origin/main..HEAD`. PR not found locally: `git fetch origin`, then retry.

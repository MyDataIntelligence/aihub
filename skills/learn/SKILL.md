---
name: learn
description: "Use when the user wants to understand a change or a repository: 'leg deze wijziging uit', 'leg deze PR uit', 'wat doet deze branch', 'wat is er veranderd', 'leer me deze repo', 'explain this change', 'walk me through it', '/leer'."
---
# Learn: explain a change or a repository

## When
The user wants to understand what a PR, branch or the whole repository does and why. The CLI gives the facts; you explain them.

## Steps
1. One call for the facts: `aihub learn change --json` (add `--pr 42` or `--range a..b`; the base branch is found for you), or `aihub learn repo --json` for the repository. Do not run `git diff` or `git log` first, and do not read `team.yaml`.
2. "Explain this change" (the usual case): answer in the chat from those facts, in the team language. What changed, why (story, commits), who is affected (callers, tests), one Mermaid before/after picture when it helps. Read a file only when the facts point at something unclear. Never invent a file, function or number; say `niet geverifieerd`. Then stop: one call in total.
3. Only when the user wants to KEEP the lesson ("bewaar", "sla op", "maak er een les van"):
   - `aihub learn change --json > facts.json`, then write `explanation.json` (UTF-8) as `references/schema.md` says, in the style of `aihub learn level --json`.
   - `aihub learn validate --file explanation.json --facts facts.json`: it lists every problem at once; fix them all, then validate once more.
   - `aihub learn save --file explanation.json --facts facts.json`; `aihub learn show --id <id>` shows it.
4. More pictures on request: `aihub learn diagram|flow|glossary|week|onboarding|item` (`references/more.md`).

Example: "leg uit wat deze branch doet" is `aihub learn change --json`, then the answer. Nothing else.

## What the CLI fills
Files, hunks, changed names, who uses them, tests and dbt lineage, from git in about a second. It is a text search, not a call graph. Files written by PowerShell (UTF-16) are read as well.

## If it fails
No target branch: pass `--range origin/main..HEAD`. PR not found locally: `git fetch origin`, then retry.

Done is done: end with the result and at most one statement about the next step, never with a question.

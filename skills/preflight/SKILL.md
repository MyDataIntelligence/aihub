---
name: preflight
description: "Use when a change to job or DDL YAML must be checked against the team's deploy job before a push, or put in the feature workspace without waiting for the CD: 'test mijn YAML-wijziging voor ik push', 'draai de CD lokaal', 'zet dit in mijn feature-workspace zonder te wachten op de CD', 'preflight', 'run the deploy job locally', 'check before I push'."
---
# Preflight: the deploy job on this PC

## When
Before a push that touches the files under `preflight.watch` in `team.yaml`, or when the user wants the CD result now.

## Steps
1. Local level (no network, no token): `aihub preflight`. Fix what fails, run again.
2. See what the CD would do in the branch's feature workspace (reads only): `aihub preflight --plan`.
3. Only when the user asked to put it in the feature workspace: `aihub preflight --apply`. Then test there (skill `test-run`).
4. One step: `--step "<name>"`. What would run: `--dry-run`.

Example (the user: "test mijn YAML-wijziging en zet hem in mijn workspace"):

```sh
aihub preflight --plan
aihub preflight --apply
```

## What the CLI fills
The steps and their scripts from the pipeline YAML of `origin/<ref>` of the source repository, the snapshot of your working tree (uncommitted files included), variables between steps, your sign-in tokens for read and apply steps, the workspace of the current branch. Do not ask for ids or tokens.

## If it fails
- `blocked: needs variable X`: tell the user the one line for `preflight.variables` in `team.yaml`.
- `unknown` step or drift: say which step and ask under which list it belongs (`local`, `read`, `apply`, `skip`); never guess a level. `aihub preflight steps` lists them.
- A plan that removes something: `--apply` stops; add `--yes` only when the user agrees.
- A read step with a new write call: show it; `aihub preflight accept "<step>"` only when the user agrees.
- No `preflight:` block: `aihub preflight steps --job <path> --source <repo>`, then help fill it. Not signed in: `az login`.

Rules: never ACC or PRD; `--apply` only on the user's request and only on the branch's feature workspace. Report each failed step with its first issue. Details: `docs/preflight.md` of aihub.

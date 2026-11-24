---
name: pipeline-fix
description: "Use when a build or pipeline failed: 'waarom is de pipeline rood', 'waarom faalt de build', '/fix <run url>', 'pipeline is rood', 'fix the build', 'de build faalt', 'tests falen in CI', a failed check on a pull request."
---
# Explain or fix a failing run

## When
A build is red. First decide what the user asked; do not read `team.yaml` (the CLI applies it).
- **Why is it red?** ("waarom", "wat is de oorzaak", "what broke"): read only, answer, stop.
- **Fix it** ("fix", "repareer", "maak groen", `/fix`): the full loop below.

## Steps: why is it red (one call)
1. `aihub pipeline logs --failed` (add `--run <url|id>`; no run: the newest failed run of this branch). It names the run, the branch, the failing step and the error lines.
2. Answer in 2-3 sentences: quote the `error (quote it as is):` line of the output word for word (never only "exited with code 1"), then the file or test and whether it looks flaky. Do not run `pipeline timeline` for this. Offer the fix in one line ("Zal ik het repareren?") and STOP: no code change, no commit, no new run.

## Steps: fix it
1. Facts as above. Where exactly: `aihub pipeline timeline --run <id> --failed`; failing tests: `aihub pipeline tests --run <id>`; team knowledge: `aihub fix known --run <id>`.
2. STOP and report, no fix, when line 1 says so (protected branch such as main, staging, release/*; or 3 red rounds). Flaky or infrastructure: `aihub pipeline retry --run <id>` once at most, change no code.
3. Fix the cause on the own branch, never weaken a test; check with `aihub test changed --run`.
4. `aihub commit --type fix --subject "<what>" --push`, then `aihub watch --run <new id> --notify` (`aihub pipeline runs --top 1` gives the id) and end your turn.
5. Red again: back to 1; after the third red round stop and report. Green after a non-obvious fix: ask once, then `aihub fix remember --error "<line>" --fix "<1-3 lines>"`.

```sh
aihub pipeline logs --failed --run 123
```

Example: "waarom is de pipeline rood?" is that one command and a short answer. A Fabric notebook run is the fabric skill.

## What the CLI fills
Branch, protected flag, red rounds, failing step, log tail.

## If it fails
Not signed in: `aihub doctor`. Never push to main, staging or release, never force-push.

Rules: 0 questions. Commit messages follow the team language.

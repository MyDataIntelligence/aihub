---
name: pipeline-fix
description: "Use when a build or pipeline failed: 'waarom is de pipeline rood', 'waarom faalt de build', '/fix <run url>', 'pipeline is rood', 'fix the build', 'de build faalt', 'tests falen in CI', a failed check on a pull request."
---
# Explain or fix a failing run

## When
A build is red. First decide what the user asked; do not read `team.yaml` (the CLI applies it).
- **Why is it red?** ("waarom", "wat is de oorzaak", "what broke"): read only, answer, done.
- **Fix it** ("fix", "repareer", "maak groen", `/fix`): the loop below.

## Steps: why is it red (one call)
1. `aihub pipeline logs --failed` (add `--run <url|id>` when given).
2. Answer in 2-3 sentences: quote its `error (quote it as is):` line word for word, then the file or test. End with one statement, never a question: "Repareren is een aparte vraag: zeg 'fix de pipeline'." Change nothing.

## Steps: fix it (four calls)
1. `aihub pipeline logs --failed`. It says STOP on a protected branch or after 3 red rounds: then only report.
2. Fix the cause in the code with your own tools; never weaken a test.
3. `aihub commit --type fix --subject "<what>" --push`
4. `aihub pipeline rerun`: the new run of that pipeline for your commit (started by the push, or queued now) and a background watch with a toast. Report the run id in one line and end your turn.

No `--help`, no `timeline`, `tests`, `runs` or `watch` calls: the commands above already give what they would. Flaky or infrastructure (agent offline, quota, timeout): change no code, `aihub pipeline rerun` once.

```sh
aihub pipeline logs --failed --run 123
aihub commit --type fix --subject "add missing column" --push
aihub pipeline rerun
```

Example: "waarom is de pipeline rood?" is the first command and a short answer that quotes the error line.

## What the CLI fills
Branch, protected flag, red rounds, the real error line, log tail, the pipeline to run again, the watch.

## If it fails
Not signed in: `aihub doctor`. Red again: one more round, then report what you tried. Never push to main, staging or release, never force-push.

Rules: done is done; never end with a question when the task is done. Commit messages follow the team language.

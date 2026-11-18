---
name: standup
description: "Use when the user wants a standup or a handover: '/standup', 'wat heb ik gisteren gedaan', 'what did I do', 'standup', '/handoff', 'draag mijn werk over', 'handoff note for <name>'."
---
# Standup and handoff

## When
The user asks what they did since yesterday, or wants their open work written down for a colleague (leave, switching teams).

## Steps
1. Standup: `aihub standup` (default since yesterday; on a Monday since Friday). Other windows: `--since today`, `--since 3d`.
2. Show the 3 to 5 lines as they are (team language); do not add what is not in them.
3. Handoff: `aihub handoff --to <name>` prints a short markdown note: open PRs with votes, open threads and build, stories, branches with work not pushed, running watches, failing runs.
4. Only when asked: `--clipboard` copies the note, `--wiki` publishes it as wiki page `Handoff/<your name>` (`--wiki-page <path>` for another page).

```sh
aihub standup --since 2d
aihub handoff --to Anna --clipboard
```

## What the CLI fills
Everything from Azure DevOps and git: commits, PRs (created, merged, updated), reviews you commented on, builds, story state changes, language from team.yaml.

## If it fails
Not signed in: `aihub doctor`. A part that cannot be read is left out, not guessed. Fabric runs are not part of the summary.

Rules: both commands only read; `--wiki` is the one write and only on request. 0 questions.

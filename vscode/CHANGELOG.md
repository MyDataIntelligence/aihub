# Changelog

## 3.1.0

- Status bar item bottom-left right after the branch item: "⎇ Repos op branch openen" or "⎇ <branch> · 3 repos" in a set (tooltip per repo); also a button in the Source Control title and the editor title, the command "AI Context Hub: Repos op branch openen..." with Ctrl+Alt+B.

- The first chip of the bar is "Repos op branch openen": choose a group (or tick repositories and save them as a group), choose a branch (existing with "exists in 2/3", a new branch for a story, or the branch of one of your pull requests), choose worktrees (recommended) or switching the checkouts and a new or this window. It runs `aihub worktree open --json` itself, it is not a chat action. A window that is a set shows the chip "Set: <group> · 3/3 op <branch>". The Worktree Sets view lists the repo groups with an "Open on branch..." button. Needs aihub 1.0.8.

## 3.0.0

First release of the thin extension: compact bar + status bar, actions to chat with the aihub agent, review threads in the editor, Branch menu and Worktree Sets, Learn view (lessons, Mermaid diagrams, tour, quiz, iDiagram Play story). Notes: docs/releases/3.0.0.md.

## 3.0.0-dev.0

New thin extension over the aihub CLI (replaces the frozen 2.x Java-core extension). Status bar, panel, actions to chat, Fabric section, watch events.

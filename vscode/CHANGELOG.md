# Changelog

## Unreleased

- `aihub --version` runs at most once a day per CLI command: a known good version is remembered in the global state (asked again when the CLI is missing). With aihub 1.0.10, `aihub status` starts three git processes instead of six and every aihub run loads only the command it runs.

## 3.1.2

- Fewer git processes: the Worktree Sets view reads the status of a set once per refresh and shares it between the rows (it read the whole set once per repository row: repos x repos x 6 git processes).
- Automatic refreshes of the bar (timer, focus, branch change) back off after a slow read: they wait at least ten times the duration of the last read, at most 10 minutes. A fast read changes nothing; "Refresh" is never delayed. The performance report counts these as `refresh.skip.<reason>.backoff`. Notes: docs/releases/3.1.2.md.

## 3.1.1

- Built-in performance log, on by default and local only (`aihub.performanceLog.enabled`, `aihub.performanceLog.level`): activation per phase, commands, status reads, every child process through one spawn wrapper, timers and watchers, notifications, and a host sample (event-loop delay, CPU, memory) every 30-60 s. Commands "AI Context Hub: Show Performance Report" and "AI Context Hub: Export Performance Log"; `aihub doctor` shows where the log is. Secrets, e-mail addresses and file contents are never written.
- Lighter refresh: one `aihub bar --json` process per refresh instead of four or five (falls back for an older CLI); Fabric "no workspace" or "not signed in" is asked once per branch; without an Azure DevOps sign-in the bar says "not signed in" at once; background reads never wait for a sign-in window (`GCM_INTERACTIVE=never`). The aihub processes add their network calls, child processes and start-up time to the performance log (`AIHUB_PERF_LOG`), and the report shows them. Needs aihub 1.0.9 for the one-process refresh. Notes: docs/releases/3.1.1.md.

## 3.1.0

- Status bar item bottom-left right after the branch item: "⎇ Repos op branch openen" or "⎇ <branch> · 3 repos" in a set (tooltip per repo); also a button in the Source Control title and the editor title, the command "AI Context Hub: Repos op branch openen..." with Ctrl+Alt+B.

- The first chip of the bar is "Repos op branch openen": choose a group (or tick repositories and save them as a group), choose a branch (existing with "exists in 2/3", a new branch for a story, or the branch of one of your pull requests), choose worktrees (recommended) or switching the checkouts and a new or this window. It runs `aihub worktree open --json` itself, it is not a chat action. A window that is a set shows the chip "Set: <group> · 3/3 op <branch>". The Worktree Sets view lists the repo groups with an "Open on branch..." button. Needs aihub 1.0.8.

## 3.0.0

First release of the thin extension: compact bar + status bar, actions to chat with the aihub agent, review threads in the editor, Branch menu and Worktree Sets, Learn view (lessons, Mermaid diagrams, tour, quiz, iDiagram Play story). Notes: docs/releases/3.0.0.md.

## 3.0.0-dev.0

New thin extension over the aihub CLI (replaces the frozen 2.x Java-core extension). Status bar, panel, actions to chat, Fabric section, watch events.

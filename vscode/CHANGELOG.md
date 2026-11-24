# Changelog

## 3.3.0

- Worktree sets and stories are one thing (a story set is a worktree set with a story link). New Worktree Set... first asks "for which story?" (none, one of mine, or a number); with a story the branch is feature/<id>-..., the set goes to the story folder, the branches are linked and get the star. Open Worktree Set... is one list: recent stories and sets first, then my other stories; a story opens its star branches. The status bar button opens a menu: New, Open, Recent (8) and More...; palette "Recent Worktree Sets and Stories...".
- Public commands for other extensions (the PyCharm-style File menu of PyCharm Git): `aihub.newWorktreeSet`, `aihub.openRepoSet`, `aihub.getRecents({merged:true})` -> `[{kind,id,label,detail,lastOpened}]`, `aihub.openRecent({kind,id})`; the older `aihub.openStory`, `aihub.openRecentSet`, `aihub.openRecentStory` and `aihub.getRecents()` keep working. The recent list lives in the global state (no file IO at activation). Notes: docs/releases/3.3.0.md.
- **Performance Advisor** (AI Context Hub: Performance Advisor): one card per cause of slowness with the measured evidence, the exact change, the risk and the undo. Defender scanning the repositories (slow node/git starts plus a scan probe; narrow exclusions for the repository folders and node.exe/git.exe only, after an explicit click through one UAC prompt, or a ready IT request text when Defender is managed by policy), OneDrive and network drives, Windows Search indexing (`attrib +I`), git settings for large repositories (`core.fsmonitor`, `core.untrackedCache`, `feature.manyFiles`), long paths, and large folders missing from `files.watcherExclude` / `search.exclude`. Your own settings apply directly with Undo; nothing changes without a click. Once a day it may offer one finding as a notification (Add / Show command / Not now / Never for this), each finding at most once (`aihub.performanceAdvisor.notify`). Engine: `aihub doctor --perf`.
- The performance report opens in a panel with a period choice (last hour, today, 24 hours, 7 days) and **Export…** (one zip: report.md, the extension's and the CLI's logs of the period, system.txt with versions, OS and whether it is a virtual machine; scrubbed, no paths outside the workspace), **Copy summary** and **Open folder**.

## 3.2.0

- My Stories (Explorer): story -> repository -> branches with a star for the branch you work on, old branches dimmed, labels, local work, pushed and PR per branch; Open Story..., Link Branches..., Mark as Current / Old / Parked, Change Label..., Unlink, Remove Branch and Worktree..., Open Worktree in New Window. The star follows where you work (saves, edits, focus minutes, commits and checkouts; at most one write per minute, no polling timer), setting `aihub.storyWorktrees.autoMarkCurrent` ask/auto/off. "Repos op branch openen" is now "Open Repo Set"; the status bar shows the set also after switching checkouts.
- `aihub --version` runs at most once a day per CLI command: a known good version is remembered in the global state (asked again when the CLI is missing). With aihub 1.1.0, `aihub status` starts three git processes instead of six and every aihub run loads only the command it runs.
- Repos op branch openen really switches windows: the extension opens the set itself (this window or a new one, `aihub worktree open --window none`), the current branch is preselected in step 2 (one Enter), every step shows "stap n/3", and step 3 is one choice of how and where. Needs aihub 1.1.0. Notes: docs/releases/3.2.0.md.

## 3.1.2

- Fewer git processes: the Worktree Sets view reads the status of a set once per refresh and shares it between the rows (it read the whole set once per repository row: repos x repos x 6 git processes).
- Automatic refreshes of the bar (timer, focus, branch change) back off after a slow read: they wait at least ten times the duration of the last read, at most 10 minutes. A fast read changes nothing; "Refresh" is never delayed. The performance report counts these as `refresh.skip.<reason>.backoff`. Notes: docs/releases/3.1.2.md.

## 3.1.1

- Built-in performance log, on by default and local only (`aihub.performanceLog.enabled`, `aihub.performanceLog.level`): activation per phase, commands, status reads, every child process through one spawn wrapper, timers and watchers, notifications, and a host sample (event-loop delay, CPU, memory) every 30-60 s. Commands "AI Context Hub: Show Performance Report" and "AI Context Hub: Export Performance Log"; `aihub doctor` shows where the log is. Secrets, e-mail addresses and file contents are never written.
- Lighter refresh: one `aihub bar --json` process per refresh instead of four or five (falls back for an older CLI); Fabric "no workspace" or "not signed in" is asked once per branch; without an Azure DevOps sign-in the bar says "not signed in" at once; background reads never wait for a sign-in window (`GCM_INTERACTIVE=never`). The aihub processes add their network calls, child processes and start-up time to the performance log (`AIHUB_PERF_LOG`), and the report shows them. Needs aihub 1.0.9 for the one-process refresh. Notes: docs/releases/3.1.1.md.

## 3.1.0

- Status bar item bottom-left right after the branch item: "âŽ‡ Repos op branch openen" or "âŽ‡ <branch> Â· 3 repos" in a set (tooltip per repo); also a button in the Source Control title and the editor title, the command "AI Context Hub: Repos op branch openen..." with Ctrl+Alt+B.

- The first chip of the bar is "Repos op branch openen": choose a group (or tick repositories and save them as a group), choose a branch (existing with "exists in 2/3", a new branch for a story, or the branch of one of your pull requests), choose worktrees (recommended) or switching the checkouts and a new or this window. It runs `aihub worktree open --json` itself, it is not a chat action. A window that is a set shows the chip "Set: <group> Â· 3/3 op <branch>". The Worktree Sets view lists the repo groups with an "Open on branch..." button. Needs aihub 1.0.8.

## 3.0.0

First release of the thin extension: compact bar + status bar, actions to chat with the aihub agent, review threads in the editor, Branch menu and Worktree Sets, Learn view (lessons, Mermaid diagrams, tour, quiz, iDiagram Play story). Notes: docs/releases/3.0.0.md.

## 3.0.0-dev.0

New thin extension over the aihub CLI (replaces the frozen 2.x Java-core extension). Status bar, panel, actions to chat, Fabric section, watch events.

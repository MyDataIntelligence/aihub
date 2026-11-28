# Changelog

## 3.9.0

- aihub.bar.team* commands for the Team Settings pages (one process per call, only when a page asks).
- Run End to End bridge: aihub.bar.storyAction opens or reuses the story's set and starts the opencode tab with the action; storyPrompt*, storyRunState and criteria* commands; the dialog's options reach the prompt; Stop.
- aihub.bar.change* (Change with Agent: remote or working copy, agent in a terminal, a new window or Windows Terminal; state, push, discard, stop), browseSearch with a scope, aihub.bar.ask* and aihub.bar.changeSuggestFiles.
- The buttons need aihub 1.10.0.

## 3.8.0

- One engine for a set of the repositories the user picks: aihub.bar.openReposAsSet (New Set, Open as Set, noSet for one repository in its own window), cloning when needed, with Undo.
- Add Repository in the window of a single repository makes it a set.
- A set whose first folder is outside the set folder is found through the workspace file.
- aihub.bar.wiki* and aihub.bar.story* commands for the wiki and story browsers.
- A pipeline run opens in a window without its repository; the Azure DevOps search also reads from a repository of a worktree set.
- The look at the target branch at opening runs at the first focus when the window had none; Update from Target always passes --target and says nothing changed when nothing did.
- aihub.bar.storyMove takes a board column instead of a state.
- The buttons need aihub 1.9.0.

## 3.7.1

- Behind the target updates by itself by default (aiContextHub.behindTarget: auto): no conflicts, no overlap, never a push, with Undo; a conflict asks.
- Create Pull Requests: progress per repository, Open Pull Request(s) with the links, the pull requests read again, a message when nothing is ticked; a timed-out call stops its whole process tree.
- The pull requests of a set are read per branch of the set (anyone, any state), so an older one or a colleague's shows instead of "none yet".
- Update All offers Update from Target for a branch with commits of its own; a repository that is not on Azure DevOps is not "not signed in"; the status bar never says "(unknown)".
- Open Story by number names the branch after the title, never feature/<id>-. The aihub.bar.browse* commands of the pipeline browser. The buttons need aihub 1.8.2. Notes: docs/releases/3.7.1.md.

## 3.7.0

- `aihub.bar.pipeline*` commands for pipelines in the PyCharm Git bar (runs, run, log, status, rerun plan, rerun, rerun failed, cancel, fix in chat, retry): CLI JSON or a typed error, no popups; lasting failures remembered 5 minutes per folder; the rerun changes go through a private temp file that is removed at once.
- Smart Checkout instead of a CLI flag for a switch with uncommitted work; every failure in one plain sentence with Show Details.
- A clone that cannot be found offers Choose Folder… (checked against the remote, remembered, the action repeated), also when it is reported inside an open result; the search clone shows where it goes, can be cancelled, and Undo removes it even with read-only git files.
- No process of the extension inherits the git repository variables. The buttons need aihub 1.8.0. Notes: docs/releases/3.7.0.md.

## 3.6.0

- The engine behind the story-set buttons of PyCharm Git 0.28.0 (`exports.bar`, `BarState`, `aihub.bar.*`): Open Story with existing story branches, the four-choice question for a branch with a worktree elsewhere, Update All / Commit All / Push All / Create Pull Requests, Open in Own Window, Undo after every set action (one message per action), behind the target branch (`aiContextHub.behindTarget`: ask, auto, off; never pushes), set sizes and "all merged". The set never resets another repository by itself. A set file that cannot be read keeps the last good set (`BarState.setFileProblem`); a branch checked out in the clone itself and a hand-edited branch that git does not have each get one plain question.
- Pull request comments inline in the code and as counts in the Explorer (`aiContextHub.prComments`, default on): Reply, Resolve, Apply Suggestion (an edit, never saved), one notification for a new comment of someone else.
- The status bar has no timer: it reads after opening, on a branch switch of the first folder, and on focus after 5 minutes; never without focus; Fabric only with a team.yaml `fabric:` section.
- A CLI that is too old or missing gives a plain sentence with Copy update command / Update now. The buttons need aihub 1.7.0. Notes: docs/releases/3.6.0.md.

## 3.5.0

- A branch whose worktree already exists elsewhere: Open Repo Set, New Worktree Set and My Stories "Open story" ask the same three choices as the CLI in a dialog (Move it into this set, recommended; Reuse it where it is; Recreate it) and run the command again with the answer. Needs aihub 1.6.0; with an older CLI nothing changes.
- When the CLI switched repositories inside the set this window already shows (aihub 1.6.0 `stays`), no window is opened; the line is shown instead.
- The status bar tooltip of a set shows each repository's own branch when it is not the set's branch (`repos[].branch`, or `set.branches` of `aihub status`). Notes: docs/releases/3.5.0.md.

## 3.4.0

- Repo opener: step 1 of New Worktree Set... and of "Repositories on a branch..." is one multi-select pick with search. Saved groups (★) and recent repositories come first, then per Azure DevOps project its repositories (branch and folder, or "not cloned ↓"), then the local clones that are not in Azure DevOps. The local clones show at once; the Azure DevOps list is added when it is there. A repository that is not cloned is cloned into the repos root first (one notification, git's own error). After the pick: Save as group (personal or team.yaml); step 2 also has "Open as they are" (the folders on their current branches, no worktree). Setting `aihub.reposRoot`. Nothing runs at activation; opening the picker starts `aihub repos local` (no network) and `aihub repos ado` (cached).
- **No more git process storm in Worktree Sets** (a work laptop logged 1519 git starts in one minute and reads of two minutes): one `git status --porcelain=v2 --branch` per repository instead of four or five (the remote branch is read from .git), at most two git processes of the extension at a time, a status is kept until git changes something in that repository or a file in it is saved, only the set of this window is expanded (a collapsed set reads nothing), and a hidden view reads nothing. The branch shows in the status bar at once (from .git/HEAD) while the full status loads. Needs aihub 1.3.0 for Clean Up Worktrees and Run Robot Test. Notes: docs/releases/3.4.0.md.
- **Run Robot Test...** (palette, the Robot tests menu, the play button on a .robot file, Explorer right-click on a .robot file, the AI Context Hub panel title) and **Run this test** above every test case of a .robot file: pick suite, test and (team.yaml `robot.environments`) test environment; runs the team's runner (`robot.runner` or an `rf-run.py`) from its folder with the repository's virtual environment, or `python -m robot`, in a terminal; then PASS/FAIL with the failing tests and Open log.html / Open report.html. Engine: `aihub robot local` and `aihub robot result`.
- **Clean Up Worktrees...** (Worktree Sets view, palette): every worktree of this repository and your repo groups with size, last activity, local work (uncommitted, unpushed), merged, the pull request and the story of its branch (aihub worktree cleanup). Finished worktrees without local work are ticked, worktrees with local work never; removal takes folder links (a linked node_modules) out first, never uses --force, can delete merged local branches and says how much space was freed. A reminder at most once a day, normally once a week, sooner when three or more can go (`aihub.worktrees.cleanupReminder`).

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

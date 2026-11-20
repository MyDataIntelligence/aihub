# AI Context Hub for VS Code (3.0.0-dev)

A thin shell over the [`aihub` CLI](../README.md). Publisher `FerronHooi`, name `ai-context-hub`.

- **Status bar** (the main entry): story and branch, pull request with votes, pipeline, open review threads, Fabric runs of the branch's workspace, and events from `aihub watch --mine`. Quiet repositories show one item.
- **Panel** ("AI Context Hub" next to Problems/Terminal): the same chips, the next step, action buttons, the Fabric run table and the events.
- **Actions go to your chat.** A click puts the matching command (`/pr`, `/review`, `/commit`, ...) in the chat input; you press Enter. `aihub.chatTarget`: `auto` (an open opencode terminal, else Copilot Chat), `copilot`, `opencode`. Read-only things (refresh, open the PR in the browser, open the log) run directly.
- **The chat opens with the `aihub` agent.** In Copilot Chat the text goes in the input with the agent `aihub` selected (setting `aihub.chatAgentName`; installed by `aihub skills install`). If it is not installed the default agent mode is used and the install command is offered once. With opencode the text goes to the opencode terminal; start opencode with `--agent aihub`.
- **Branch menu** (Explorer right-click and Source Control menus, AI Context Hub > Branch): Reset to Branch or Commit, Check for Merge Conflicts, Clean Up Unrelated Changes, Squash Branch Commits, Switch Branch. Plain git in the extension; destructive steps ask first and list the files.
- **Worktree Sets** (Explorer view): one branch in several repositories, in one folder with one workspace file. Create, open, add repositories, sync, push, create pull requests (opens the set and puts `/pr` in chat), remove, clean up merged worktrees, repo groups. The git code is the one of Worktree Maker. Settings `aihub.worktrees.*`.
- **PR review threads in the editor**: the open threads of the branch's PR (`aihub comments get --json`) appear as comment threads on the files, with Resolve, Won't fix, Reactivate and Reply (`aihub comments reply --reply "<id>:<status>:<text>"`) and "Fix in chat" (a prompt with the thread goes to your chat with the aihub agent, same chatTarget logic).
- **Panel height**: VS Code gives extensions no way to set the height of a panel, so the AI Context Hub tab opens as high as your panel is. The strip itself is 30 px; drag the panel border down once and VS Code remembers it.
- **No logic here.** A refresh is one `aihub bar --json` process (status, checks of the active PR, Fabric failures and logs, watching, events), spawned with a time limit; with an aihub CLI older than `bar` it falls back to the separate reads (`status`, `pr checks`, `fabric failures`, `fabric logs`, `watch list`, `watch events`). Fabric is asked again after 3 minutes, but a branch without a Fabric workspace (or without a Fabric sign-in) is asked once until the branch changes, the settings change or you refresh. Without an Azure DevOps sign-in the status bar shows "not signed in" within a second instead of waiting for every read to fail. Events are read from the files `aihub watch --mine` stores in `~/.aihub/events`.
- **Low load, silent by default.** Refresh on window focus, on a git branch change and every `aihub.refreshIntervalSeconds` (default 60, minimum 15) while the window has focus; no polling when it has not. Fabric reads are cached at least 3 minutes. Nothing pops up on startup.
- **Performance log (on by default, local only).** The extension logs what it costs: activation per phase and its activation event, every command and status read (name, duration, ok), every child process (`git`, `aihub`, `az`: program, masked arguments, duration, exit code, `windowsHide`, how many ran at once), the timers and file watchers with their interval or glob and how often they fired, the notifications, and every 60 s (30 s with `aihub.performanceLog.level: verbose`) the event-loop delay p50/p99/max, CPU and memory of the extension host. JSON lines in the extension's global storage under `perf/aihub-perf-<date>.jsonl`, at most 10 MB per day, 7 days kept, written buffered and asynchronously. Never tokens, PATs, passwords, e-mail addresses, URL queries, commit messages or file contents; paths are relative to the workspace. **AI Context Hub: Show Performance Report** summarises the last 24 h (slowest actions, processes per minute, activation phases, event-loop p99, timers and watchers, notifications); **AI Context Hub: Export Performance Log** saves the last 7 days as one `.jsonl` to share; `aihub doctor` shows where the log is and its 24 h summary. Off with `aihub.performanceLog.enabled: false`.
- **CLI missing or too old:** the status bar says so, the panel shows one message with `npm i -g @ferronhooi/aihub` (needs 1.0.2 or newer).

## Develop

```sh
npm ci
npm run typecheck && npm run test:unit   # unit tests run against a fake aihub (test/fake-aihub.mjs + fixtures)
npm run package                          # ../build/ai-context-hub-<version>.vsix (not tracked)
```

What replaces what in the frozen 2.x extension: [../docs/vscode-inventory.md](../docs/vscode-inventory.md).

Live check: install the `.vsix` in an isolated profile (`--user-data-dir`, `--extensions-dir`), never your own.

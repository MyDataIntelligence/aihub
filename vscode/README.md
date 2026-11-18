# AI Context Hub for VS Code (3.0.0-dev)

A thin shell over the [`aihub` CLI](../README.md). Publisher `FerronHooi`, name `ai-context-hub`.

- **Status bar** (the main entry): story and branch, pull request with votes, pipeline, open review threads, Fabric runs of the branch's workspace, and events from `aihub watch --mine`. Quiet repositories show one item.
- **Panel** ("AI Context Hub" next to Problems/Terminal): the same chips, the next step, action buttons, the Fabric run table and the events.
- **Actions go to your chat.** A click puts the matching command (`/pr`, `/review`, `/commit`, ...) in the chat input; you press Enter. `aihub.chatTarget`: `auto` (an open opencode terminal, else Copilot Chat), `copilot`, `opencode`. Read-only things (refresh, open the PR in the browser, open the log) run directly.
- **No logic here.** Every read is `aihub <command> --json` (`status`, `pr checks`, `fabric failures`, `fabric logs`, `watch list`), spawned with a time limit and cached briefly. Events are read from the files `aihub watch --mine` stores in `~/.aihub/events`.
- **Low load, silent by default.** Refresh on window focus, on a git branch change and every `aihub.refreshIntervalSeconds` (default 60, minimum 15) while the window has focus; no polling when it has not. Fabric reads are cached at least 3 minutes. Nothing pops up on startup.
- **CLI missing or too old:** the status bar says so, the panel shows one message with `npm i -g @ferronhooi/aihub` (needs 1.0.2 or newer).

## Develop

```sh
npm ci
npm run typecheck && npm run test:unit   # unit tests run against a fake aihub (test/fake-aihub.mjs + fixtures)
npm run package                          # ../build/ai-context-hub-<version>.vsix (not tracked)
```

Live check: install the `.vsix` in an isolated profile (`--user-data-dir`, `--extensions-dir`), never your own.

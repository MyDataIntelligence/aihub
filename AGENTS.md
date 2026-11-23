# Repository instructions

- `cli/` is the npm package `@ferronhooi/aihub` (TypeScript, Node >= 18, no runtime daemon). Run `npm test` in `cli/` after changes.
- `vscode/` is the VS Code extension `FerronHooi.ai-context-hub` (TypeScript, esbuild): a thin status bar and panel over the CLI. It holds no logic: every read is `aihub <command> --json` (spawned, time-limited, cached), every action is text put in the user's chat (Copilot Chat or opencode). Run `npm ci && npm run typecheck && npm run test:unit` in `vscode/` after changes; package with `npm run package` (output in `build/`, not tracked). Never publish to the Marketplace without an explicit request.
- `skills/` is the generic skill pack. Each skill is `skills/<name>/SKILL.md` with front matter `name` and `description: "Use when ..."`, written in concise English, 200-500 tokens, one worked example with the exact `aihub` command. Run `npm run lint:skills` in `cli/`.
- Team knowledge never goes into this repository: no organisation, project, repository or person names, no absolute paths. Examples use the synthetic project `ferron-test` / `test-project`.
- Prose for pull requests, stories and comments is passed to the CLI as files (`--body-file`, `--replies-file`), never inline.
- Keep each rule in one place; update existing files instead of duplicating.

## Branches and releases

- `staging` is the default branch and the integration branch. Every change goes in through a pull request to `staging`; CI (`test`) must be green; squash-merge.
- `main` is the released state. Only release pull requests `staging` → `main` go there (merge commit, no squash), after the release checks pass.
- Every merge to `staging` may be published as a test version on the npm dist-tag `next` (`npm i -g @ferronhooi/aihub@next`). A version tag `vX.Y.Z` on `main` publishes to `latest` with release notes.
- Feature branches: `<topic>` or `feat/<topic>`, `fix/<topic>`; one topic per pull request; delete after merge.
- Never push directly to `staging` or `main`; no force pushes.

## Speed (the extension must never make the editor slow)

The target machine is a Windows laptop running VS Code in a VM with antivirus: starting a process is expensive there (one `git` call is about three process starts), so the number of processes started per minute is the budget that matters.

- No background work for something the user cannot see: a hidden view does not poll; it is marked stale and reads once when it is shown.
- One read per refresh: never one process per row or per item. Rows of one tree share one cached read, cleared on refresh.
- Every automatic trigger (timer, focus, file watcher) is debounced, skipped while the window is not focused, and backs off after a slow read (`vscode/src/refresher.ts`). Only a manual refresh is never delayed.
- Nothing heavy in `activate()`: no file scans, no process, no network; the first read is delayed.
- Watch narrow globs (`.git/HEAD`, not `**/*`); no synchronous file or process calls on a path that runs more than once.
- A change that adds a timer, a watcher or a spawned process says in the pull request how often it runs, and is checked with "AI Context Hub: Show Performance Report".

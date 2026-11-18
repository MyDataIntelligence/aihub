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

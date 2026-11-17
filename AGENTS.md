# Repository instructions

- `cli/` is the npm package `@ferronhooi/aihub` (TypeScript, Node >= 18, no runtime daemon). Run `npm test` in `cli/` after changes.
- `skills/` is the generic skill pack. Each skill is `skills/<name>/SKILL.md` with front matter `name` and `description: "Use when ..."`, written in concise English, 200-500 tokens, one worked example with the exact `aihub` command. Run `npm run lint:skills` in `cli/`.
- Team knowledge never goes into this repository: no organisation, project, repository or person names, no absolute paths. Examples use the synthetic project `ferron-test` / `test-project`.
- Prose for pull requests, stories and comments is passed to the CLI as files (`--body-file`, `--replies-file`), never inline.
- Keep each rule in one place; update existing files instead of duplicating.

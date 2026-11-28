---
name: wiki
description: "Use when a wiki page must be written or updated: 'update de wiki', 'schrijf de wikipagina', 'documenteer dit in de wiki', '/wiki'."
---
# Wiki page

## When
The user wants documentation in the project wiki, for a change or a story.

## Steps
1. Write the full new page content to a file, in the team language, based on the code and story. For an update, start from the current text: `aihub wiki update --page Team/Home --body-file page.md` prints it as a diff first.
2. Show the diff (a few lines) to the user.
3. After a yes, publish:

```sh
aihub wiki update --page Team/Home --body-file page.md --publish
```

Without `--publish` nothing is written. Use `--wiki <name>` when the project has more than one wiki.

Example: "werk de wiki bij met de nieuwe zoekfunctie" is a body file, the diff, a question, then the command with `--publish`.

## Pages from source files
When the user names pages (or a whole wiki) and repositories, folders or files to take the context from:

```sh
aihub wiki update start --project test-project --wiki test-project.wiki --path "/Runbooks/Order export" --sources-file sources.json
```

`sources.json` is `[{"project":"test-project","repo":"orders-ingest","path":"/docs"}]` (add `"local"` for a clone). Then follow the TASK.md in the answer's `dir`: edit the files under `pages/`, check with `aihub wiki update diff --id <id>`. Publish only after a yes per page: `aihub wiki update apply --id <id> --path "/Runbooks/Order export"`. A conflict means the page changed meanwhile: nothing was written.

## What the CLI fills
Wiki selection, page lookup, the page version (no overwrite of a newer edit), the diff and creation of a new page when it does not exist.

## If it fails
A version conflict means someone edited the page: run the command again without `--publish` and merge by hand. Run `aihub doctor` for access problems.

Rules: only change pages the user named. Put prose in a file, never inline.

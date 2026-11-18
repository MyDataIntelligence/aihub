---
name: pr-update
description: "Use when an open pull request needs new content: 'update de PR', 'werk de PR bij', 'voeg onder <sectie> toe', a dev.azure.com pullrequest link, '/pr-update'. The whole task is one command: aihub pr update --pr <url|N> --section \"<heading>\" --append-text \"<text>\"."
---
# Update a pull request

## When
Something must be added to or changed in an open PR description.

## Steps
To add or change ONE section run this single command. Never resend or rewrite the whole description:

```sh
aihub pr update --pr <url|N> --section "<heading>" --append-text "<short text>"
```

`--pr` takes the dev.azure.com link or the number (omit it for the PR of the current branch). Use `--replace-text` to replace the section, `--append-file f.md` / `--replace-file f.md` for long prose. Keep the team language.

Do not run `git status`, `aihub pr changes`, `--help` or read the template first. Do not ask questions.

Example: "voeg onder Testen toe: handmatig getest" with a link -> `aihub pr update --pr https://dev.azure.com/org/proj/_git/repo/pullrequest/42 --section "Testen" --append-text "Handmatig getest."`

## What the CLI fills
Reads the PR, edits only that section and keeps every other section byte for byte. New commits: `git push` first.

## If it fails
Run `aihub doctor`. Never invent ids or links.

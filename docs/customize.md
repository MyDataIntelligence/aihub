# Adapting aihub without forking

Where each kind of change goes:

| You want | Change | Where |
|---|---|---|
| Other branch names, templates, states, release groups, pipelines | team knowledge | `team.yaml` and the templates in your team repository ([team.yaml](team-yaml.md)); open a pull request there |
| Your own rules the agent must follow (coding guidelines, naming, review checklist) | repo guideline files | list them under `guidelines:` in `team.yaml` |
| An extra workflow only your team uses | team-specific skill | `.agents/skills/<name>/SKILL.md` in your repository |
| A better generic behaviour | the generic pack | pull request to the aihub repository (or your fork, see [self-hosting](self-hosting.md)) |

## Guidelines

```yaml
guidelines:
  - docs/CONTRIBUTING.md
  - docs/review-checklist.md
```

The generic skills tell the agent to read these files before writing code or text. `aihub doctor` reports a listed
file that does not exist.

## Team-specific skills

Put them in the repository under `.agents/skills/<name>/SKILL.md`. Clients read the repository skills next to the
global ones. Where a client supports precedence, a skill with the same name as a generic one wins in that repository;
because not every client does, give a team skill its own name (for example `team-pr-checklist`) unless you really
mean to replace the generic one. Keep team knowledge in these files, never in the generic pack.

## Editing installed skills

You may edit the installed copies. `aihub skills diff` shows your edits against the bundled pack, `aihub skills update`
never overwrites an edited file and lists it. If an edit is useful for everybody, turn it into a pull request.

## See what a command does

`aihub explain <command>` prints the steps. `--dry-run` on any write command prints the git commands and the REST
calls (method, URL, body summary) without doing them; `--verbose` logs the real calls to stderr.
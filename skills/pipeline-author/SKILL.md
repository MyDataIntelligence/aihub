---
name: pipeline-author
description: "Use when a pipeline must be written, changed, checked or understood: 'schrijf een pipeline', 'pas de YAML aan', 'waarom draait deze pipeline niet', 'valideer de pipeline', 'welke triggers heeft deze build'."
---
# Write and check a pipeline

## When
A YAML pipeline, template, trigger, schedule, environment or variable group is created or changed, or you must understand one.

## Steps
1. Look first: `aihub pipeline def show --pipeline <name>` and `aihub pipeline trigger show --pipeline <name>` (triggers, schedules, resources, parameters). Team conventions are under `pipelines:` in team.yaml (`validates`, `requiredTemplates`).
2. Edit the YAML in the repository. Patterns, conditions, templates and common errors: [azure-pipelines.md](references/azure-pipelines.md).
3. Check it before pushing, with Azure DevOps itself:

```sh
aihub pipeline validate --file ci/ci.yml          # exact errors, or the line count after template expansion
aihub pipeline expand --file ci/ci.yml            # the final YAML with templates resolved
```

4. A new pipeline: `aihub pipeline def create --name ci-<repo> --yaml ci/ci.yml`; let it use a stage or group: `aihub pipeline authorize --pipeline ci-<repo> --resource environment:dev`.
5. Push, then `aihub pipeline follow`. When red: `aihub pipeline timeline --run <id>` and `aihub pipeline tests --run <id>` (skill pipeline-fix).

Example: "voeg een testjob toe" -> read `pipeline def show`, add the job with the team template, `aihub pipeline validate --file ci/ci.yml`, commit, push, follow.

## What the CLI fills
Pipeline lookup by file, repository, branch and the team's required templates. Never ask the user for ids.

## If it fails
`validate` prints the server's line and column: fix that line, validate again. ACC and PRD environments, approvals and variable groups are not changed by the CLI (`--allow-env` only when the developer asked).

Rules: validate before every push of YAML. Secrets only through variable groups or Key Vault, never in YAML.

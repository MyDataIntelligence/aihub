# team.yaml

`team.yaml` holds everything the CLI needs to know about one team. It lives in the team repository at
`.agents/skills/_shared/references/team.yaml` and is created by `aihub init` (proposed as a pull request, never
overwriting an existing file). The generic pack never contains team knowledge.

The documented schema is [`skills/_shared/references/team.schema.yaml`](../skills/_shared/references/team.schema.yaml).
Templates are separate files next to it (stories, commits) or in the repo (`.azuredevops/pull_request_template.md`).

## Synthetic example

```yaml
version: 1
language: nl

azureDevOps:
  organization: ferron-test
  project: test-project

repositories:
  - name: test-project
    aliases: [tp]
    defaultTarget: main
    releaseBranches: ["release/*"]

pullRequest:
  template: .azuredevops/pull_request_template.md
  title: "{storyId}: {storyTitle}"
  emptySection: "Niet van toepassing"

workItems:
  storyType: User Story
  storyTemplate: .agents/skills/_shared/assets/story-template.md

branches:
  feature: "feature/{storyId}-{slug}"
  protected: [main, "release/*"]

cherryPick:
  groups:
    supported: ["release/1.2", "release/1.3"]

pipelines:
  - repository: test-project
    name: test-project-ci
    required: true
```

## Fields

| Key | Meaning |
|---|---|
| `language` | Language of generated stories, PR text and comments. |
| `azureDevOps` | Organization and project the CLI talks to. |
| `repositories[]` | Repository name, spoken aliases, default PR target and release branch patterns. |
| `pullRequest` | PR template path, title pattern and the text for empty sections. |
| `workItems` | Story type and story template. |
| `branches` | Feature branch pattern and protected branches. |
| `cherryPick.groups` | Named sets of target branches for `aihub cherry-pick --to <group>`. |
| `pipelines` | Pipelines to follow per repository. |

Check the file with `aihub doctor`. Change it through a pull request (see [onboarding](onboarding.md)).

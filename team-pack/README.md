# aihub team pack

The files a team keeps in its own repository: team settings, templates and a hook for your own guidelines. The generic
skills and the CLI stay outside the repository (`aihub skills install`).

Two ways to get them:

1. Run `aihub init` in the repository. It copies exactly these files (without overwriting anything), fills in the
   organization, project, repository and default branch from the git remote, and opens a pull request.
2. Copy these folders into the root of your repository yourself, adjust `team.yaml`, and open a pull request.

| File | What it is |
|---|---|
| `.agents/skills/_shared/references/team.yaml` | Team settings, every key explained. Replace the example values (`ferron-test`, `test-project`). |
| `.agents/skills/_shared/assets/story-template.md`, `commit-template.txt` | Story and commit templates in Dutch. |
| `.agents/skills/_shared/assets/*.en.*`, `.azuredevops/pull_request_template.en.md` | English variants: delete the Dutch file and remove `.en` from the name. `aihub init --language en` does this for you. |
| `.azuredevops/pull_request_template.md` | Pull request template (Dutch). Skip it if your repository already has one. |
| `.github/instructions/aihub.instructions.md`, `.github/guidelines/aihub.md` | Example hook for your own guidelines (GitHub Copilot instructions plus a guideline file listed under `guidelines:` in `team.yaml`). Only copied by hand; `aihub init` does not write them. |

After copying run `aihub doctor`. Change the files later through a pull request.
# Since green: what changed since the last green run

`aihub fabric failures` says what failed: the pipeline, the notebook, the cell and the likely cause. It does not say why it
failed now. Test, acceptance and production workspaces are filled by a CD pipeline and are not connected to git, so Fabric
does not know which commit runs there. Azure DevOps does: it is the commit of the newest run of the team's CD pipeline on the
environment's branch whose deploy stage succeeded. Two read-only commands put Fabric, Azure DevOps and git side by side.

| Question | Command |
|---|---|
| Which commit runs in this workspace? | `aihub fabric deployed --workspace "Fabric test-repo test"` (or `--env TST`) |
| Why did it fail now? | `aihub fabric failures --workspace "Fabric test-repo test" --since-green [--item pl_main]` |

Both need `fabric.environments.<ENV>` in team.yaml with `branch`, `workspace` (`{repo}` is the repository name) and
`deployedBy { pipeline, stage }`; see [team-yaml.md](team-yaml.md). A feature workspace is connected to git: there
`aihub fabric git status --workspace W` gives the commit.

## How it works

1. **The deployed commit.** The CD pipeline definition (`deployedBy.pipeline`, a name or id) and its newest 30 runs on
   `refs/heads/<branch>`. The timeline of each run says whether the Stage record named `deployedBy.stage` succeeded and when
   it finished; the first such run is the deployment. Its `sourceVersion` is the commit. The pull requests come from the
   merge-commit query, the stories from the pull request's work items, other repositories from
   `pipelines/{id}/runs/{run}` (`resources.repositories.<alias>.version`).
2. **The window.** From the job list `failures` already reads: the failed run (its start) and the newest run of the same
   item that succeeded and ended before it started (its end).
3. **Deployments in the window.** CD runs whose deploy stage finished after the green run ended and before the red run
   started. The deployment live during the green run gives the commit `before`, the one live at the red run the commit `after`.
   Runs queued after the red run started are not read.
4. **What changed.** The commits in `after` and not in `before` (at most 50, said when capped) and the files of each commit,
   mapped to Fabric item folders `<name>.<Type>/`; other paths stay as they are. Commits are grouped by pull request: the
   merge commit and, for a merge without fast-forward, the branch commits it brought in (the completed pull request that
   contains them).
5. **Other repositories** of the two runs: per alias `unchanged` or `a -> b`, or "not available" when the API does not return them.
6. **Rank.** A pull request (or a commit without one) is a suspect when it touches (a) the failed item or the failing item of
   the root-cause chain, (b) an item the failed pipeline calls (the caller knowledge of `aihub fabric plan`, read from the
   local clone; skipped without one), or (c) a configuration file whose base name equals the failed item's name, e.g.
   `jobs/pl_main.yaml`. Suspects come first with the reason and the touched path; the rest is one line each.

## Outcomes

| `outcome` | Meaning |
|---|---|
| `suspects` | Deployed in the window and touching the failed item, something it calls or its configuration. The last line is the next step, e.g. `aihub pr explain --pr 412`. |
| `deployedUnrelated` | Deployed in the window, but nothing touches this item. |
| `nothingDeployed` | Nothing was deployed between green and red: the cause is outside the code (source data, capacity, an upstream that was not ready); the likely-cause category of `failures` is repeated. |
| `noGreenRun` | The item never succeeded in the history Fabric returns. |
| `notConfigured` | The workspace has no environment, or the environment no `deployedBy`; the missing team.yaml lines are printed. |
| `unavailable` | A read failed (no access, not signed in, pipeline not found); the reason is one sentence in `notes`. |

## Limits

- Changes made by hand in the Fabric portal are not in git and are invisible.
- Changed data or source files are invisible.
- The history is bounded: Fabric keeps a limited job history, and only the newest 30 CD runs are looked at; when they do not
  reach back to the green run the output says so.
- Other-repository versions (for example a central template repository) are shown only when Azure DevOps returns them per run.
- The commits between the two deployed commits come from the Azure DevOps commit search. A right answer holds the commit of
  the red run itself, so the command checks that, swaps the two versions once when it does not, and adds a note when
  neither answer holds it.
- Ranking is a match on paths and names. The result is a list of suspects, not proof.

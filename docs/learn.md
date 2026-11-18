# Learn: understand a change or a repository

Learn is personal and visual. The CLI gives **facts**, the `learn` skill writes the **lesson**, a view shows it (the VS Code view comes in a later slice). Nothing is stored in a repository, and nothing is run: Learn never executes code.

## Slice 1 (this version)

| Command | Gives |
|---|---|
| `aihub learn change [--pr N\|url] [--branch B] [--range a..b] [--json]` | the commits, files, hunks, the changed function and class names, where they are used (callers), the tests that mention them and the dbt lineage of changed models |
| `aihub learn repo [--json]` | languages, folders, entry points, test folders, pipelines, the dbt graph (models, `ref()` edges, sources) |
| `aihub learn validate --file explanation.json [--facts facts.json]` | checks a written explanation against the schema; with `--facts` it warns about files that are not part of the change |

Facts come from git and the working files in about a second; Azure DevOps is asked only for `--pr`, to find the two branches. The impact is a text search (`git grep` of the changed names), not a call graph: a hit can be another thing with the same name and dynamic calls are missed. The facts say so in `notes`.

`/leer [PR, branch or repository]` loads the skill: facts first, then `explanation.json`, validated, then the lesson with the pictures. The schema is the port of the old EXPLANATION.json (`references/schema.md` in the skill): one sentence, before and after, Mermaid diagrams, design choices with alternatives, tell-a-colleague, risks, quiz, concepts and the reason per changed piece. Pictures first: before/after, flow, architecture (callers), lineage (dbt).

## Slice 2: your lessons, the lesson page and the tour

| Command | Does |
|---|---|
| `aihub learn save --file explanation.json [--facts facts.json]` | validates, then keeps the lesson in `~/.config/aihub/learn` (`AIHUB_LEARN_HOME` or `XDG_CONFIG_HOME` move it); an invalid explanation saves nothing |
| `aihub learn list [--all]`, `show --id`, `forget --id` | your lessons for this repository (or all), one lesson as JSON, remove one |
| `aihub learn concepts [--mark NAME\|--unmark NAME]` | every concept of your lessons once, and which you marked as learned |
| `aihub learn quiz [--id ID] [--score ID --correct N --of M]` | the questions of a lesson; keeps a score |

The store is yours alone: nothing is written into a repository and nothing is shared with the team. Lessons of other repositories are listed only with `--all`.

In VS Code the **Learn** view (Explorer) lists your lessons and concepts. A lesson opens as one page: the one-sentence summary, then the pictures (Mermaid, drawn by the bundled mermaid, no network), what changed and why with links to the files, who is affected, design choices, risks, a quiz you can click through, and concepts you can mark as learned. **Guided tour** walks through the changed pieces: it opens each file at the line, highlights it and shows the reason with Previous, Next and Stop. Reading only; lessons are written by `/leer`.

## Later slices

`learn diagram` (Mermaid by default, iDiagram optional), `learn flow|glossary|week|onboarding`, and the learner profile. The store is per user only; there is no team-shared store.

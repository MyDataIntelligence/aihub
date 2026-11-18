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

## Slices 3 and 4: pictures and orientation

| Command | Gives |
|---|---|
| `aihub learn diagram [--kind architecture\|lineage\|repo\|flow] [--pr\|--branch\|--range] [--json]` | a Mermaid picture built from facts: who calls the changed names and which tests mention them, dbt lineage (of the change, or of the whole repository), the folders, the team flow. `basedOn` says what it was built from; `empty` is true when nothing was found and then nothing is drawn |
| `--idiagram` | pushes a flowchart to iDiagram (your own app, default `https://idiagram.vercel.app`, `AIHUB_IDIAGRAM_URL` for another) with a story of scenes (the whole flow, then one scene per changed block) and returns the board link and the Play story link; a port of the legacy client. Only the Mermaid and the scenes are sent. A failure is a result and the Mermaid stays |
| `aihub learn diagram --board board.json [--story story.json]` | the rich path of the legacy client: `POST /boards/build` with an iDiagram board spec (nodes with columns and sample rows, relations) and a story with narration and data; returns the links and the board as Mermaid. Examples in the skill's `references/` |
| `aihub learn level [set junior\|medior\|senior]` | your level: the style the skill writes in (junior: every term and analogies; senior: brief) |
| `aihub learn after-pr [on\|off]` | off by default; when on (or `learn: afterPr: true` in team.yaml) `pr create` and `story finish` end with one line: "Wil je een les van deze wijziging?" |
| `aihub learn flow` | how the team works (story, branch, commits, PR, pipeline, review, merge) from `team.yaml`; generic when there is none |
| `aihub learn glossary` | the repository's own terms: README bullets and headings, dbt models and sources, folders |
| `aihub learn week [--days N]` | your commits and most touched files |
| `aihub learn onboarding` | repository facts, flow, terms and pictures in one bundle |
| `aihub learn item <path>` | one file (definitions, imports, users), a pipeline yaml (stages, jobs, steps), a dbt model (lineage) or a Fabric item folder from git integration |

All of it comes from git and files; Azure DevOps and Fabric are not called. Paste a diagram's `mermaid` into `diagrams` of an explanation and it is drawn on the lesson page.

## Later slices

the learner profile . The store is per user only; there is no team-shared store.

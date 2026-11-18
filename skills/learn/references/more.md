# More facts and pictures (all from git and files)

- `aihub learn diagram --kind architecture|lineage|repo|flow [--pr|--branch|--range] --json`: a Mermaid picture and what it is based on. Paste the `mermaid` into `diagrams` of the explanation. `empty: true` means nothing was found: say so, do not draw anything. `--idiagram` only reports whether iDiagram is configured; Mermaid is complete without it.
- `aihub learn flow`: how the team works (story, branch, PR, pipeline, review, merge) from `team.yaml`.
- `aihub learn glossary`: the repository's own terms; explain the rest, marked `niet geverifieerd`.
- `aihub learn week [--days N]`: your commits and most touched files.
- `aihub learn onboarding`: repository, flow, terms and pictures in one JSON for a welcome lesson.
- `aihub learn item <path>`: one file (definitions, imports, who uses it), pipeline yaml (stages, jobs), dbt model (lineage) or Fabric item folder.
- `--idiagram` on `learn diagram` pushes a flowchart to iDiagram (the user's own app, no key) with a story of scenes and returns `url` and `playUrl`: put them in the diagram as `idiagramUrl` and `playUrl`; the lesson page then shows "Play story". Only Mermaid and the scenes are sent. A `failed` status is fine: the Mermaid stays.
- `aihub learn level [set junior|medior|senior]` and `aihub learn after-pr [on|off]`: the level sets the lesson's style; after-pr (off by default, `learn.afterPr` in team.yaml sets the team default) makes `pr create` and `story finish` end with one line offering `/leer`.

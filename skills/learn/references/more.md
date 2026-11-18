# More facts and pictures (all from git and files)

- `aihub learn diagram --kind architecture|lineage|repo|flow [--pr|--branch|--range] --json`: a Mermaid picture and what it is based on. Paste the `mermaid` into `diagrams` of the explanation. `empty: true` means nothing was found: say so, do not draw anything. `--idiagram` only reports whether iDiagram is configured; Mermaid is complete without it.
- `aihub learn flow`: how the team works (story, branch, PR, pipeline, review, merge) from `team.yaml`.
- `aihub learn glossary`: the repository's own terms; explain the rest, marked `niet geverifieerd`.
- `aihub learn week [--days N]`: your commits and most touched files.
- `aihub learn onboarding`: repository, flow, terms and pictures in one JSON for a welcome lesson.
- `aihub learn item <path>`: one file (definitions, imports, who uses it), pipeline yaml (stages, jobs), dbt model (lineage) or Fabric item folder.

# Cross-repo reference

## Commands

| Command | Does |
|---|---|
| `aihub port --from-repo A --from <pr N\|sha,...\|story N> --to-repo B [--to-branch T] [--path-map "src=>dst" ...\|--map NAME] [--strict] [--pr [--body-file F]] [--json]` | Takes the diff of the source in repo A, rewrites the paths, applies it commit by commit in a temporary worktree of repo B on `port/<source>-from-<A>` (detached; no local branch is left), commits with a message that names the source, pushes, and with `--pr` creates the PR per B's template (story and source PR linked). A story source means its merged PRs in A. |
| `aihub crossrepo status --story N [--json]` | Per repo of the story: branch, ahead/behind, PR status, latest pipeline runs. |
| `aihub crossrepo link-prs --story N [--pr repo!42 ...]` | Writes the section "Gerelateerde PR's" (language `nl`) or "Related PRs" in every PR of the story with links to the others; replaces an existing section. `--pr` adds a PR that is not yet linked and links it to the story. |
| `aihub crossrepo test-resources [--from-repo A] [--to-repo B] [--target BRANCH] [--paths GLOB,...] [--to-path DIR] [--message-file F] [--run-pipeline NAME] [--no-follow]` | Copies the files of repo A that match the globs (tracked, or untracked and not ignored: generated files count) into B's branch in a temporary worktree, commits and pushes there. Then queues the pipeline and follows it. A protected target is refused. |

## Path maps

`src=>dst` rewrites a directory prefix; the longest source prefix wins; `.` is the repository root. Without any map paths stay the same. Files outside every map are reported under "not ported"; `--strict` refuses instead of porting the rest.

## Locating repositories

Repo names and aliases come from `repositories[]`. Order: the current clone, the entry's `path`, a sibling directory whose origin is that repository, else a temporary clone of the same organisation and project (removed afterwards).

## Results

`ok`, `already-applied` (the target contains the change), `nothing-to-port` (no file inside the map), `conflict` (files named, nothing pushed), `refused`, `failed`. `--json` prints the same as one object with `files` and `unmapped`.

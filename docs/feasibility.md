# Feasibility mode: "can this be done?"

`/kan-dit <question>` (or `/can-it`) loads the `feasibility` skill. The agent restates the question, researches it, and answers with one fixed report. It never answers from memory.

## What it does

1. **Docs**: Microsoft Learn, the REST reference, release notes and roadmap, known limits.
2. **Community**: GitHub issues, Microsoft Q&A, Stack Overflow, Reddit, each with its date.
3. **Live probes** against your own tenant, read-only (below).
4. **Proof of concept** only after one yes, in an `aihub-test-dev-*` Fabric workspace or synthetic Azure DevOps objects, cleaned up afterwards.

Clients with subagents (opencode, Claude Code, Copilot, Codex) let `aihub-researcher` take one angle each in parallel; other clients do them one after the other.

## The report (team language)

**Verdict** (Ja / Nee / Deels, with workaround) - **Hoe** - **Bewijs** (probe output, PoC) - **Bronnen** (link and date) - **Grenzen en risico's** - **Inschatting inspanning** - **Open vragen**. Anything without a source or a probe is marked `niet geverifieerd`.

## `aihub probe`

Read-only; one GET each. Output is `YES`, `NO` or `UNKNOWN` plus the raw status and the **shape** of the answer (keys, item count). Item contents are never shown, so a probe cannot leak data from ACC or PRD.

| Command | Asks |
|---|---|
| `aihub probe fabric endpoint /workspaces/{workspace}/copyJobs --workspace W` | does this REST path exist for me |
| `aihub probe fabric capacity [--feature spark\|notebooks\|copyjob\|mirroring\|graphql\|variablelibrary\|pipelines\|lakehouse\|warehouse\|eventstream\|gitintegration]` | SKU, region and state of your capacities, and whether the item type exists in a workspace |
| `aihub probe devops feature pipelines\|builds\|releases\|environments\|wiki\|boards\|testplans\|policy\|variablegroups\|serviceconnections\|identity` | is the feature on for this project |
| `aihub probe api --get <url>` | Fabric and Azure DevOps URLs with your sign-in (shape only); `learn.microsoft.com`, GitHub hosts as a text excerpt |

404 is NO. 403, 400 and 5xx are UNKNOWN: they say the feature may exist but not for you, never that it is impossible. `--json` prints the structured result.

## Keeping a report

`aihub research save --file report.md` copies it to `<git dir>/aihub/research/<date>-<title>.md` (never committed). `--wiki <page>` also publishes it as a wiki page; ask the user first.

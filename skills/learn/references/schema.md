# explanation.json (kind "change-explanation")

Required: `kind` "change-explanation", `oneSentence`, `before`, `after` (plain sentences), `diagram` { `before`, `after` } (Mermaid text), `designChoices` [{ `choice`, `alternatives` [{ `option`, `whyNot` }] }], `tellAColleague` (at least 2 sentences), `hunkReasons` [{ `path`, `line` (0 if none), `reason` }].

Optional: `diagrams` [{ `title`, `kind` before-after|flow|architecture|lineage|sequence, `mermaid` }], `risks` [text], `quiz` [{ `question`, `options` (2-5), `answerIndex`, `explanation` }], `concepts` [{ `name`, `eli5`, `exampleFromThisChange` }]. A hunk reason may also carry `before`, `how`, `withoutIt`, `pattern`, `whenToUse`, `watchOut`, `analogy`, `askYourself` { `question`, `answer` }, `findings` [{ `severity` blocker|major|minor|info, `text`, `suggestion` }], `purpose`, `relatesTo`, `effect`, `narration`.

Mermaid: start with `flowchart LR`, `flowchart TD`, `sequenceDiagram`, `erDiagram`, ...; short node labels; no code fences; at most 4000 characters; mark what changed with `:::changed`.

Pictures to make: before/after of the logic; a flow of the new path; architecture (who calls the changed code, from the facts' callers); dbt lineage (from the facts' dbt models: upstream, downstream, sources). `tryIt` is not used.

---
name: voice-notes
description: "Use when the user gives a transcript of a voice recording or meeting notes: 'verwerk mijn opname', 'hier is het transcript', 'maak stories van deze notities', a .txt/.md/.srt/.vtt file."
---
# Voice notes to stories

## When
The input is text (a transcript or pasted notes). An audio file: say it must be transcribed first and stop.

## Steps
1. Read the whole transcript. Split it into items and classify each: new story, change to an existing story, follow-up task, remark, or noise.
2. Show the list in one short table (item, kind, story id, one line). Ask once: "create these?" Unclear items go on the list as open points, not as stories.
3. After a yes, per new story write a body file from the story template and run:

```sh
aihub story create --title "Export to CSV" --body-file story-1.md
```

4. Changes to an existing story: follow story-refine. Remarks and follow-ups: add them as a comment on the story.
5. Report the created ids and links.

Example: a transcript with two requests becomes two `aihub story create` calls after one confirmation.

## What the CLI fills
Template sections, work item type, links and area. Do not invent them.

## If it fails
Run `aihub doctor`. Nothing is created when the user says no. Never invent ids, names or requirements that are not in the transcript.

Rules: story text in the team language; personal remarks about people never go into stories.

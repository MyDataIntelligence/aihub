---
name: evidence
description: "Use when screenshots or images must go into a pull request as proof: 'zet dit screenshot in de PR', 'voeg bewijs toe', 'attach the screenshot to PR 42'."
---
# Evidence in a pull request

## When
A change has a visible result (a screen, a pipeline run, a report) and the user has or wants an image as proof.

## Steps
1. Ask for the image only if the user has not given a path. Capturing it is the user's step or your own screenshot tool.
2. Attach it:

```sh
aihub evidence add --pr 42 --file shot.png --caption "Search result with two hits"
```

3. Repeat per image. Report the section it was added to.

Example: "zet shot.png in PR 42" is `aihub evidence add --pr 42 --file shot.png`.

## What the CLI fills
Upload as PR attachment, and a markdown image link appended to the screenshots/evidence section of the PR description (else the tests section, else a new Evidence section). Existing text stays.

## If it fails
Only png, jpg, gif, webp and bmp up to 20 MB are accepted: say which rule failed. Run `aihub doctor` for access problems.

Rules: only synthetic or non-sensitive screens; check that no secrets or personal data are visible before attaching. Captions in the team language.

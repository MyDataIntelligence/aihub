import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeMeta, readSetFile } from "../src/lib/setFile.js";
import { findSet } from "../src/lib/setInfo.js";

describe("a set file in an older or hand-written form is read as a set (never #[object Object] or 'on undefined')", () => {
  it("story as { id, title } becomes the number and the title; a missing branch is the first repository's", () => {
    const folder = mkdtempSync(join(tmpdir(), "aihub-old-set-"));
    for (const r of ["repo-a", "repo-b"]) mkdirSync(join(folder, r), { recursive: true });
    writeFileSync(join(folder, ".aihub-set.json"), JSON.stringify({ story: { id: 4711, title: "Orderexport" }, repos: [{ name: "repo-a", source: join(folder, "src", "repo-a"), branch: "feature/4711-orderexport" }, { name: "repo-b", source: join(folder, "src", "repo-b") }] }));
    const top = readSetFile(folder)!.top;
    expect(top.story).toBe(4711);
    expect(top.storyTitle).toBe("Orderexport");
    expect(top.branch).toBe("feature/4711-orderexport");
    expect(findSet(join(folder, "repo-a"))?.story).toBe(4711);
    expect(findSet(join(folder, "repo-a"))?.storyTitle).toBe("Orderexport");
  });

  it("other forms: a story as text, no story, nothing to take the branch from", () => {
    expect(normalizeMeta({ story: "12" as never, branch: "b", repos: [] }).story).toBe(12);
    expect(normalizeMeta({ story: undefined as never, branch: "b", repos: [] }).story).toBe(0);
    expect(normalizeMeta({ story: { id: "x" } as never, branch: undefined as never, repos: [] })).toMatchObject({ story: 0, branch: "" });
    // a title that is there already stays
    expect(normalizeMeta({ story: { id: 5, title: "new" } as never, storyTitle: "kept", branch: "b", repos: [] }).storyTitle).toBe("kept");
  });
});

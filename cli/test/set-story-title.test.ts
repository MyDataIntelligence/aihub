import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSet } from "../src/lib/setInfo.js";
import { writeSetFile } from "../src/lib/setFile.js";

describe("the story title of a set", () => {
  it("findSet gives the title the set file keeps, so the status bar shows it when the work item cannot be read", () => {
    const folder = mkdtempSync(join(tmpdir(), "aihub-set-title-"));
    const repo = join(folder, "repo-a");
    mkdirSync(repo, { recursive: true });
    writeSetFile(folder, "aihub", { story: 3748, storyTitle: "Klantportaal vijf repos", branch: "feature/3748-klantportaal", repos: [{ name: "repo-a", source: repo, path: repo }] } as never);
    expect(findSet(repo)?.storyTitle).toBe("Klantportaal vijf repos");
    expect(findSet(repo)?.story).toBe(3748);
  });

  it("status takes that title when Azure DevOps does not answer, and keeps \"(unknown)\" only when the set file has none", () => {
    const src = require("node:fs").readFileSync(join(__dirname, "../src/lib/status.ts"), "utf8") as string;
    expect(src).toMatch(/const setTitle = storyId && !wi\?\.title \? findSet\(ctx\.cwd\)\?\.storyTitle : undefined;/);
    expect(src).toContain('title: wi?.title ?? (setTitle || "(unknown)")');
  });
});

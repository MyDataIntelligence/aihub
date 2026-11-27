import { describe, expect, it } from "vitest";
import { slugify } from "../src/lib/slug.js";
import { slugify as fromWorkitems } from "../src/lib/workitems.js";
import { storyFolderFor, variantOf } from "../src/lib/storyWorktrees.js";

describe("the slug of a story title (branch and folder)", () => {
  it("ß is ss, accents are dropped, signs become one dash, nothing at the ends", () => {
    expect(slugify("Straße/Übung: 50% & meer?")).toBe("strasse-ubung-50-meer");
    expect(slugify("GROSSE ẞ")).toBe("grosse-ss");
    expect(slugify("Café é: a & b/c")).toBe("cafe-e-a-b-c");
    expect(slugify("[haak] titel")).toBe("haak-titel");
  });

  it("no title, or only signs or other scripts: 'story', never empty", () => {
    expect(slugify("")).toBe("story");
    expect(slugify("日本語")).toBe("story");
    expect(slugify("!!!")).toBe("story");
  });

  it("one rule: workitems re-exports the same function", () => {
    expect(fromWorkitems).toBe(slugify);
  });

  it("the folder of the set follows the branch: <id>-story, not <id>-<id>", () => {
    expect(variantOf("feature/3747-story", 3747)).toBe("story");
    expect(storyFolderFor({ root: "C:\\w", storyId: 3747, branch: "feature/3747-story", storyFolders: [] })).toBe("C:\\w\\3747-story");
    expect(storyFolderFor({ root: "C:\\w", storyId: 3751, branch: "feature/3751-gewone-titel", storyFolders: [] })).toBe("C:\\w\\3751-gewone-titel");
  });
});

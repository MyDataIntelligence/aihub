import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSetFile, stampStoryTitle, writeAtomic, writeSetFile, writeSetMeta } from "../src/lib/setFile.js";
import { tmp } from "./helpers.js";

const meta = { story: 7, branch: "feature/7-a", repos: [{ name: "repo-a", source: "C:/x/repo-a", path: "C:/x/s/repo-a" }] };

describe("set files are written as a whole", () => {
  it("writeAtomic replaces the file and leaves no temporary file", () => {
    const dir = tmp("aihub-atomic-");
    const p = join(dir, "a.json");
    writeFileSync(p, "old");
    writeAtomic(p, "new");
    expect(readFileSync(p, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });

  it("every writer of a set file goes through writeAtomic (no .tmp left behind, both formats)", () => {
    const dir = tmp("aihub-atomic-");
    writeSetMeta(dir, meta);
    writeSetMeta(dir, { ...meta, branch: "feature/7-b" });
    stampStoryTitle(dir, 7, "Zoekfunctie");
    const maker = tmp("aihub-atomic-");
    writeFileSync(join(maker, ".worktree-set.json"), JSON.stringify({ schemaVersion: 1, branch: "feature/7-a", slug: "feature-7-a", repos: meta.repos }));
    writeSetFile(maker, "maker", { ...readSetFile(maker)!.top, repos: [...meta.repos, { name: "repo-b", source: "C:/x/repo-b", path: "C:/x/s/repo-b" }] });
    for (const d of [dir, maker]) expect(readdirSync(d).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readSetFile(dir)!.top.storyTitle).toBe("Zoekfunctie");
    expect(readSetFile(maker)!.top.repos).toHaveLength(2);
  });

  it("no code writes a set file in place any more", () => {
    const src = (f: string) => readFileSync(join(__dirname, "..", "src", "lib", f), "utf8");
    // writeSetFile / writeSetMeta / stampStoryTitle / createSet / removeSet: the only writeFileSync on a set file is inside writeAtomic
    expect(src("worktree.ts")).not.toMatch(/writeFileSync\(metaPath/);
    const set = src("setFile.ts");
    expect(set.match(/writeFileSync\(p,/g) ?? []).toHaveLength(0);
  });
});

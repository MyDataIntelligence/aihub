import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/commands/dbt.js";
import { normalizedCopy, normalizeText } from "../src/lib/dbt-eol.js";
import { fakeDbt, manifestJson, PROJECT_FILES, put } from "./dbt-helpers.js";
import { makeRepo, sh, tmp, write } from "./helpers.js";

describe("line endings in a state comparison", () => {
  it("normalizeText: CRLF and trailing whitespace become the LF text of the blob", () => {
    expect(normalizeText("select 1  \r\nfrom t\t\r\n")).toBe("select 1\nfrom t\n");
  });

  it("normalizedCopy rewrites text files, leaves binaries and dbt_packages alone, skips target and .git", () => {
    const src = tmp("aihub-eol-");
    write(src, "models/a.sql", "select 1  \r\n");
    write(src, "dbt_packages/p/m.sql", "select 2\r\n");
    write(src, "target/manifest.json", "{}");
    write(src, "seeds/x.bin", "a\r\nb");
    const dst = join(tmp("aihub-eol-"), "copy");
    normalizedCopy(src, dst);
    expect(readFileSync(join(dst, "models/a.sql"), "utf8")).toBe("select 1\n");
    expect(readFileSync(join(dst, "dbt_packages/p/m.sql"), "utf8")).toBe("select 2\r\n");
    expect(readFileSync(join(dst, "seeds/x.bin"), "utf8")).toBe("a\r\nb");
    expect(existsSync(join(dst, "target"))).toBe(false);
  });

  it("--state auto parses the base and runs ls from LF copies although the working files are CRLF", async () => {
    const { dir } = makeRepo();
    for (const [f, c] of Object.entries(PROJECT_FILES)) write(dir, `dbt/${f}`, c);
    write(dir, ".gitignore", "target/\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "dbt project"]);
    sh(dir, ["push", "origin", "main"]);
    sh(dir, ["checkout", "-b", "feature/x"]);
    // the working tree as autocrlf=true leaves it: CRLF everywhere, trailing spaces after an edit
    for (const f of ["models/staging/stg_orders.sql", "models/marts/mart_orders.sql"]) writeFileSync(join(dir, "dbt", f), `${PROJECT_FILES[f].trimEnd()}  \r\n`.replace(/\n(?!$)/g, "\r\n"));
    writeFileSync(join(dir, "dbt/models/staging/stg_orders.sql"), "select 1 as order_id, 1 as customer_id\r\n");
    put(dir, "dbt/target/manifest.json", JSON.stringify(manifestJson()));
    const seen: { verb: string; projectDir: string; text: string; state?: string }[] = [];
    const { ctx, lines } = fakeDbt(dir, (args) => {
      const pd = args[args.indexOf("--project-dir") + 1];
      if (args[0] === "parse" && args.includes("--target-path")) {
        mkdirSync(args[args.indexOf("--target-path") + 1], { recursive: true });
        seen.push({ verb: "parse", projectDir: pd, text: readFileSync(join(pd, "models/staging/stg_orders.sql"), "utf8") });
      }
      if (args[0] === "ls") {
        seen.push({ verb: "ls", projectDir: pd, text: readFileSync(join(pd, "models/marts/mart_orders.sql"), "utf8"), state: args[args.indexOf("--state") + 1] });
        return { stdout: `noise\n${JSON.stringify({ unique_id: "model.shop.stg_orders" })}\n` };
      }
    });
    await run(["impact", "--base", "main", "--state", "auto", "--project", join(dir, "dbt"), "--json"], ctx);
    expect(seen.map((s) => s.verb)).toEqual(["parse", "ls", "ls"]);
    for (const s of seen) {
      expect(s.text).not.toContain("\r");
      expect(s.text).not.toMatch(/[ \t]\n/);
      expect(s.projectDir).not.toBe(join(dir, "dbt"));
    }
    expect(JSON.parse(lines.join("")).mode).toBe("state");
    sh(dir, ["worktree", "prune"]);
    expect(sh(dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
  });
});

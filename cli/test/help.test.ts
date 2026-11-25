import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { entries, formatHelp, HELP_MAX_BYTES, subsOf, suggest, USAGES } from "../src/lib/help.js";

function ctx() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, ctx: { cwd: ".", env: {}, fetch: fetch, out: (l: string) => out.push(l), err: (l: string) => err.push(l) } as never };
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("aihub <command> [<sub>] --help", () => {
  it("answers for every command and every subcommand, each under 600 bytes (fabric prints its own)", async () => {
    const names = Object.keys(commands).filter((c) => c !== "fabric");
    expect(names.filter((n) => !USAGES[n])).toEqual([]);
    expect(USAGES.fabric).toBeUndefined();
    for (const name of names) {
      const top = ctx();
      expect(await main([name, "--help"], top.ctx)).toBe(0);
      expect(top.err).toEqual([]);
      expect(bytes(top.out.join("\n")), name).toBeLessThanOrEqual(HELP_MAX_BYTES);
      for (const sub of subsOf(name, await USAGES[name]())) {
        const one = ctx();
        expect(await main([name, sub, "-h"], one.ctx), `${name} ${sub}`).toBe(0);
        expect(bytes(one.out.join("\n")), `${name} ${sub}`).toBeLessThanOrEqual(HELP_MAX_BYTES);
        expect(one.out.join("\n"), `${name} ${sub}`).toContain(`aihub ${name} `);
      }
    }
  });

  it("init --help is the usage, not 'Unknown option'; a sub shows only its own lines", async () => {
    const a = ctx();
    expect(await main(["init", "--help"], a.ctx)).toBe(0);
    expect(a.out.join("\n")).toMatch(/^aihub init \[--repo \.\]/);
    const b = ctx();
    await main(["story", "refine", "--help"], b.ctx);
    expect(b.out.join("\n")).toBe("aihub story refine --id <n> --body-file story.md");
    const c = ctx();
    await main(["pr", "tests", "--help"], c.ctx);
    expect(c.out.join("\n")).toContain("--from-run <build> | --from-robot <build>");
  });

  it("an unknown command or subcommand gets at most three suggestions, not the list of all", async () => {
    const a = ctx();
    expect(await main(["wrkitem"], a.ctx)).toBe(2);
    expect(a.err).toEqual(["aihub: unknown command 'wrkitem'; did you mean: workitem? (aihub --help lists them all)"]);
    const b = ctx();
    expect(await main(["story", "refin"], b.ctx)).toBe(1);
    expect(b.err.join("\n")).toBe("aihub: unknown subcommand 'refin' of aihub story; did you mean: refine?\nusage: aihub story refine --id <n> --body-file story.md");
    const c = ctx();
    await main(["pr", "creat", "--help"], c.ctx);
    expect(c.out[0]).toContain("no subcommand 'creat'; did you mean: create?");
  });

  it("a parse error shows the one usage line of its subcommand", async () => {
    const a = ctx();
    expect(await main(["pr", "update", "--sectoin", "x"], a.ctx)).toBe(1);
    expect(a.err.join("\n")).toBe(
      "aihub: Unknown option '--sectoin'\nusage: aihub pr update [--pr <url|N>] --section \"<heading>\" (--append-text \"<text>\" | --append-file f | --replace-text \"<text>\" | --replace-file f)",
    );
  });
});

describe("help helpers (also for fabric)", () => {
  it("formatHelp: one sub, or the whole text when short, else the names and the example", () => {
    const usage = "aihub x run --id N | list [--json]\n    lists them\naihub x show --id N";
    expect(entries("x", usage).map((e) => e.subs[0])).toEqual(["run", "list", "show"]);
    expect(formatHelp("x", usage, { sub: "list" })).toBe("aihub x list [--json]\n    lists them");
    expect(formatHelp("x", usage, { sub: "nope" })).toBeUndefined();
    expect(formatHelp("x", usage, { example: "aihub x run --id 1" })).toBe("aihub x run --id N\naihub x list [--json]\n    lists them\naihub x show --id N\nexample: aihub x run --id 1");
    const long = Array.from({ length: 30 }, (_, i) => `aihub x sub${i} --flag-with-a-long-name <value> --another-flag <value>   explanation`).join("\n");
    expect(formatHelp("x", long)).toMatch(/^aihub x <sub0\|sub1\|/);
    expect(bytes(formatHelp("x", long)!)).toBeLessThanOrEqual(HELP_MAX_BYTES);
  });

  it("suggest: prefix, contained or close names, at most three", () => {
    expect(suggest("refin", ["show", "create", "refine", "template"])).toEqual(["refine"]);
    expect(suggest("wrkitem", Object.keys(commands))).toEqual(["workitem"]);
    expect(suggest("p", ["pr", "pipeline", "policy", "port", "probe"]).length).toBe(3);
    expect(suggest("zzz", ["pr", "story"])).toEqual([]);
  });
});

describe("--json is one line", () => {
  it("no command prints pretty-printed JSON to stdout (fabric excepted, it has its own owner)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = join(__dirname, "..", "src");
    const files = ["commands", "lib"].flatMap((d) => readdirSync(join(src, d)).filter((f) => f.endsWith(".ts") && !f.startsWith("fabric")).map((f) => join(src, d, f)));
    const pretty = files.filter((f) => /\bout\([^;]*JSON\.stringify\([^;]*,\s*(null|undefined),\s*\d\)/.test(readFileSync(f, "utf8")));
    expect(pretty).toEqual([]);
  });
});

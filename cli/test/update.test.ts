import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changelogSince } from "../src/lib/update.js";
import { isGitWrite } from "../src/lib/trace.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write } from "./helpers.js";

const NAME = "@ferronhooi/aihub";

function setup() {
  const h = tmp("aihub-home-");
  const env: NodeJS.ProcessEnv = { HOME: h, USERPROFILE: h };
  return { h, env };
}

interface Fake {
  calls: string[];
  exec: (cmd: string, args: string[]) => string;
}
function fakeExec(handlers: Record<string, (args: string[]) => string>): Fake {
  const calls: string[] = [];
  return {
    calls,
    exec: (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      const key = Object.keys(handlers).find((k) => `${cmd} ${args.join(" ")}`.startsWith(k));
      if (!key) throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
      return handlers[key](args);
    },
  };
}

async function run(args: string[], env: NodeJS.ProcessEnv, fake?: Fake, extra: Record<string, unknown> = {}, cwd = tmp()) {
  const { ctx, lines, errs } = ctxFor(cwd, fakeFetch([]).fn);
  ctx.env = env;
  if (fake) ctx.exec = fake.exec as any;
  Object.assign(ctx, extra);
  const code = await main(args, ctx);
  return { code, lines, errs, out: lines.join("\n") };
}

describe("aihub update --check", () => {
  it("reports versions and the registry from the user's .npmrc, and changes nothing", async () => {
    const { env } = setup();
    const rc = join(tmp(), ".npmrc");
    writeFileSync(rc, "registry=https://pkgs.example.test/_packaging/team/npm/registry/\n", "utf8");
    const fake = fakeExec({
      // the real npm reads the custom .npmrc; no registry URL is hard-coded anywhere in aihub
      "npm config get registry": () =>
        spawnSync("npm", ["config", "get", "registry"], { encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, NPM_CONFIG_USERCONFIG: rc } }).stdout,
      "npm view": () => "9.9.9\n",
      "npm root -g": () => tmp(),
    });
    const r = await run(["update", "--check"], env, fake);
    expect(r.errs).toEqual([]);
    expect(r.out).toContain("registry https://pkgs.example.test/_packaging/team/npm/registry/");
    expect(r.out).toContain("latest: 9.9.9");
    expect(r.out).toContain("update available");
    expect(r.out).toContain("skills: not installed");
    expect(fake.calls).toContain(`npm view ${NAME} version`);
    expect(fake.calls.join("\n")).not.toMatch(/--registry|npmjs/);
    expect(fake.calls.some((c) => c.startsWith("npm i "))).toBe(false);
  });

  it("says when the CLI is up to date and flags older skill copies", async () => {
    const { h, env } = setup();
    await run(["skills", "install", "--client", "codex"], env);
    const skill = join(h, ".codex", "skills", "start-here", "SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8").replace(/aihub \S+ -->/, "aihub 0.0.1 -->"), "utf8");
    const ver = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version as string;
    const fake = fakeExec({ "npm config get registry": () => "https://registry.example.test/\n", "npm view": () => ver + "\n", "npm root -g": () => tmp() });
    const r = await run(["update", "--check"], env, fake);
    expect(r.out).toContain("the CLI is up to date");
    expect(r.out).toContain("skills codex: aihub 0.0.1 (older than the CLI");
  });

  it("fails with a pointer to .npmrc when the registry cannot be read", async () => {
    const { env } = setup();
    const fake = fakeExec({ "npm config get registry": () => "https://r.example.test/\n", "npm view": () => { throw new Error("E401 unauthorized"); } });
    const r = await run(["update", "--check"], env, fake);
    expect(r.code).toBe(1);
    expect(r.errs.join("")).toMatch(/cannot read the latest version of @ferronhooi\/aihub from https:\/\/r\.example\.test\/.*\.npmrc/);
  });
});

describe("aihub update", () => {
  it("global npm install: installs, then the new CLI shows the changelog and refreshes the skills", async () => {
    const { env } = setup();
    const root = tmp();
    const install = join(root, "@ferronhooi", "aihub");
    mkdirSync(install, { recursive: true });
    const fake = fakeExec({
      "npm config get registry": () => "https://r.example.test/\n",
      "npm view": () => "9.9.9\n",
      "npm root -g": () => root,
      "npm i -g": () => "",
      "aihub update --after": () => "aihub 0.1.0 -> 9.9.9\nchanges:\n  9.9.9: something new\n",
    });
    const r = await run(["update"], env, fake, { installPath: install });
    expect(r.errs).toEqual([]);
    expect(fake.calls).toContain(`npm i -g ${NAME}@latest`);
    expect(fake.calls.some((c) => c.startsWith("aihub update --after "))).toBe(true);
    expect(r.out).toContain("9.9.9: something new");
  });

  it("other install: prints the exact command instead of running it", async () => {
    const { env } = setup();
    const fake = fakeExec({ "npm config get registry": () => "https://r.example.test/\n", "npm view": () => "9.9.9\n", "npm root -g": () => tmp() });
    const r = await run(["update"], env, fake);
    expect(r.out).toContain(`run this yourself: npm i -g ${NAME}@latest`);
    expect(fake.calls.some((c) => c.startsWith("npm i "))).toBe(false);
  });

  it("--after shows the changelog lines between the versions and refreshes installed clients", async () => {
    const { h, env } = setup();
    await run(["skills", "install", "--client", "opencode"], env);
    const r = await run(["update", "--after", "0.0.1"], env);
    expect(r.errs).toEqual([]);
    expect(r.out).toMatch(/aihub 0\.0\.1 -> /);
    expect(r.out).toContain("changes:");
    expect(r.out).toContain("opencode: ");
    expect(existsSync(join(h, ".codex"))).toBe(false);
  });

  it("changelogSince keeps only the versions after `from` up to the current one", () => {
    const text = "# Changelog\n\n## 0.3.0\n- c\n\n## 0.2.0\n- b1\n- b2\n\n## 0.1.0\n- a\n";
    expect(changelogSince("0.1.0", text, "0.3.0")).toEqual(["  0.3.0: c", "  0.2.0: b1", "  0.2.0: b2"]);
    expect(changelogSince("0.1.0", text, "0.2.0")).toEqual(["  0.2.0: b1", "  0.2.0: b2"]);
  });
});

describe("aihub skills diff", () => {
  it("shows your edits and says when nothing differs", async () => {
    const { h, env } = setup();
    await run(["skills", "install", "--client", "codex"], env);
    expect((await run(["skills", "diff", "--client", "codex"], env)).out).toContain("no differences");
    const f = join(h, ".codex", "skills", "pr-create", "SKILL.md");
    writeFileSync(f, readFileSync(f, "utf8").replace("# Create a pull request", "# Create a pull request\nMy team rule.") , "utf8");
    const r = await run(["skills", "diff", "--client", "codex"], env);
    expect(r.out).toContain("codex: pr-create/SKILL.md (edited by you)");
    expect(r.out).toContain("+ My team rule.");
    expect(r.out).not.toMatch(/- <!-- aihub/);
    // update keeps the edit and lists it
    const u = await run(["skills", "update", "--client", "codex"], env);
    expect(readFileSync(f, "utf8")).toContain("My team rule.");
    expect(u.out).toContain("changed by the user");
  });
});

describe("--dry-run and --verbose", () => {
  it("classifies git commands", () => {
    expect(isGitWrite(["push", "origin", "x"])).toBe(true);
    expect(isGitWrite(["-c", "a=b", "commit", "-m", "x"])).toBe(true);
    expect(isGitWrite(["switch", "-c", "x"])).toBe(true);
    expect(isGitWrite(["branch", "-D", "x"])).toBe(true);
    expect(isGitWrite(["config", "user.name", "x"])).toBe(true);
    expect(isGitWrite(["rev-parse", "HEAD"])).toBe(false);
    expect(isGitWrite(["config", "--get", "remote.origin.url"])).toBe(false);
    expect(isGitWrite(["branch", "--list"])).toBe(false);
    expect(isGitWrite(["worktree", "list"])).toBe(false);
    expect(isGitWrite(["fetch", "origin"])).toBe(false);
  });

  it("a REST write prints method, URL and a body summary and is not sent", async () => {
    const { dir } = makeRepo();
    const { fn, calls } = fakeFetch([
      { match: /wit\/workitems\/7/, respond: () => ({ body: { id: 7, fields: { "System.State": "Active" } } }) },
      { method: "PATCH", match: /wit\/workitems\/7/, respond: () => ({ body: {} }) },
    ]);
    const { ctx, lines } = ctxFor(dir, fn);
    expect(await main(["workitem", "state", "--id", "7", "--to", "Done", "--dry-run"], ctx)).toBe(0);
    const out = lines.join("\n");
    expect(out).toMatch(/dry-run: would PATCH https:\/\/dev\.azure\.com\/ferron-org\/test-project\/_apis\/wit\/workitems\/7\?api-version=7\.1   body \[add \/fields\/System\.State\]/);
    expect(out).toContain("1 planned write(s), nothing was changed");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("git writes are printed and skipped; init --dry-run leaves the repository untouched", async () => {
    const { dir } = makeRepo();
    sh(dir, ["config", "user.name", "T"]);
    sh(dir, ["config", "user.email", "t@example.com"]);
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    const code = await main(["init", "--dry-run", "--language", "en"], ctx);
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("dry-run: would run: git switch -c chore/aihub-team-pack");
    expect(out).toContain(`dry-run: would write ${join(dir, ".agents/skills/_shared/references/team.yaml")}`);
    expect(existsSync(join(dir, ".agents"))).toBe(false);
    expect(sh(dir, ["branch", "--list", "chore/aihub-team-pack"])).toBe("");
  });

  it("--verbose logs the real git and REST calls to stderr", async () => {
    const { dir } = makeRepo();
    const { fn } = fakeFetch([{ match: /wit\/workitems\/7/, respond: () => ({ body: { id: 7, fields: { "System.State": "Done" } } }) }]);
    const { ctx, errs, lines } = ctxFor(dir, fn);
    expect(await main(["workitem", "state", "--id", "7", "--to", "Done", "--verbose"], ctx)).toBe(0);
    expect(lines.join("\n")).toContain("already Done");
    expect(errs.some((l) => l.startsWith("+ git rev-parse"))).toBe(true);
    expect(errs.some((l) => l.startsWith("+ GET https://dev.azure.com/"))).toBe(true);
    void write;
  });
});

describe("aihub explain", () => {
  it("prints the steps of a command and lists the known ones", async () => {
    const { env } = setup();
    expect((await run(["explain", "pr"], env)).out).toContain("REST POST");
    expect((await run(["explain"], env)).out).toContain("Commands with an explanation");
  });
});
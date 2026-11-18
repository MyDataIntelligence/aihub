import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_FIXES, matchFixes, normalizeError, parseKnownFixes, withEntry } from "../src/lib/knownFixes.js";
import { withRule } from "../src/lib/teamLearn.js";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

const PR_BASE = "/ferron-org/test-project/_apis/git/repositories/test-repo/pullrequests";
const TEAM = "language: en\nrepositories:\n  - name: test-repo\n    defaultTarget: main\n";
const FIXES = `# Known fixes

## ModuleNotFoundError: No module named 'pandas'

Add pandas to requirements.txt and rerun the install step.

Added: 2026-11-01 by Anna

## ruff F401 \`os\` imported but unused

Remove the import.

Added: 2026-11-02 by Bo
`;

function repoWith(files: Record<string, string> = {}) {
  const { dir, bare } = makeRepo();
  write(dir, ".agents/skills/_shared/references/team.yaml", TEAM);
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "chore: team pack"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["checkout", "-b", "feature/5-work"]);
  return { dir, bare };
}

const prRoutes = (posted: any[]): Route[] => [
  { method: "POST", match: new RegExp(PR_BASE + "\\?"), respond: (c) => (posted.push(c.body), { body: { pullRequestId: 77 } }) },
  { match: new RegExp(PR_BASE + "\\?.*searchCriteria"), respond: () => ({ body: { value: [] } }) },
];

async function run(dir: string, routes: Route[], argv: string[]) {
  const f = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(dir, f.fn);
  ctx.now = () => Date.parse("2026-11-18T10:00:00Z");
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), errs, calls: f.calls };
}

describe("known fixes: parse, normalise, match", () => {
  it("parses sections and ignores the header", () => {
    const fixes = parseKnownFixes(FIXES);
    expect(fixes.map((f) => f.error)).toEqual(["ModuleNotFoundError: No module named 'pandas'", "ruff F401 `os` imported but unused"]);
    expect(fixes[0].fix).toBe("Add pandas to requirements.txt and rerun the install step.");
    expect(fixes[0].added).toBe("2026-11-01 by Anna");
  });

  it("matches the same error with other paths, numbers and timestamps", () => {
    const fixes = parseKnownFixes(FIXES);
    const log = "2026-11-18T09:00:01.123Z ci_demo/retouren.py:1:8: F401 [*] `os` imported but unused\n2026-11-18T09:00:02Z Found 1 error.";
    expect(matchFixes(fixes, log)[0].fix.fix).toBe("Remove the import.");
    expect(matchFixes(fixes, "E   ModuleNotFoundError: No module named 'pandas'  (line 42 of /home/vsts/work/1/s/app.py)")[0].score).toBe(1);
    expect(matchFixes(fixes, "all tests passed")).toEqual([]);
    expect(normalizeError("File /a/b/c.py, line 12: id 3f2a9c1b77 failed at 2026-01-02T03:04:05Z")).toBe("file line # id failed at");
  });

  it("adds an entry, keeps the file, replaces a better fix for the same error", () => {
    const entry = { error: "TimeoutError: lakehouse is busy", fix: "Rerun once; if it repeats, ask the platform team.", who: "Cy", date: "2026-11-18" };
    const added = withEntry(FIXES, entry, false);
    expect(parseKnownFixes(added)).toHaveLength(3);
    expect(added).toContain("## TimeoutError: lakehouse is busy\n\nRerun once; if it repeats, ask the platform team.\n\nAdded: 2026-11-18 by Cy");
    expect(withEntry(added, entry, false)).toBe(added);
    const better = withEntry(added, { ...entry, fix: "Retry after 5 minutes." }, false);
    expect(parseKnownFixes(better).find((f) => f.error.startsWith("TimeoutError"))!.fix).toBe("Retry after 5 minutes.");
    expect(parseKnownFixes(better)).toHaveLength(3);
    expect(withEntry(undefined, entry, true).startsWith("# Bekende fixes")).toBe(true);
  });
});

describe("aihub fix known / remember", () => {
  it("known: finds the fix for an error text, in the file on the target branch too", async () => {
    const { dir } = repoWith({ [KNOWN_FIXES]: FIXES });
    const hit = await run(dir, [], ["fix", "known", "--error", "ModuleNotFoundError: No module named 'pandas'"]);
    expect(hit.errs).toEqual([]);
    expect(hit.out).toContain("known fix (exact): ModuleNotFoundError: No module named 'pandas'");
    expect(hit.out).toContain("Add pandas to requirements.txt");
    expect((await run(dir, [], ["fix", "known", "--error", "something new broke"])).out).toBe("no known fix matches (2 entries checked)");
    const j = JSON.parse((await run(dir, [], ["fix", "known", "--error", "ruff F401 `os` imported but unused", "--json"])).out);
    expect(j.matches[0].fix).toBe("Remove the import.");
    // the branch has no local file, the target branch does
    sh(dir, ["rm", "-q", KNOWN_FIXES]);
    sh(dir, ["commit", "-m", "drop"]);
    expect((await run(dir, [], ["fix", "known", "--error", "ModuleNotFoundError: No module named 'pandas'"])).out).toContain("known fix (exact)");
  });

  it("known --run reads the failing log of a run", async () => {
    const { dir } = repoWith({ [KNOWN_FIXES]: FIXES });
    const routes: Route[] = [
      { match: /build\/builds\/12\/timeline/, respond: () => ({ body: { records: [{ id: "t", type: "Task", name: "ruff", result: "failed", order: 1, log: { id: 2 } }] } }) },
      { match: /build\/builds\/12\/logs\/2/, respond: () => ({ text: "2026-11-18T09:00:01.0000000Z x/y.py:1:8: F401 [*] `os` imported but unused\n" }) },
    ];
    const r = await run(dir, routes, ["fix", "known", "--run", "https://dev.azure.com/o/p/_build/results?buildId=12"]);
    expect(r.errs).toEqual([]);
    expect(r.out).toContain("Remove the import.");
  });

  it("known without any file says so; no flag is a usage error", async () => {
    const { dir } = repoWith();
    expect((await run(dir, [], ["fix", "known", "--error", "x y z"])).out).toContain("no known fixes yet");
    expect((await run(dir, [], ["fix", "known"])).code).not.toBe(0);
  });

  it("remember proposes a pull request from a throw-away worktree: the branch is pushed, the checkout untouched, nothing silent", async () => {
    const { dir, bare } = repoWith({ [KNOWN_FIXES]: FIXES });
    const posted: any[] = [];
    const before = sh(dir, ["status", "--porcelain"]);
    const r = await run(dir, prRoutes(posted), ["fix", "remember", "--error", "TimeoutError: lakehouse is busy", "--fix", "Rerun once.\nThen ask the platform team.", "--by", "Cy"]);
    expect(r.errs).toEqual([]);
    expect(r.out).toContain("known fix proposed:");
    expect(r.out).toContain("nothing is stored until the pull request is merged");
    expect(posted).toHaveLength(1);
    expect(posted[0].sourceRefName).toBe("refs/heads/aihub/known-fix-timeouterror-lakehouse-is-busy");
    expect(posted[0].targetRefName).toBe("refs/heads/main");
    expect(posted[0].description).toContain("`aihub fix remember`");
    // pushed file = target version plus the new entry, the others kept
    const pushed = sh(bare, ["show", `aihub/known-fix-timeouterror-lakehouse-is-busy:${KNOWN_FIXES}`]);
    expect(pushed).toContain("ModuleNotFoundError");
    expect(pushed).toContain("## TimeoutError: lakehouse is busy\n\nRerun once.\nThen ask the platform team.\n\nAdded: 2026-11-18 by Cy");
    // the user's checkout: same branch, no change, no leftover branch or worktree
    expect(sh(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/5-work");
    expect(sh(dir, ["status", "--porcelain"])).toBe(before);
    expect(sh(dir, ["branch", "--list", "aihub/*"])).toBe("");
    expect(sh(dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
    // main itself has not changed
    expect(sh(bare, ["show", `main:${KNOWN_FIXES}`])).not.toContain("TimeoutError");
  });

  it("remember: an existing entry proposes nothing, a bad --fix or an open proposal is refused", async () => {
    const { dir } = repoWith({ [KNOWN_FIXES]: FIXES });
    const posted: any[] = [];
    const same = await run(dir, prRoutes(posted), ["fix", "remember", "--error", "ruff F401 `os` imported but unused", "--fix", "Remove the import."]);
    expect(same.out).toContain("already in the team pack");
    expect(posted).toHaveLength(0);
    expect((await run(dir, prRoutes(posted), ["fix", "remember", "--error", "x", "--fix", "a\nb\nc\nd"])).errs.join("\n")).toContain("1 to 3 lines");
    expect((await run(dir, prRoutes(posted), ["fix", "remember", "--error", "x"])).code).not.toBe(0);
    await run(dir, prRoutes(posted), ["fix", "remember", "--error", "Boom happened", "--fix", "Do X."]);
    const again = await run(dir, prRoutes(posted), ["fix", "remember", "--error", "Boom happened", "--fix", "Do Y."]);
    expect(again.code).not.toBe(0);
  });
});

describe("aihub team learn", () => {
  it("appends the rule to the first guideline file of team.yaml, through a pull request", async () => {
    const { dir, bare } = repoWith({ ".github/guidelines/aihub.md": "# Rules\n\n- One topic per PR.\n" });
    write(dir, ".agents/skills/_shared/references/team.yaml", TEAM + "guidelines:\n  - .github/guidelines/aihub.md\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "guidelines"]);
    sh(dir, ["push", "origin", "feature/5-work:main"]);
    const posted: any[] = [];
    const r = await run(dir, prRoutes(posted), ["team", "learn", "Never", "rerun", "a", "red", "build", "twice", "without", "reading", "the", "log."]);
    expect(r.errs).toEqual([]);
    expect(r.out).toContain("team rule proposed in .github/guidelines/aihub.md");
    expect(posted[0].sourceRefName).toBe("refs/heads/aihub/team-rule-never-rerun-a-red-build-twice-without-re");
    const file = sh(bare, ["show", `aihub/team-rule-never-rerun-a-red-build-twice-without-re:.github/guidelines/aihub.md`]);
    expect(file).toBe("# Rules\n\n- One topic per PR.\n- Never rerun a red build twice without reading the log.");
    const dup = await run(dir, prRoutes(posted), ["team", "learn", "One topic per PR."]);
    expect(dup.out).toContain("already in");
  });

  it("falls back to team-knowledge.md, refuses an empty or long rule", async () => {
    const { dir, bare } = repoWith();
    const posted: any[] = [];
    const r = await run(dir, prRoutes(posted), ["team", "learn", "Use the staging DB for demos."]);
    expect(r.out).toContain("team-knowledge.md");
    expect(sh(bare, ["show", "aihub/team-rule-use-the-staging-db-for-demos:.agents/skills/_shared/references/team-knowledge.md"])).toContain("- Use the staging DB for demos.");
    expect((await run(dir, [], ["team", "learn"])).code).not.toBe(0);
    expect((await run(dir, [], ["team", "learn", "x".repeat(301)])).errs.join("")).toContain("300 characters");
    expect(withRule(undefined, "A", true).startsWith("# Teamkennis")).toBe(true);
  });
});

describe("aihub crossrepo impact", () => {
  function world() {
    const base = tmp("aihub-impact-");
    const a = join(base, "test-repo");
    const b = join(base, "other-repo");
    for (const d of [a, b]) {
      mkdirSync(d, { recursive: true });
      sh(d, ["init", "-q", "-b", "main"]);
      sh(d, ["config", "remote.origin.url", `https://dev.azure.com/ferron-org/test-project/_git/${d === a ? "test-repo" : "other-repo"}`]);
    }
    write(b, "lib/app/util.py", "x = 1\n");
    sh(b, ["add", "."]);
    sh(b, ["commit", "-q", "-m", "init"]);
    write(a, "README.md", "x\n");
    write(a, ".agents/skills/_shared/references/team.yaml", "repositories:\n  - name: test-repo\n  - name: other-repo\n  - name: third-repo\ncrossRepo:\n  pathMaps:\n    other-repo:\n      - from: src/app\n        to: lib/app\n");
    sh(a, ["add", "."]);
    sh(a, ["commit", "-q", "-m", "init"]);
    return { a, b };
  }
  const routes: Route[] = [
    { match: /\/pullrequests\/5\/iterations\?/, respond: () => ({ body: { value: [{ id: 2 }] } }) },
    { match: /\/iterations\/2\/changes\?/, respond: () => ({ body: { changeEntries: [{ changeType: "edit", item: { path: "/src/app/util.py" } }, { changeType: "add", item: { path: "/src/app/new.py" } }, { changeType: "edit", item: { path: "/docs/readme.md" } }] } }) },
    { match: /\/commits\/abc1234\/changes\?/, respond: () => ({ body: { changes: [{ item: { path: "/src/app/util.py" } }] } }) },
  ];

  it("maps the files of a PR through crossRepo.pathMaps, checks the local clones and names the unknown repositories", async () => {
    const { a } = world();
    const r = await run(a, routes, ["crossrepo", "impact", "--from", "5"]);
    expect(r.errs).toEqual([]);
    expect(r.out).toContain("impact of !5 in test-repo: 3 file(s)");
    expect(r.out).toContain("map other-repo -> other-repo: 2 file(s) reach it, 1 outside the map");
    expect(r.out).toContain("src/app/util.py -> lib/app/util.py (exists in other-repo)");
    expect(r.out).toContain("src/app/new.py -> lib/app/new.py (new in other-repo)");
    expect(r.out).toContain("not covered by other-repo: docs/readme.md");
    expect(r.out).toContain("port it: aihub port --from-repo test-repo --from 5 --to-repo other-repo --map other-repo");
    expect(r.out).toContain("no map names: third-repo");
    expect(r.out).toContain("no local clone of: third-repo");
    expect(r.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("takes a commit sha, has --json, and needs pathMaps", async () => {
    const { a } = world();
    const j = JSON.parse((await run(a, routes, ["crossrepo", "impact", "--from", "abc1234", "--json"])).out);
    expect(j.from).toBe("commit abc1234");
    expect(j.maps[0].mapped).toEqual([{ from: "src/app/util.py", to: "lib/app/util.py", present: { "other-repo": true } }]);
    write(a, ".agents/skills/_shared/references/team.yaml", "repositories:\n  - name: test-repo\n");
    const none = await run(a, routes, ["crossrepo", "impact", "--from", "5"]);
    expect(none.errs.join("\n")).toContain("no crossRepo.pathMaps");
    expect((await run(a, routes, ["crossrepo", "impact"])).code).not.toBe(0);
  });
});

void existsSync;
void dirname;
void writeFileSync;

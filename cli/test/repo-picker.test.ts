import { mkdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { adoKey, branchFromHead, dedupeClones, joinAdoLocal, originFromConfig, remoteKey, scanLocal, type LocalRepo } from "../src/lib/repoPicker.js";
import { ctxFor, fakeFetch, sh, tmp, write, type Route } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

const run = async (dir: string, routes: Route[], argv: string[], env: Record<string, string> = {}) => {
  const { fn, calls } = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(dir, fn);
  Object.assign(ctx.env, env);
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), err: errs.join("\n"), calls, ctx };
};

describe("the repo opener: pure parts", () => {
  it("reads the branch from HEAD and the origin from the config, without git", () => {
    expect(branchFromHead("ref: refs/heads/feature/7-x\n")).toBe("feature/7-x");
    expect(branchFromHead("0123456789abcdef\n")).toBe("");
    expect(originFromConfig('[core]\n\tbare = false\n[remote "origin"]\n\turl = https://dev.azure.com/ferron-org/test-project/_git/repo-a\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')).toBe("https://dev.azure.com/ferron-org/test-project/_git/repo-a");
    expect(originFromConfig("[core]\n")).toBeUndefined();
  });

  it("knows an Azure DevOps repository in every URL form", () => {
    const k = "ferron-org/test-project/repo-a";
    expect(adoKey("https://user@dev.azure.com/ferron-org/test-project/_git/repo-a")).toBe(k);
    expect(adoKey("git@ssh.dev.azure.com:v3/ferron-org/test-project/repo-a")).toBe(k);
    expect(adoKey("ssh://git@ssh.dev.azure.com/v3/ferron-org/test-project/repo-a")).toBe(k);
    // a stray % must not throw: one odd clone would otherwise fail the whole list
    expect(() => adoKey("https://dev.azure.com/ferron-org/test-project/_git/100%")).not.toThrow();
    expect(adoKey("https://ferron-org.visualstudio.com/DefaultCollection/test-project/_git/repo-a")).toBe(k);
    expect(adoKey("https://dev.azure.com/ferron-org/test%20project/_git/repo-a.git")).toBe("ferron-org/test project/repo-a");
    expect(adoKey("https://example.invalid/x.git")).toBeUndefined();
  });

  it("joins Azure DevOps and the local clones by origin, else by name under the repos root", () => {
    const ado = [
      { project: "p", name: "repo-a", id: "1", remoteUrl: "u", defaultBranch: "main", key: "o/p/repo-a" },
      { project: "p", name: "repo-b", id: "2", remoteUrl: "u", defaultBranch: "main", key: "o/p/repo-b" },
      { project: "p", name: "repo-c", id: "3", remoteUrl: "u", defaultBranch: "main", key: "o/p/repo-c" },
    ];
    const local = [
      { name: "a-elsewhere", path: "/x/a-elsewhere", branch: "develop", key: "o/p/repo-a" },
      { name: "repo-b", path: "/root/repo-b", branch: "main" },
    ];
    expect(joinAdoLocal(ado, local, "/root").map((r) => [r.name, r.path, r.branch])).toEqual([
      ["repo-a", "/x/a-elsewhere", "develop"],
      ["repo-b", "/root/repo-b", "main"],
      ["repo-c", undefined, undefined],
    ]);
  });

  it("finds clones two levels deep and skips linked worktrees", () => {
    const root = tmp();
    const a = join(root, "repo-a");
    mkdirSync(a);
    sh(a, ["init", "-q", "-b", "main"]);
    sh(a, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "x"]);
    const deep = join(root, "team", "repo-b");
    mkdirSync(deep, { recursive: true });
    sh(deep, ["init", "-q", "-b", "develop"]);
    sh(a, ["worktree", "add", "-q", "-b", "feature/1", join(root, "wt-a")]);
    const found = scanLocal([root]);
    expect(found.map((r) => [r.name, r.branch])).toEqual([
      ["repo-a", "main"],
      ["repo-b", "develop"],
    ]);
  });
});

function world() {
  const parent = newParent();
  const a = makeNamedRepo(parent, "repo-a");
  const b = makeNamedRepo(parent, "repo-b");
  return { parent, a, b };
}

const adoRoutes = (bareC: string, counter: { n: number }): Route[] => [
  // without projects in team.yaml: one call for every repository of the organisation
  {
    match: /dev\.azure\.com\/ferron-org\/_apis\/git\/repositories\?/,
    respond: () => (
      (counter.n += 1),
      {
        body: {
          value: [
            ...["repo-a", "repo-b"].map((n) => ({ id: n, name: n, project: { name: "test-project" }, remoteUrl: `https://ferron-org@dev.azure.com/ferron-org/test-project/_git/${n}`, defaultBranch: "refs/heads/main" })),
            { id: "c", name: "repo-c", project: { name: "other-project" }, remoteUrl: bareC, defaultBranch: "refs/heads/main" },
            { id: "d", name: "old", project: { name: "other-project" }, isDisabled: true },
          ],
        },
      }
    ),
  },
  {
    match: /test-project\/_apis\/git\/repositories\?/,
    respond: () => ({ body: { value: ["repo-a", "repo-b"].map((n) => ({ id: n, name: n, remoteUrl: `https://ferron-org@dev.azure.com/ferron-org/test-project/_git/${n}`, defaultBranch: "refs/heads/main" })) } }),
  },
  { match: /other-project\/_apis\/git\/repositories\?/, respond: () => ({ body: { value: [{ id: "c", name: "repo-c", remoteUrl: bareC, defaultBranch: "refs/heads/main" }, { id: "d", name: "old", isDisabled: true }] } }) },
];

describe("aihub repos local / ado / clone", () => {
  it("local: the clones next to this one with their branch, no network", async () => {
    const { a, b } = world();
    sh(b.dir, ["switch", "-q", "-c", "feature/9-x"]);
    const r = await run(a.dir, [], ["repos", "local", "--json"]);
    expect(r.calls).toEqual([]);
    const j = JSON.parse(r.out);
    expect(j.repos.map((x: { name: string; branch: string; key: string }) => [x.name, x.branch, x.key])).toEqual([
      ["repo-a", "main", "ferron-org/test-project/repo-a"],
      ["repo-b", "feature/9-x", "ferron-org/test-project/repo-b"],
    ]);
  });

  it("ado: every project you can see, joined with the clones; cached a few hours; --refresh reads again", async () => {
    const { a } = world();
    const bareC = join(tmp(), "c.git");
    const counter = { n: 0 };
    const r = await run(a.dir, adoRoutes(bareC, counter), ["repos", "ado", "--json"]);
    expect(r.err).toBe("");
    const j = JSON.parse(r.out);
    expect(j.cached).toBe(false);
    expect(j.repos.map((x: { project: string; name: string; path?: string }) => [x.project, x.name, !!x.path])).toEqual([
      ["other-project", "repo-c", false],
      ["test-project", "repo-a", true],
      ["test-project", "repo-b", true],
    ]);
    const again = await run(a.dir, adoRoutes(bareC, counter), ["repos", "ado", "--json"], { AIHUB_CONFIG_HOME: r.ctx.env.AIHUB_CONFIG_HOME! });
    expect(again.calls).toEqual([]);
    expect(JSON.parse(again.out).cached).toBe(true);
    const fresh = await run(a.dir, adoRoutes(bareC, counter), ["repos", "ado", "--refresh", "--json"], { AIHUB_CONFIG_HOME: r.ctx.env.AIHUB_CONFIG_HOME! });
    expect(JSON.parse(fresh.out).cached).toBe(false);
    expect(counter.n).toBe(2);
  });

  it("ado: only the projects of team.yaml when it names them", async () => {
    const { a } = world();
    write(a.dir, ".agents/skills/_shared/references/team.yaml", "projects:\n  - test-project\n");
    const counter = { n: 0 };
    const r = await run(a.dir, adoRoutes("x", counter), ["repos", "ado", "--json"]);
    expect(counter.n).toBe(0);
    expect(JSON.parse(r.out).repos.map((x: { name: string }) => x.name)).toEqual(["repo-a", "repo-b"]);
  });

  it("clone: a repository that is not there yet goes into the repos root; one that fails says why", async () => {
    const { parent, a } = world();
    const src = makeNamedRepo(tmp(), "repo-c");
    const counter = { n: 0 };
    const r = await run(a.dir, adoRoutes(src.bare, counter), ["repos", "clone", "--repos", "other-project/repo-c,test-project/repo-a,other-project/nope", "--json"]);
    const j = JSON.parse(r.out);
    expect(j.map((x: { repo: string; status: string }) => [x.repo, x.status])).toEqual([
      ["repo-c", "cloned"],
      ["repo-a", "already there"],
      ["nope", "failed"],
    ]);
    expect(sh(join(parent, "repo-c"), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    const broken = await run(a.dir, adoRoutes(join(tmp(), "missing.git"), counter), ["repos", "clone", "--repos", "other-project/repo-c", "--root", join(parent, "elsewhere"), "--json"]);
    const f = JSON.parse(broken.out)[0];
    expect(f.status).toBe("failed");
    expect(f.error).toMatch(/does not exist|not found|repository/i);
  });
});

describe("one repository is one line, however often it is cloned", () => {
  it("every spelling of one remote has one key: https and ssh, dev.azure.com and visualstudio.com, case, .git", () => {
    const k = remoteKey("https://dev.azure.com/ferron-org/test-project/_git/repo-a");
    expect(remoteKey("git@ssh.dev.azure.com:v3/ferron-org/test-project/repo-a")).toBe(k);
    expect(remoteKey("https://Ferron-Org.visualstudio.com/Test-Project/_git/Repo-A.git")).toBe(k);
    expect(remoteKey("git@example.com:team/repo-a.git")).toBe(remoteKey("https://user@example.com/Team/repo-a"));
    expect(remoteKey(undefined)).toBeUndefined();
  });

  const clone = (path: string, remoteUrl?: string): LocalRepo => ({ name: path.split("/").pop()!, path, branch: "main", remoteUrl });
  const A = "https://dev.azure.com/ferron-org/test-project/_git/repo-a";

  it("keeps the most recently used clone, else the shortest path; the others are otherClones", () => {
    const repos = [clone("/r/old/repo-a", A), clone("/r/repo-a", "git@ssh.dev.azure.com:v3/ferron-org/test-project/repo-a"), clone("/r/repo-b"), clone("/r/x/repo-b")];
    const used = (d: string) => (d === "/r/old/repo-a" ? 20 : 10);
    const out = dedupeClones(repos, {}, used);
    expect(out.map((r) => [r.path, r.otherClones])).toEqual([
      ["/r/old/repo-a", ["/r/repo-a"]],
      ["/r/repo-b", undefined], // no origin: two different repositories, both stay
      ["/r/x/repo-b", undefined],
    ]);
    // a tie: the shortest path
    expect(dedupeClones(repos.slice(0, 2), {}, () => 5)[0].path).toBe("/r/repo-a");
  });

  it("a preference by repository name wins over recency", () => {
    const repos = [clone("/r/old/repo-a", A), clone("/r/repo-a", A)];
    expect(dedupeClones(repos, { "REPO-A": "/r/old/repo-a" }, (d) => (d === "/r/repo-a" ? 99 : 1))[0].path).toBe("/r/old/repo-a");
  });

  it("repos local: two clones and a worktree of one remote are one line; --all shows both; prefer picks the other", async () => {
    const { parent, a } = world();
    const second = join(parent, "old", "repo-a");
    mkdirSync(join(parent, "old"), { recursive: true });
    sh(parent, ["clone", "-q", join(parent, "_remotes", "repo-a.git"), second]);
    sh(second, ["remote", "set-url", "origin", "git@ssh.dev.azure.com:v3/ferron-org/test-project/repo-a"]);
    sh(a.dir, ["worktree", "add", "-q", "-b", "feature/1", join(parent, "repo-a-wt")]);
    const old = new Date(Date.now() - 86_400_000);
    for (const f of ["HEAD", "index"]) utimesSync(join(second, ".git", f), old, old);
    utimesSync(join(a.dir, ".git", "index"), new Date(), new Date());

    const r = await run(a.dir, [], ["repos", "local", "--json"]);
    const j = JSON.parse(r.out) as { repos: LocalRepo[] };
    expect(j.repos.map((x) => [x.name, x.path, x.otherClones])).toEqual([
      ["repo-a", a.dir, [second]],
      ["repo-b", join(parent, "repo-b"), undefined],
    ]);
    const text = await run(a.dir, [], ["repos", "local"], { AIHUB_CONFIG_HOME: r.ctx.env.AIHUB_CONFIG_HOME! });
    expect(text.out).toMatch(/repo-a .*\(\+1 more: --all\)/);
    expect((await run(a.dir, [], ["repos", "local", "--all", "--json"])).out.match(/"name":"repo-a"/g)).toHaveLength(2);

    const cfg = { AIHUB_CONFIG_HOME: r.ctx.env.AIHUB_CONFIG_HOME! };
    expect((await run(a.dir, [], ["repos", "prefer", "repo-a", second], cfg)).out).toBe(`repo-a: uses ${second}`);
    const p = JSON.parse((await run(a.dir, [], ["repos", "local", "--json"], cfg)).out) as { repos: LocalRepo[] };
    expect(p.repos[0]).toMatchObject({ path: second, otherClones: [a.dir] });
    expect(JSON.parse(readFileSync(join(cfg.AIHUB_CONFIG_HOME, "repos.json"), "utf8")).prefer).toEqual({ "repo-a": second });
    expect((await run(a.dir, [], ["repos", "prefer", "repo-a", "--remove"], cfg)).out).toBe("repo-a: no preferred clone");
    expect((await run(a.dir, [], ["repos", "prefer"], cfg)).out).toMatch(/no preferred clones/);
  });

  it("ado: the Azure DevOps row of a repository cloned twice points at the one chosen clone and lists the other", () => {
    const ado = [{ project: "test-project", name: "repo-a", id: "1", remoteUrl: A, defaultBranch: "main", key: "ferron-org/test-project/repo-a" }];
    const local = dedupeClones([{ ...clone("/r/repo-a", A), key: adoKey(A) }, { ...clone("/r/old/repo-a", A), key: adoKey(A) }], {}, () => 1);
    expect(joinAdoLocal(ado, local)[0]).toMatchObject({ path: "/r/repo-a", otherClones: ["/r/old/repo-a"] });
  });
});

describe("Save as group in team.yaml", () => {
  it("adds the group to repositories[].groups and keeps the comments", async () => {
    const { a, b } = world();
    write(a.dir, ".agents/skills/_shared/references/team.yaml", "# the team settings\nrepositories:\n  # the app\n  - name: repo-a\n    defaultTarget: main\n");
    const r = await run(a.dir, [], ["worktree", "groups", "save", "pipeline", "--repos", `repo-a,${b.dir}`, "--team"]);
    expect(r.err).toBe("");
    const y = readFileSync(join(a.dir, ".agents/skills/_shared/references/team.yaml"), "utf8");
    expect(y).toContain("# the team settings");
    expect(y).toContain("# the app");
    expect(y).toMatch(/- name: repo-a\n\s+defaultTarget: main\n\s+groups:\n\s+- pipeline/);
    expect(y).toMatch(/- name: repo-b\n\s+groups:\n\s+- pipeline/);
    const g = await run(a.dir, [], ["worktree", "groups", "list", "--json"]);
    expect(JSON.parse(g.out).find((x: { name: string }) => x.name === "pipeline")).toMatchObject({ source: "team", missing: [] });
  });
});

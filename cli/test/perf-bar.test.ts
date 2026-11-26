import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { azToken, makeAuth } from "../src/lib/auth.js";
import { fabricErrorKind } from "../src/commands/bar.js";
import { flushPerf, perfRecord, startPerf, timedFetch, urlForLog } from "../src/lib/perf.js";
import { ctxFor, fakeFetch, makeRepo, sh } from "./helpers.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const noLogin = () => {
  throw new Error("no credential");
};

describe("sign-in without a credential", () => {
  it("asks az and git once per command: later reads fail at once with the same message", async () => {
    let calls = 0;
    const auth = makeAuth({ env: {}, exec: () => (calls++, noLogin()), cacheFile: join(tmp("auth-"), "t.json") });
    await expect(auth()).rejects.toThrow(/not signed in to Azure DevOps/);
    await expect(auth()).rejects.toThrow(/not signed in to Azure DevOps/);
    expect(calls).toBe(2); // az + git credential, only the first time
  });

  it("does not start az at all when az has no signed-in account", () => {
    let calls = 0;
    const exec = () => (calls++, "{}");
    expect(() => azToken(exec, true, { AZURE_CONFIG_DIR: tmp("az-empty-") }, "res-empty", Date.now)).toThrow(/no signed-in account/);
    expect(calls).toBe(0);
  });

  it("remembers an az failure for 10 minutes until the az login changes", () => {
    const dir = tmp("az-profile-");
    const profile = join(dir, "azureProfile.json");
    writeFileSync(profile, "﻿" + JSON.stringify({ subscriptions: [{ id: "synthetic" }] }));
    const env = { AZURE_CONFIG_DIR: dir };
    const resource = `res-${Date.now()}-${Math.random()}`;
    let calls = 0;
    const exec = () => (calls++, noLogin());
    let t = 1_000_000;
    const now = () => t;
    expect(() => azToken(exec, true, env, resource, now)).toThrow(/no credential/);
    expect(() => azToken(exec, true, env, resource, now)).toThrow(/a moment ago/);
    expect(calls).toBe(1);
    utimesSync(profile, new Date(), new Date(Date.now() + 5000)); // az login again
    expect(() => azToken(exec, true, env, resource, now)).toThrow(/no credential/);
    expect(calls).toBe(2);
    t += 11 * 60_000;
    expect(() => azToken(exec, true, env, resource, now)).toThrow(/no credential/);
    expect(calls).toBe(3);
  });

  it("status reads nothing remote and says to sign in, in one warning", async () => {
    const { dir } = makeRepo();
    sh(dir, ["checkout", "-b", "feature/7-csv"]);
    const f = fakeFetch([]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    ctx.env = { AIHUB_HOME: tmp("aihub-home-") };
    ctx.tokenCache = join(tmp("auth-"), "token.json"); // not the shared cache of this PC: a token left there by a real sign-in made signedIn true
    ctx.exec = noLogin as never;
    const t0 = Date.now();
    expect(await main(["status", "--json"], ctx)).toBe(0);
    const s = JSON.parse(lines.join(""));
    expect(s).toMatchObject({ signedIn: false, story: { id: 7, title: "(unknown)" }, pr: null });
    expect(s.warnings).toEqual(["sign-in: not signed in to Azure DevOps: run 'az login' or set AIHUB_ADO_PAT"]);
    expect(s.next).toMatch(/sign in to Azure DevOps/);
    expect(f.calls).toHaveLength(0);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("a refused credential", () => {
  it("stops the status reads after the first sign-in page", async () => {
    const { dir } = makeRepo();
    sh(dir, ["checkout", "-b", "feature/7-csv"]);
    const f = fakeFetch([{ match: /./, respond: () => ({ status: 203, text: "<html>sign in</html>", headers: { "content-type": "text/html" } }) }]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    expect(await main(["status", "--json"], ctx)).toBe(0);
    expect(JSON.parse(lines.join(""))).toMatchObject({ signedIn: false, pr: null });
    expect(f.calls).toHaveLength(1);
  });
});

describe("aihub bar", () => {
  it("returns status, watching and events in one process, and Fabric only with --fabric", async () => {
    const { dir } = makeRepo();
    sh(dir, ["checkout", "-b", "feature/7-csv"]);
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    ctx.env = { AIHUB_HOME: tmp("aihub-home-"), AIHUB_CONFIG_HOME: tmp("aihub-config-") };
    ctx.tokenCache = join(tmp("auth-"), "token.json"); // not the shared cache of this PC: a token left there by a real sign-in made signedIn true
    ctx.exec = noLogin as never;
    expect(await main(["bar", "--json"], ctx)).toBe(0);
    const b = JSON.parse(lines.join(""));
    expect(b.status).toMatchObject({ branch: "feature/7-csv", signedIn: false });
    expect(b.checks).toBeNull();
    expect(b.fabric).toBeNull();
    expect(b.watching).toBe(false);
    expect(Array.isArray(b.events)).toBe(true);
    lines.length = 0;
    expect(await main(["bar", "--json", "--fabric"], ctx)).toBe(0);
    expect(JSON.parse(lines.join("")).fabric).toMatchObject({ kind: "not-signed-in" });
  });

  it("classifies the Fabric answers that stay true until the branch or the settings change", () => {
    expect(fabricErrorKind("no single workspace named 'FEAT x' for branch feat/x; pass --workspace")).toBe("no-workspace");
    expect(fabricErrorKind("not signed in to Fabric: run 'az login' or set AIHUB_FABRIC_TOKEN")).toBe("not-signed-in");
    expect(fabricErrorKind("HTTP 500")).toBe("failed");
  });
});

describe("CLI performance log", () => {
  it("records each network call without query, token or e-mail, and appends once at exit", async () => {
    const dir = tmp("cli-perf-");
    startPerf({ AIHUB_PERF_LOG: dir }, ["status", "--json"]);
    const f = timedFetch((async () => new Response("{}", { status: 203 })) as typeof fetch);
    await f("https://user:pw@dev.azure.com/ferron-test/test-project/_apis/git/repositories?api-version=7.1&access_token=abc", { method: "GET" });
    perfRecord("cli.run", { ms: 5, startupMs: 200, code: 0 });
    flushPerf();
    const [file] = readdirSync(dir);
    expect(file).toMatch(/^aihub-cli-perf-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const text = readFileSync(join(dir, file), "utf8");
    const [net, run] = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(net).toMatchObject({ type: "net", cli: "status", method: "GET", host: "dev.azure.com", path: "/ferron-test/test-project/_apis/git/repositories", status: 203 });
    expect(run).toMatchObject({ type: "cli.run", startupMs: 200 });
    expect(text).not.toMatch(/access_token|api-version|pw@/);
    startPerf({}, []);
  });

  it("masks long tokens and e-mail addresses in paths", () => {
    expect(urlForLog("https://x.test/a/abcdefghij0123456789klmnopqrstuvwxyz0123456789abcdef/b").path).toBe("/a/<redacted>/b");
    expect(urlForLog("https://x.test/users/dev.person@example.test/x").path).toBe("/users/<email>/x");
  });
});

describe("git state of aihub status in two git calls plus the remote", () => {
  it("reads branch, changes and unpushed commits like the separate calls did", async () => {
    const { repoState, hasWorkToCommit, unpushedCount } = await import("../src/lib/gitx.js");
    const { dir } = makeRepo();
    // a branch with an upstream, one commit ahead, and a change
    sh(dir, ["checkout", "-b", "feature/7-csv"]);
    sh(dir, ["push", "-u", "origin", "feature/7-csv"]);
    writeFileSync(join(dir, "a.txt"), "a\n");
    sh(dir, ["add", "a.txt"]);
    sh(dir, ["commit", "-m", "a"]);
    writeFileSync(join(dir, "b.txt"), "b\n");
    let s = repoState(dir);
    expect(s).toMatchObject({ branch: "feature/7-csv", dirty: true, unpushed: 1 });
    expect(s.dirty).toBe(hasWorkToCommit(dir));
    expect(s.unpushed).toBe(unpushedCount(dir));
    expect(s.commonDir.replace(/\\/g, "/")).toMatch(/\/\.git$/);
    // no upstream yet: the commits not on any remote
    sh(dir, ["checkout", "-b", "feature/8-new"]);
    sh(dir, ["add", "b.txt"]);
    sh(dir, ["commit", "-m", "b"]);
    s = repoState(dir);
    expect(s).toMatchObject({ branch: "feature/8-new", dirty: false, unpushed: 2 });
    expect(s.unpushed).toBe(unpushedCount(dir));
    // build output is not work to commit
    writeFileSync(join(dir, "x.pyc"), "");
    expect(repoState(dir).dirty).toBe(false);
    sh(dir, ["checkout", "--detach"]);
    expect(() => repoState(dir)).toThrow(/detached HEAD/);
  });

  it("aihub status starts three git processes with an upstream: rev-parse, status, the remote (was six)", async () => {
    const { dir } = makeRepo();
    sh(dir, ["checkout", "-b", "feature/7-csv"]);
    sh(dir, ["push", "-u", "origin", "feature/7-csv"]);
    const log = tmp("cli-perf-");
    startPerf({ AIHUB_PERF_LOG: log }, ["status"]);
    const { ctx } = ctxFor(dir, fakeFetch([]).fn);
    ctx.env = { AIHUB_HOME: tmp("aihub-home-") };
    ctx.exec = noLogin as never;
    expect(await main(["status", "--json"], ctx)).toBe(0);
    flushPerf();
    startPerf({}, []);
    const procs = readdirSync(log).flatMap((f) => readFileSync(join(log, f), "utf8").trim().split("\n")).map((l) => JSON.parse(l)).filter((e) => e.type === "cli.proc" && e.cmd === "git");
    expect(procs.map((p) => p.sub)).toEqual(["rev-parse", "status", "config"]);
  });
});

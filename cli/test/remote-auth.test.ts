import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdoClient, parseRemote } from "../src/lib/ado.js";
import { makeAuth } from "../src/lib/auth.js";
import { fakeFetch } from "./helpers.js";

describe("parseRemote", () => {
  const want = { org: "ferron-org", project: "test-project", repo: "test-repo", orgUrl: "https://dev.azure.com/ferron-org" };
  it.each([
    "https://dev.azure.com/ferron-org/test-project/_git/test-repo",
    "https://ferron-org@dev.azure.com/ferron-org/test-project/_git/test-repo",
    "https://dev.azure.com/ferron-org/test-project/_git/test-repo.git",
    "git@ssh.dev.azure.com:v3/ferron-org/test-project/test-repo",
    "ferron-org@vs-ssh.visualstudio.com:v3/ferron-org/test-project/test-repo",
    "https://ferron-org.visualstudio.com/test-project/_git/test-repo",
    "https://ferron-org.visualstudio.com/DefaultCollection/test-project/_git/test-repo",
  ])("parses %s", (u) => {
    expect(parseRemote(u)).toEqual(want);
  });
  it("decodes spaces in names", () => {
    const r = parseRemote("https://dev.azure.com/ferron-org/Test%20Project/_git/test-repo");
    expect(r.project).toBe("Test Project");
  });
  it("rejects other hosts", () => {
    expect(() => parseRemote("https://github.com/a/b.git")).toThrow(/not an Azure DevOps remote/);
  });
});

describe("makeAuth", () => {
  const cache = () => join(mkdtempSync(join(tmpdir(), "aihub-auth-")), "tok.json");
  it("prefers the PAT env var (basic)", async () => {
    const a = makeAuth({ env: { AZURE_DEVOPS_EXT_PAT: "abc" }, exec: () => { throw new Error("no"); }, cacheFile: cache() });
    expect(await a()).toBe(`Basic ${Buffer.from(":abc").toString("base64")}`);
  });
  it("uses az and caches until expiry", async () => {
    const file = cache();
    let calls = 0;
    const exec = (cmd: string) => {
      calls++;
      expect(cmd).toBe("az");
      return JSON.stringify({ accessToken: "tok1", expires_on: 2000 });
    };
    expect(await makeAuth({ env: {}, exec, cacheFile: file, now: () => 1_000_000 })()).toBe("Bearer tok1");
    // a fresh provider reads the temp-file cache
    expect(await makeAuth({ env: {}, exec, cacheFile: file, now: () => 1_000_000 })()).toBe("Bearer tok1");
    expect(calls).toBe(1);
    // expired cache: az is asked again
    await makeAuth({ env: {}, exec, cacheFile: file, now: () => 3_000_000 })();
    expect(calls).toBe(2);
  });
  it("falls back to git credential fill", async () => {
    const exec = (cmd: string, args: string[], input?: string) => {
      if (cmd === "az") throw new Error("not logged in");
      expect(args).toEqual(["credential", "fill"]);
      expect(input).toContain("host=dev.azure.com");
      return "protocol=https\nhost=dev.azure.com\nusername=x\npassword=gitpat\n";
    };
    expect(await makeAuth({ env: {}, exec, cacheFile: cache() })()).toBe(`Basic ${Buffer.from(":gitpat").toString("base64")}`);
  });
  it("gives a one-line fix when nothing works", async () => {
    const exec = () => { throw new Error("x"); };
    await expect(makeAuth({ env: {}, exec, cacheFile: cache() })()).rejects.toThrow(/az login/);
  });
});

describe("AdoClient", () => {
  const remote = parseRemote("https://dev.azure.com/ferron-org/test-project/_git/test-repo");
  it("follows continuation tokens", async () => {
    const { fn, calls } = fakeFetch([
      {
        match: /pullrequests/,
        respond: (c) =>
          c.url.includes("continuationToken=t2")
            ? { body: { value: [{ n: 3 }] } }
            : c.url.includes("continuationToken=t1")
              ? { body: { value: [{ n: 2 }] }, headers: { "x-ms-continuationtoken": "t2" } }
              : { body: { value: [{ n: 1 }] }, headers: { "x-ms-continuationtoken": "t1" } },
      },
    ]);
    const c = new AdoClient(remote, async () => "Basic x", fn);
    const all = await c.list<{ n: number }>("git/repositories/test-repo/pullrequests");
    expect(all.map((x) => x.n)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain("api-version=7.1");
  });
  it("maps a 203 sign-in page to the az login hint", async () => {
    const { fn } = fakeFetch([{ match: /./, respond: () => ({ status: 203, text: "<html>sign in</html>" }) }]);
    const c = new AdoClient(remote, async () => "Basic x", fn);
    await expect(c.get("git/repositories/test-repo")).rejects.toThrow(/az login/);
  });
  it("reports 404 in one line", async () => {
    const { fn } = fakeFetch([{ match: /./, respond: () => ({ status: 404, body: { message: "TF401019: The Git repository does not exist" } }) }]);
    const c = new AdoClient(remote, async () => "Basic x", fn);
    await expect(c.get("git/repositories/nope")).rejects.toThrow(/not found \(404\).*TF401019/);
  });
});

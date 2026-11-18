import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FabricClient, makeFabricAuth } from "../src/lib/fabric.js";
import { tmp } from "./helpers.js";

describe("a stale cached token (live: OneLake said 'not signed in' until the cache file was deleted)", () => {
  it("makeFabricAuth.invalidate drops the memory and the file, the next call asks az again", async () => {
    const dir = tmp("fab401-");
    const cacheFile = join(dir, "token.json");
    writeFileSync(cacheFile, JSON.stringify({ token: "stale", expiresAt: Date.now() + 3_600_000 }));
    let azCalls = 0;
    const exec = () => (azCalls++, JSON.stringify({ accessToken: "fresh", expires_on: Math.floor(Date.now() / 1000) + 3600 }));
    const auth = makeFabricAuth({ env: {}, exec, cacheFile });
    expect(await auth()).toBe("Bearer stale"); // the cache is trusted until the service says no
    expect(azCalls).toBe(0);
    auth.invalidate!();
    expect(existsSync(cacheFile)).toBe(false);
    expect(await auth()).toBe("Bearer fresh");
    expect(azCalls).toBe(1);
  });

  it("FabricClient retries a 401 once with a fresh token; a second 401 is the 'not signed in' error", async () => {
    const dir = tmp("fab401-");
    const cacheFile = join(dir, "token.json");
    writeFileSync(cacheFile, JSON.stringify({ token: "stale", expiresAt: Date.now() + 3_600_000 }));
    const exec = () => JSON.stringify({ accessToken: "fresh", expires_on: Math.floor(Date.now() / 1000) + 3600 });
    const seen: string[] = [];
    const fetchFn = (async (_u: unknown, init: any) => {
      seen.push(init.headers.Authorization);
      return init.headers.Authorization === "Bearer fresh" ? new Response('{"value":[]}', { status: 200 }) : new Response("", { status: 401 });
    }) as typeof fetch;
    const client = new FabricClient(makeFabricAuth({ env: {}, exec, cacheFile }), fetchFn, { waitScale: 0 });
    const r = await client.request("GET", "/workspaces");
    expect(r.status).toBe(200);
    expect(seen).toEqual(["Bearer stale", "Bearer fresh"]);

    const always401 = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const c2 = new FabricClient(makeFabricAuth({ env: {}, exec, cacheFile: join(dir, "other.json") }), always401, { waitScale: 0 });
    await expect(c2.request("GET", "/workspaces")).rejects.toThrow(/not signed in to Fabric/);
  });

  it("a token from AIHUB_FABRIC_TOKEN is not retried forever: one more try, then the error", async () => {
    let calls = 0;
    const fetchFn = (async () => (calls++, new Response("", { status: 401 }))) as unknown as typeof fetch;
    const client = new FabricClient(makeFabricAuth({ env: { AIHUB_FABRIC_TOKEN: "x" }, exec: () => "", cacheFile: join(tmp("fab401-"), "t.json") }), fetchFn, { waitScale: 0 });
    await expect(client.request("GET", "/workspaces")).rejects.toThrow(/not signed in to Fabric/);
    expect(calls).toBe(2);
  });
});

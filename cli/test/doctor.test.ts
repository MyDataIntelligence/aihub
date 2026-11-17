import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write } from "./helpers.js";

async function doctor(dir: string, env: NodeJS.ProcessEnv, exec?: (c: string, a: string[]) => string) {
  const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
  ctx.env = env;
  ctx.exec = exec as any;
  const code = await main(["doctor", "--json"], ctx);
  return { code, report: JSON.parse(lines.join("")) as { ok: boolean; checks: { name: string; status: string; detail: string; fix?: string }[] } };
}
const by = (r: { checks: { name: string }[] }, n: string) => r.checks.find((c) => c.name === n)!;

describe("aihub doctor", () => {
  it("reports FIX with the fix for an empty repository", async () => {
    const { dir } = makeRepo();
    const h = tmp("aihub-home-");
    const { report } = await doctor(dir, { HOME: h, USERPROFILE: h }, () => {
      throw new Error("no");
    });
    expect(report.ok).toBe(false);
    expect(by(report, "node").status).toBe("OK");
    expect(by(report, "remote").detail).toBe("ferron-org/test-project/test-repo");
    expect(by(report, "auth")).toMatchObject({ status: "FIX" });
    expect(by(report, "team.yaml").fix).toContain("aihub init");
    expect(by(report, "pr-template").status).toBe("FIX");
    expect(by(report, "skills:codex").fix).toContain("aihub skills install --client codex --global");
  });

  it("recognises PAT, az token and git credential as sign-in methods", async () => {
    const { dir } = makeRepo();
    const h = tmp("aihub-home-");
    const base = { HOME: h, USERPROFILE: h };
    expect(by((await doctor(dir, { ...base, AIHUB_ADO_PAT: "x" })).report, "auth").detail).toContain("PAT");
    const az = (await doctor(dir, base, (c) => (c === "az" ? JSON.stringify({ accessToken: "t" }) : ""))).report;
    expect(by(az, "auth").detail).toContain("Azure CLI");
    const gc = (await doctor(dir, base, (c) => { if (c === "az") throw new Error("x"); return "password=abc\n"; })).report;
    expect(by(gc, "auth").detail).toContain("git credential");
  });

  it("is OK with a valid team file, PR template and installed skills; flags an invalid team file", async () => {
    const { dir } = makeRepo();
    const h = tmp("aihub-home-");
    const env = { HOME: h, USERPROFILE: h, AIHUB_ADO_PAT: "x" };
    const init = ctxFor(dir, fakeFetch([]).fn);
    await main(["init", "--no-pr"], init.ctx);
    const inst = ctxFor(dir, fakeFetch([]).fn);
    inst.ctx.env = env;
    await main(["skills", "install", "--global", "--client", "opencode"], inst.ctx);
    const ok = (await doctor(dir, env)).report;
    expect(by(ok, "team.yaml").status).toBe("OK");
    expect(by(ok, "pr-template").detail).toContain(".azuredevops/pull_request_template.md");
    expect(by(ok, "skills:opencode").status).toBe("OK");
    expect(by(ok, "skills:codex").status).toBe("FIX");

    write(dir, ".agents/skills/_shared/references/team.yaml", "version: 1\nlanguage: nl\n");
    const bad = (await doctor(dir, env)).report;
    expect(by(bad, "team.yaml").status).toBe("FIX");
    expect(by(bad, "team.yaml").detail).toContain("missing azureDevOps.organization");
    void join; void sh;
  });
});

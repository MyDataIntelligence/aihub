import { describe, expect, it } from "vitest";
import { CliError } from "../src/cli";
import { CliProblem, ensureCli, type CliMemo } from "../src/bar/cliCheck";

const stub = (answer: string | Error) => {
  const calls: string[][] = [];
  return { calls, run: async (a: string[]) => (calls.push(a), typeof answer === "string" ? answer : Promise.reject(answer)) };
};

describe("the buttons check the aihub CLI once and say it in a plain sentence", () => {
  it("a good CLI passes and is asked once, not at every click", async () => {
    const s = stub("1.8.2\n");
    const memo: CliMemo = {};
    expect(await ensureCli(s.run, "C:/x", memo)).toBe("1.8.2");
    await ensureCli(s.run, "C:/x", memo);
    await ensureCli(s.run, "C:/y", memo);
    expect(s.calls).toEqual([["--version"]]);
  });

  it("a CLI older than 1.8.2 gives the version, the needed one and the update command; never usage text", async () => {
    const s = stub("1.8.1");
    const e = await ensureCli(s.run, "C:/x", {}).catch((x) => x);
    expect(e).toBeInstanceOf(CliProblem);
    expect(e.kind).toBe("old");
    expect(e.message).toBe("The aihub CLI on this PC is 1.8.1; the buttons need 1.8.2 or newer. Update it with: npm i -g @ferronhooi/aihub");
    expect(e.updateCommand).toBe("npm i -g @ferronhooi/aihub");
    expect(e.message).not.toContain("usage");
  });

  it("a missing CLI says so; the problem is remembered for two minutes, then asked again (the user may have updated)", async () => {
    const s = stub(new CliError("missing", "aihub was not found"));
    const memo: CliMemo = {};
    let t = 1000;
    const o = { now: () => t };
    await expect(ensureCli(s.run, "C:/x", memo, o)).rejects.toMatchObject({ kind: "missing" });
    await expect(ensureCli(s.run, "C:/x", memo, o)).rejects.toMatchObject({ kind: "missing" });
    expect(s.calls).toHaveLength(1);
    t += 121_000;
    await expect(ensureCli(s.run, "C:/x", memo, o)).rejects.toMatchObject({ kind: "missing" });
    expect(s.calls).toHaveLength(2);
  });

  it("a timeout does not block and is not remembered", async () => {
    const s = stub(new CliError("timeout", "took too long"));
    const memo: CliMemo = {};
    expect(await ensureCli(s.run, "C:/x", memo)).toBeUndefined();
    expect(memo.seen).toBeUndefined();
  });
});

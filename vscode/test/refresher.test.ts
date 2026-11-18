import { describe, expect, it } from "vitest";
import { CliError } from "../src/cli";
import { buildModel } from "../src/model";
import { Refresher, type Result } from "../src/refresher";

const model = buildModel({ status: { branch: "x" } });

function make(load: () => Promise<typeof model>, gap = 60_000) {
  const results: Result[] = [];
  let t = 1_000_000;
  const r = new Refresher(load, (x) => results.push(x), { minGapMs: () => gap, now: () => t });
  return { r, results, advance: (ms: number) => (t += ms) };
}

describe("Refresher", () => {
  it("makes at most two reads for a burst of triggers", async () => {
    let n = 0;
    const { r } = make(async () => {
      n++;
      await new Promise((x) => setTimeout(x, 20));
      return model;
    });
    await Promise.all([r.request("manual"), r.request("manual"), r.request("manual")]);
    await new Promise((x) => setTimeout(x, 80));
    expect(n).toBeLessThanOrEqual(2);
  });

  it("does not poll while the window is not focused, but a manual refresh works", async () => {
    let n = 0;
    const { r, advance } = make(async () => (n++, model));
    r.focused = false;
    advance(10 * 60_000);
    await r.request("timer");
    expect(n).toBe(0);
    await r.request("manual");
    expect(n).toBe(1);
  });

  it("skips automatic triggers while the last read is fresh", async () => {
    let n = 0;
    const { r, advance } = make(async () => (n++, model));
    await r.request("start");
    await r.request("timer");
    expect(n).toBe(1);
    advance(31_000);
    await r.request("timer");
    expect(n).toBe(2);
  });

  it("publishes a typed error and keeps the last good model", async () => {
    let fail = false;
    const { r, results, advance } = make(async () => {
      if (fail) throw new CliError("missing", "aihub was not found. Install it with: npm i -g @ferronhooi/aihub");
      return model;
    });
    await r.request("manual");
    fail = true;
    advance(1);
    await r.request("manual");
    const last = results[1];
    expect(last.ok).toBe(false);
    if (!last.ok) {
      expect(last.error.kind).toBe("missing");
      expect(last.last).toBe(model);
    }
  });
});

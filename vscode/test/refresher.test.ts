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

  it("backs off automatic triggers by 10x a slow read's duration", async () => {
    let n = 0;
    const { r, advance } = make(async () => {
      n++;
      advance(20_000); // the read takes 20 s
      return model;
    });
    await r.request("manual");
    advance(100_000);
    await r.request("timer"); // 100 s after the read: still backed off
    expect(n).toBe(1);
    advance(101_000);
    await r.request("timer"); // 201 s after the read: runs
    expect(n).toBe(2);
  });

  it("does not delay a manual refresh after a slow read", async () => {
    let n = 0;
    const { r, advance } = make(async () => {
      n++;
      advance(20_000);
      return model;
    });
    await r.request("manual");
    await r.request("manual");
    expect(n).toBe(2);
  });

  it("does not delay timer refreshes after a fast read", async () => {
    let n = 0;
    const { r, advance } = make(
      async () => {
        n++;
        advance(1_000);
        return model;
      },
      60_000,
    );
    await r.request("manual");
    advance(30_000); // 31 s after the read finished
    await r.request("timer");
    expect(n).toBe(2);
  });

  it("caps the back-off at 10 minutes", async () => {
    let n = 0;
    const { r, advance } = make(async () => {
      n++;
      advance(120_000); // the read takes 120 s; 10x would be 1200 s
      return model;
    });
    await r.request("manual");
    advance(599_000);
    await r.request("timer"); // 599 s after the read: still backed off
    expect(n).toBe(1);
    advance(2_000);
    await r.request("timer"); // 601 s after the read: runs
    expect(n).toBe(2);
  });
});

describe("Refresher without a timer (the old status bar)", () => {
  it("a branch change reads at once, a focus only after 5 minutes, nothing without focus until the focus is back", async () => {
    let n = 0;
    const { r, advance } = make(async () => (n++, model));
    await r.request("start");
    await r.request("git");
    expect(n).toBe(2);
    advance(60_000);
    await r.request("focus");
    expect(n).toBe(2);
    advance(5 * 60_000);
    await r.request("focus");
    expect(n).toBe(3);
    r.focused = false;
    await r.request("git");
    expect(n).toBe(3);
    r.focused = true;
    await r.request("focus");
    expect(n).toBe(4);
  });

  it("a failed read is not tried again by itself for 5 minutes, but a branch change tries", async () => {
    let n = 0;
    const { r, advance } = make(async () => {
      n++;
      throw new CliError("failed", "offline");
    });
    await r.request("start");
    advance(60_000);
    await r.request("focus");
    expect(n).toBe(1);
    await r.request("git");
    expect(n).toBe(2);
    advance(6 * 60_000);
    await r.request("focus");
    expect(n).toBe(3);
  });
});

import { describe, expect, it } from "vitest";
import { renderBody, renderError } from "../src/html";
import { buildModel, toFabric } from "../src/model";
import { popupFor } from "../src/popups";
import { fx } from "./helpers";

const m = buildModel({ status: fx("status"), checks: fx("pr-checks"), fabric: toFabric(fx("fabric-failures"), fx("fabric-logs")), events: [{ id: "1", message: "<b>new</b> comment", at: 1000 }], now: 2000 });

describe("compact bar", () => {
  it("is one strip: main button, chips, refresh and the overflow menu, no tables or paragraphs", () => {
    const h = renderBody(m, 2000);
    expect(h.match(/class="bar-row"/g)).toHaveLength(1);
    for (const s of ["#1234", "!45", "1✓", "pipeline", "red", "Fabric", "1 failed", 'data-id="events"', 'data-id="refresh"', 'data-id="menu"']) expect(h).toContain(s === "pipeline" ? "data-id=\"pipeline\"" : s === "Fabric" ? "database" : s);
    expect(h).not.toContain("<table");
    expect(h.length).toBeLessThan(5000);
  });

  it("puts the state's main action on the button, as a chat action", () => {
    expect(renderBody(m, 2000)).toContain('data-act="chat" data-id="fabric-failures"');
    expect(renderBody(buildModel({ status: fx("status-quiet") }), 2000)).toContain('data-act="chat" data-id="start"');
  });

  it("escapes text from the CLI", () => {
    const h = renderBody(buildModel({ status: { ...fx("status"), story: { id: 1, title: "<img src=x>", state: "Doing" } } }), 2000);
    expect(h).not.toContain("<img");
  });

  it("shows one message and an install chip when the CLI is missing", () => {
    const h = renderError({ kind: "missing", message: "aihub was not found. Install it with: npm i -g @ferronhooi/aihub" });
    expect(h).toContain("npm i -g @ferronhooi/aihub");
    expect(h).toContain('data-id="installHelp"');
  });
});

describe("chip pick lists", () => {
  it("lists the reviewers with their votes and the blockers behind the PR chip", () => {
    const p = popupFor("pr", m);
    const labels = p.items.map((i) => `${i.label} ${i.description ?? ""}`);
    expect(labels).toContain("Bob approved");
    expect(labels).toContain("Ann waiting for the author");
    expect(p.items.some((i) => i.run.kind === "command" && i.run.id === "aihub.openPr")).toBe(true);
  });

  it("lists Fabric runs and offers the chat action only when something failed", () => {
    const p = popupFor("fabric", m);
    expect(p.items.map((i) => i.label).join("|")).toContain("load_orders  Failed");
    expect(p.items.some((i) => i.run.kind === "chat" && i.run.id === "fabric-failures")).toBe(true);
    expect(popupFor("fabric", buildModel({ status: fx("status") })).items[0].label).toContain("no Fabric");
  });

  it("lists the events and the full action menu", () => {
    expect(popupFor("events", m, 2000).items[0].label).toBe("<b>new</b> comment");
    const menu = popupFor("menu", m);
    expect(menu.items.filter((i) => i.run.kind === "chat").length).toBeGreaterThan(3);
    expect(menu.items.some((i) => i.run.kind === "command" && i.run.id === "aihub.refresh")).toBe(true);
  });
});

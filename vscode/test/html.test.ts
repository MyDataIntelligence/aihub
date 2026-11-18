import { describe, expect, it } from "vitest";
import { renderBody, renderError } from "../src/html";
import { buildModel, toFabric } from "../src/model";
import { fx } from "./helpers";

describe("panel html", () => {
  const m = buildModel({ status: fx("status"), checks: fx("pr-checks"), fabric: toFabric(fx("fabric-failures"), fx("fabric-logs")), events: [{ id: "1", message: "<b>new</b> comment", at: 1000 }], now: 2000 });

  it("shows every section and the actions as chat buttons", () => {
    const h = renderBody(m, 2000);
    for (const s of ["#1234", "!45 active", "pipeline red", "2 open threads", "Fabric:", "FEAT 1234 add export", "load_orders", "Events"]) expect(h).toContain(s);
    expect(h).toContain('data-act="chat" data-id="fabric-failures"');
    expect(h).toContain('data-act="refresh"');
  });

  it("escapes text from the CLI", () => {
    const h = renderBody(m, 2000);
    expect(h).not.toContain("<b>new</b>");
    expect(h).toContain("&lt;b&gt;new&lt;/b&gt;");
  });

  it("shows one clear message with an install button when the CLI is missing", () => {
    const h = renderError({ kind: "missing", message: "aihub was not found. Install it with: npm i -g @ferronhooi/aihub" });
    expect(h).toContain("npm i -g @ferronhooi/aihub");
    expect(h).toContain('data-act="installHelp"');
  });
});

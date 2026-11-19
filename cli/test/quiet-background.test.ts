import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { bundleText, deliver, readWatchConfig, setNotifyMode, setQuiet, TOAST_GAP_MS, type ToastItem } from "../src/lib/notifyPolicy.js";
import { notifyCommand } from "../src/lib/watch.js";
import { openEvent } from "../src/lib/open.js";
import { withHidden } from "../src/lib/proc.js";
import { runMine } from "../src/lib/watchMine.js";
import { listEvents } from "../src/lib/open.js";
import { ctxFor, fakeFetch, makeRepo } from "./helpers.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

describe("every child process is hidden on Windows", () => {
  it("withHidden adds windowsHide to the options of spawn/spawnSync, in every call shape", () => {
    expect(withHidden(["git", ["status"]])).toEqual(["git", ["status"], { windowsHide: true }]);
    expect(withHidden(["git", ["status"], { cwd: "x" }])).toEqual(["git", ["status"], { cwd: "x", windowsHide: true }]);
    expect(withHidden(["cmd", { shell: true }])).toEqual(["cmd", { shell: true, windowsHide: true }]);
    expect(withHidden(["git"])).toEqual(["git", { windowsHide: true }]);
    // a window that is the point (the terminal aihub open starts for the developer) says so explicitly
    expect(withHidden(["wt.exe", [], { windowsHide: false }])).toEqual(["wt.exe", [], { windowsHide: false }]);
  });

  it("no source file starts a process except through lib/proc.ts", () => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && e.name !== "proc.ts" && /from "(node:)?child_process"/.test(readFileSync(p, "utf8"))) bad.push(p);
      }
    };
    walk(join(__dirname, "..", "src"));
    expect(bad).toEqual([]);
  });

  it("the toast runs PowerShell hidden and non-interactive, and the protocol handler has no console", () => {
    const c = notifyCommand("win32", "aihub", "x", { label: "Open", url: "aihub://open?event=1", secondary: { label: "Stil 1 uur", url: "aihub://quiet?for=1h" } })!;
    expect(c.cmd).toBe("powershell.exe");
    expect(c.args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command"]);
    expect(c.args.at(-1)).toContain('<action content="Stil 1 uur" arguments="aihub://quiet?for=1h"');
  });
});

const item = (message: string, over: Partial<ToastItem> = {}): ToastItem => ({ message, needed: false, url: `aihub://open?event=${message.length}`, ...over });

describe("one toast per poll round", () => {
  const env = () => ({ AIHUB_CONFIG_HOME: mkdtempSync(join(tmpdir(), "aihub-cfg-")) });
  const sink = () => {
    const toasts: { title: string; message: string; action: { label: string; url: string; secondary?: { label: string; url: string } } }[] = [];
    return { toasts, fn: (title: string, message: string, action: { label: string; url: string; secondary?: { label: string; url: string } }) => (toasts.push({ title, message, action }), true) };
  };
  const three = [item("a commented on !42", { pr: 42, what: "comment" }), item("b commented on !42", { pr: 42, what: "comment" }), item("review asked on !51", { pr: 51, what: "review gevraagd", needed: true })];

  it("sums 3 events up in ONE toast with Open and Stil 1 uur", async () => {
    const e = env();
    setNotifyMode(e, "all");
    const s = sink();
    const r = await deliver(e, 1_000_000, s.fn, three, { bundle: true });
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0].title).toBe("aihub · 3 nieuwe dingen");
    expect(s.toasts[0].message).toBe("!42 2 comments · review gevraagd op !51");
    expect(s.toasts[0].action.secondary).toEqual({ label: "Stil 1 uur", url: "aihub://quiet?for=1h" });
    expect(r.shown).toHaveLength(3);
  });

  it("the default (needed) toasts only what needs you; a plain comment waits in the digest", async () => {
    const e = env();
    expect(readWatchConfig(e).notify).toBe("needed");
    const s = sink();
    const r = await deliver(e, 1_000_000, s.fn, three, { bundle: true });
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0].message).toBe("review asked on !51");
    expect(r.skipped).toBe(2);
    const none = await deliver(e, 5_000_000, s.fn, [item("plain comment", { pr: 1, what: "comment" })], { bundle: true });
    expect(none.shown).toEqual([]);
    expect(s.toasts).toHaveLength(1);
  });

  it("never more than one toast per 2 minutes: the next round waits and joins the next toast", async () => {
    const e = env();
    setNotifyMode(e, "all");
    const s = sink();
    await deliver(e, 1_000_000, s.fn, [item("first", { needed: true })], { bundle: true });
    const held = await deliver(e, 1_000_000 + 60_000, s.fn, [item("second", { needed: true })], { bundle: true });
    expect(held.held).toBe(1);
    expect(s.toasts).toHaveLength(1);
    // a quiet round after the gap still delivers what was held
    await deliver(e, 1_000_000 + TOAST_GAP_MS + 1, s.fn, [], { bundle: true });
    expect(s.toasts).toHaveLength(2);
    expect(s.toasts[1].message).toBe("second");
  });

  it("off and quiet time keep every toast away", async () => {
    const e = env();
    const s = sink();
    setNotifyMode(e, "off");
    await deliver(e, 1_000_000, s.fn, [item("x", { needed: true })], { bundle: true });
    setNotifyMode(e, "all");
    setQuiet(e, 2_000_000);
    await deliver(e, 1_500_000, s.fn, [item("y", { needed: true })], { bundle: false });
    expect(s.toasts).toEqual([]);
    await deliver(e, 2_000_001, s.fn, [item("z", { needed: true })], { bundle: false });
    expect(s.toasts).toHaveLength(1);
  });

  it("bundleText shortens many items", () => {
    const many = Array.from({ length: 7 }, (_, i) => item(`thing ${i}`, { pr: i + 1, what: "review gevraagd" }));
    expect(bundleText(many).body).toMatch(/\+3 meer$/);
  });
});

describe("aihub watch config / quiet and the toast's Stil button", () => {
  it("sets the notify level and a quiet time in the user config", async () => {
    const { dir } = makeRepo();
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    ctx.now = () => Date.parse("2026-11-19T10:00:00Z");
    expect(await main(["watch", "config", "--notify", "all"], ctx, commands)).toBe(0);
    expect(readWatchConfig(ctx.env).notify).toBe("all");
    expect(await main(["watch", "config", "--notify", "loud"], ctx, commands)).toBe(1);
    expect(await main(["watch", "quiet", "--for", "1h"], ctx, commands)).toBe(0);
    expect(readWatchConfig(ctx.env).quietUntil).toBe(Date.parse("2026-11-19T11:00:00Z"));
    expect(lines.at(-1)).toContain("no toasts until 2026-11-19 11:00");
    expect(await main(["watch", "quiet", "--off"], ctx, commands)).toBe(0);
    expect(readWatchConfig(ctx.env).quietUntil).toBeUndefined();
    ctx.now = () => Date.parse("2026-11-19T12:00:00Z");
    expect(openEvent(ctx, { url: "aihub://quiet?for=1h" })).toContain("quiet until");
    expect(readWatchConfig(ctx.env).quietUntil).toBe(Date.parse("2026-11-19T13:00:00Z"));
  });
});

describe("watch --mine with the default level", () => {
  it("a plain comment on my PR raises no toast but is in the digest (watch events)", async () => {
    const { dir } = makeRepo();
    const ME = { id: "me-guid", name: "Ferron Test" };
    const pr = { pullRequestId: 7, title: "T", status: "active", createdBy: { id: ME.id, displayName: ME.name }, reviewers: [], repository: { id: "repo-1", name: "test-project", project: { id: "proj-1" } } };
    const thread = { id: 1, status: "active", comments: [{ id: 1, content: "nieuwe vraag", author: { id: "anna", displayName: "Anna" }, commentType: "text" }] };
    const f = fakeFetch([
      { match: /connectionData\?/, respond: () => ({ body: { authenticatedUser: { id: ME.id, customDisplayName: ME.name } } }) },
      { match: /\/git\/pullrequests\?/, respond: (c) => ({ body: { value: c.url.includes("creatorId") ? [pr] : [] } }) },
      { match: /\/threads\?/i, respond: () => ({ body: { value: [thread] } }) },
      { match: /\/policy\/evaluations\?/, respond: () => ({ body: { value: [] } }) },
      { method: "POST", match: /\/wit\/wiql\?/, respond: () => ({ body: { workItems: [] } }) },
      { match: /\/build\/builds\?/, respond: () => ({ body: { value: [] } }) },
    ]);
    const { ctx } = ctxFor(dir, f.fn);
    const toasts: string[] = [];
    const spec = { id: "mine", mine: true, until: "done" as const, notify: true, timeoutMs: Number.MAX_SAFE_INTEGER, intervalMs: 1000, started: 0 };
    const r = await runMine(ctx, spec, { notifier: (_t, m) => (toasts.push(m), true), maxPolls: 1, includeExisting: true });
    expect(r.reported).toHaveLength(1);
    expect(toasts).toEqual([]);
    expect(listEvents(ctx.env).map((e) => e.message).join("\n")).toContain("nieuwe vraag");
  });
});

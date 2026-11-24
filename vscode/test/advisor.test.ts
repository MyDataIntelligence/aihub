import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { covered, pickNotification, vscodeFindings, type AdvisorFinding } from "../src/advisorModel";
import { crc32, exportZip, maskOutsidePaths, periodStart, zip } from "../src/perf/export";
import { fileDay } from "../src/perf/log";
import { mdToHtml } from "../src/perf/mdhtml";
import { findSecrets, Scrubber } from "../src/perf/scrub";

const tmp = () => mkdtempSync(join(tmpdir(), "aihub-adv-"));

/** Reads a zip written by zip(): name -> content. */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const comp = buf.readUInt32LE(o + 18);
    const crc = buf.readUInt32LE(o + 14);
    const nameLen = buf.readUInt16LE(o + 26);
    const name = buf.subarray(o + 30, o + 30 + nameLen).toString("utf8");
    const data = inflateRawSync(buf.subarray(o + 30 + nameLen, o + 30 + nameLen + comp));
    expect(crc32(data)).toBe(crc);
    out[name] = data.toString("utf8");
    o += 30 + nameLen + comp;
  }
  return out;
}

describe("VS Code part of the Performance Advisor", () => {
  it("proposes watcher and search excludes only for large folders that are not excluded yet", () => {
    const folders = [{ name: "test-project", heavy: [{ dir: "node_modules", files: 2000 }, { dir: ".venv", files: 900 }, { dir: "build", files: 12 }] }];
    const [f] = vscodeFindings(folders, { "**/node_modules/*/**": true }, {});
    expect(f.id).toBe("vscode:exclude");
    expect(f.settings).toEqual([
      { key: "files.watcherExclude", add: { "**/.venv/**": true } },
      { key: "search.exclude", add: { "**/node_modules/**": true, "**/.venv/**": true } },
    ]);
    expect(f.evidence).toContain(".venv: 900 files, not in files.watcherExclude");
    expect(f.scope).toBe("user");
    expect(vscodeFindings(folders, { "**/node_modules/**": true, "**/.venv/**": true }, { "**/node_modules": true, "**/.venv": true })).toEqual([]);
    expect(vscodeFindings([{ name: "x", heavy: [{ dir: "dist", files: 150 }] }], {}, {})).toEqual([]);
    expect(covered(".git/objects", { "**/.git/objects/**": true })).toBe(true);
    expect(covered("node_modules", { "**/node_modules/**": false })).toBe(false);
  });

  it("offers at most one notification a day, each finding once, never a refused one or plain advice", () => {
    const f = (id: string, scope: AdvisorFinding["scope"] = "user") => ({ id, scope }) as AdvisorFinding;
    const all = [f("onedrive:a", "info"), f("defender", "admin"), f("git:a")];
    const day = 86_400_000;
    expect(pickNotification(all, { offered: [], never: [] }, 10 * day)?.id).toBe("defender");
    expect(pickNotification(all, { offered: ["defender"], never: [], lastAt: 10 * day }, 10 * day + 3_600_000)).toBeUndefined(); // same day
    expect(pickNotification(all, { offered: ["defender"], never: [], lastAt: 10 * day }, 11 * day + 1)?.id).toBe("git:a");
    expect(pickNotification(all, { offered: ["defender"], never: ["git:a"], lastAt: 0 }, 11 * day)).toBeUndefined();
  });
});

describe("export from the report", () => {
  const PAT = "abcdefghij0123456789klmnopqrstuvwxyz0123456789abcdef";

  it("zips report.md, the logs of the period and system.txt, without secrets or paths outside the workspace", async () => {
    const dir = tmp();
    const now = Date.now();
    const day = fileDay(now);
    const ev = (t: number, extra: Record<string, unknown>) => JSON.stringify({ t, type: "proc", cmd: "git", ...extra });
    writeFileSync(join(dir, `aihub-perf-${day}.jsonl`), [ev(now - 10_000, { args: ["--token", PAT], cwd: "C:\\work\\test-project\\src" }), ev(now - 2 * 3_600_000, { old: true })].join("\n") + "\n");
    writeFileSync(join(dir, `aihub-cli-perf-${day}.jsonl`), JSON.stringify({ t: now - 5000, type: "net", host: "dev.azure.com", path: "/ferron-test/x", note: "mail dev.person@example.test C:\\Users\\someone\\secret.txt" }) + "\n");
    const { zip: z, files } = await exportZip({
      dir,
      from: periodStart("hour", now),
      to: now,
      reportMd: `# AI Context Hub: performance report\n\nLog: \`C:\\Users\\someone\\AppData\\perf\`\n\n| a | b |\n|---|---|\n| Bearer ${PAT} | x |\n`,
      system: { vscode: "1.147.0", extension: "3.2.1", cli: "1.1.1", node: "22", os: "Windows_NT 10.0 x64", vm: "yes (Microsoft Corporation Virtual Machine)" },
      scrubber: new Scrubber({ roots: ["C:\\work\\test-project"], home: "C:\\Users\\someone" }),
    });
    expect([...files].sort()).toEqual(["report.md", `logs/aihub-cli-perf-${day}.jsonl`, `logs/aihub-perf-${day}.jsonl`, "system.txt"].sort());
    const content = unzip(z);
    const all = Object.values(content).join("\n");
    expect(findSecrets(all)).toEqual([]);
    expect(all).not.toContain(PAT);
    expect(all).not.toMatch(/someone|C:\\\\Users|C:\\Users/);
    expect(content[`logs/aihub-perf-${day}.jsonl`].trim().split("\n")).toHaveLength(1); // the event of 2 h ago is outside the last hour
    expect(content[`logs/aihub-perf-${day}.jsonl`]).toContain('"cwd":"src"');
    expect(content["system.txt"]).toContain("Virtual machine: yes");
  });

  it("masks only absolute paths, not URLs or relative paths", () => {
    expect(maskOutsidePaths("see https://dev.azure.com/x and src/a.py and D:\\data\\x and \\\\server\\share\\y")).toBe("see https://dev.azure.com/x and src/a.py and <path> and <path>");
  });

  it("writes a valid zip", () => {
    const c = unzip(zip([{ name: "a.txt", data: Buffer.from("hello") }]));
    expect(c).toEqual({ "a.txt": "hello" });
  });

  it("knows the periods", () => {
    const now = new Date(2026, 10, 24, 15, 30).getTime();
    expect(periodStart("hour", now)).toBe(now - 3_600_000);
    expect(periodStart("today", now)).toBe(new Date(2026, 10, 24).getTime());
    expect(periodStart("7d", now)).toBe(now - 7 * 86_400_000);
  });

  it("renders the report markdown as HTML for the panel", () => {
    const h = mdToHtml("# Title\n\nText with `code` and **bold**.\n\n| A | B |\n|---|---:|\n| x \\| y | 2 |\n\n- one\n- two");
    expect(h).toContain("<h1>Title</h1>");
    expect(h).toContain("<code>code</code>");
    expect(h).toContain('<td style="text-align:left">x | y</td><td style="text-align:right">2</td>');
    expect(h).toContain("<ul><li>one</li><li>two</li></ul>");
  });
});

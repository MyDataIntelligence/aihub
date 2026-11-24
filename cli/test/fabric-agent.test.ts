import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { errorExcerpt } from "../src/lib/fabric-digest.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

// One call per agent task, small output: the Fabric cases of the aihub benchmark (F01-F05) as unit tests with fetch stubs.

const WS = "11111111-1111-1111-1111-111111111111";
const TEAM = `version: 1
repositories:
  - name: test-repo
    defaultTarget: main
fabric:
  workspaces:
    - { name: aihub-test-dev-bench, id: ${WS}, environment: dev }
    - { name: ACC-test-project, id: 33333333-3333-3333-3333-333333333333, environment: acc }
`;
const ENV = { AIHUB_FABRIC_TOKEN: "fabric-token", AIHUB_POLL_MS: "0" };

function repo(): string {
  const { dir } = makeRepo();
  write(dir, ".agents/skills/_shared/references/team.yaml", TEAM);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "team"]);
  return dir;
}

async function go(routes: Route[], args: string[], dir = repo()) {
  const f = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(dir, f.fn);
  ctx.env = { ...ctx.env, ...ENV };
  const code = await main(["fabric", ...args], ctx);
  return { code, lines, errs, calls: f.calls, out: lines.join("\n") };
}

const get = (re: RegExp, body: unknown): Route => ({ match: re, respond: () => ({ body }) });
const post = (re: RegExp, body: unknown = {}): Route => ({ method: "POST", match: re, respond: () => ({ body }) });
const text = (re: RegExp, t: string): Route => ({ match: re, respond: () => ({ text: t }) });
const bytes = (s: string) => Buffer.byteLength(s);

const ITEMS = [
  { id: "lh-1", displayName: "lh_bench", type: "Lakehouse" },
  { id: "nb-ok", displayName: "nb_bench_ok", type: "Notebook" },
  { id: "nb-fail", displayName: "nb_bench_fail", type: "Notebook" },
  { id: "nb-edit", displayName: "nb_bench_edit", type: "Notebook" },
  { id: "sql-1", displayName: "lh_bench", type: "SQLEndpoint" },
];
const items = get(new RegExp(`/workspaces/${WS}/items$`), { value: ITEMS });

// a driver log shaped like a real one: YARN framing, thousands of INFO lines (some naming an "Exception"), the IPython traceback near the end
const NOISE = Array.from({ length: 4000 }, (_, i) => `2026-11-24 19:28:${String(i % 60).padStart(2, "0")},991 INFO TokenLibraryInternal [AsyncAppender-Dispatcher-Thread-0]: CacheMissException for Key: conf:fs.azure.sas.${i} !`).join("\n");
const STDERR = `Container: container_01 on vm-1\nLogType:stderr\n${NOISE}\nEnd of LogType:stderr\n***********************************************************************\n`;
const STDOUT = [
  "Container: container_01 on vm-1",
  "LogType:stdout",
  ...Array.from({ length: 450 }, (_, i) => `profiling:/__w/1/s/cpp/x${i}.gcda:Skip`),
  "---------------------------------------------------------------------------",
  "ValueError                                Traceback (most recent call last)",
  "Cell In[12], line 6",
  "      4 ontbreekt = [k for k in verwacht if k not in kolommen]",
  "      5 if ontbreekt:",
  "----> 6     raise ValueError(code + ': kolom ' + ontbreekt[0] + ' ontbreekt in het bronbestand klanten.csv')",
  "",
  "ValueError: BENCH-abc123-ERR: kolom klantnummer ontbreekt in het bronbestand klanten.csv",
  "",
  "End of LogType:stdout",
  "***********************************************************************",
].join("\n");

const failedJob = { id: "jf", status: "Failed", jobType: "RunNotebook", invokeType: "Manual", startTimeUtc: "2026-11-24T19:34:40.28", endTimeUtc: "2026-11-24T19:34:55.95", failureReason: { errorCode: "System_Cancelled_Session_Statements_Failed", message: "System cancelled the Spark session due to statement execution failures" } };
const logRoutes = (job: unknown = failedJob): Route[] => [
  items,
  get(/items\/nb-fail\/jobs\/instances\/jf$/, job),
  get(/notebooks\/nb-fail\/livySessions$/, { value: [{ livyId: "L1", jobInstanceId: "jf", sparkApplicationId: "app_1", state: "Failed" }] }),
  text(/livySessions\/L1\/applications\/none\/logs\?type=livy$/, "26/11/24 19:27:57 INFO Client: Submitting application\nprofiling:/__w:Cannot create directory"),
  text(/applications\/app_1\/logs\?type=driver&fileName=stderr$/, STDERR),
  text(/applications\/app_1\/logs\?type=driver&fileName=stdout$/, STDOUT),
];

describe("F03 why did the run fail: fabric logs --job is a small digest", () => {
  const args = ["logs", "--workspace", "aihub-test-dev-bench", "--item", "nb_bench_fail", "--job", "jf"];

  it("gives the failed cell, the exception and the likely cause in a few hundred bytes, never the whole driver log", async () => {
    expect(bytes(STDERR + STDOUT)).toBeGreaterThan(400_000);
    const a = await go(logRoutes(), args);
    expect(a.code).toBe(0);
    expect(bytes(a.out)).toBeLessThan(4_000);
    expect(a.out).toContain("failed cell 12, line 6: raise ValueError(");
    expect(a.out).toContain("-> ValueError: BENCH-abc123-ERR: kolom klantnummer ontbreekt");
    expect(a.out).toContain("likely cause: code-error");
    expect(a.out).toContain("failure: System_Cancelled_Session_Statements_Failed");
    // the token-cache INFO lines that say "Exception" are not the error
    expect(a.out).not.toContain("CacheMissException");
    expect(a.out).not.toContain("profiling:");
    expect(a.out).toContain("full log: aihub fabric logs --workspace aihub-test-dev-bench --item nb_bench_fail --job jf --out <file>");
  });

  it("failures --item looks only at that notebook and names the cell and exception in about 1 KB", async () => {
    const jobs = get(/items\/nb-fail\/jobs\/instances$/, { value: [failedJob] });
    const a = await go([...logRoutes(), jobs], ["failures", "--workspace", "aihub-test-dev-bench", "--item", "nb_bench_fail"]);
    expect(a.code).toBe(0);
    expect(a.out).toContain("1 failed and 0 active run(s) in aihub-test-dev-bench (dev)");
    expect(a.out).toContain("ValueError: BENCH-abc123-ERR");
    expect(a.out).toContain("likely cause: code-error");
    expect(bytes(a.out)).toBeLessThan(1_500);
    expect(a.calls.some((c) => /nb-ok\/jobs/.test(c.url))).toBe(false);
  });

  it("--json is one compact line with the digest and without the raw log lines", async () => {
    const a = await go(logRoutes(), [...args, "--json"]);
    expect(a.lines).toHaveLength(1);
    expect(a.out).not.toContain("\n");
    expect(bytes(a.out)).toBeLessThan(4_000);
    const j = JSON.parse(a.out).result;
    expect(j.digest.cell).toMatchObject({ cell: 12, line: 6 });
    expect(j.digest.cause.kind).toBe("code-error");
    expect(j.digest.logs.find((l: { title: string }) => /stderr/.test(l.title)).lines).toBeGreaterThan(4000);
  });

  it("--out writes every line to a file and says where; stdout stays small", async () => {
    const file = join(tmp(), "full.log");
    const a = await go(logRoutes(), [...args, "--out", file]);
    expect(bytes(a.out)).toBeLessThan(4_000);
    expect(a.out).toContain(`full log written to ${file}`);
    const full = readFileSync(file, "utf8");
    expect(full).toContain("CacheMissException for Key: conf:fs.azure.sas.3999");
    expect(full).toContain("ValueError: BENCH-abc123-ERR");
  });

  it("--tail and --search are windows, capped in bytes even when they ask for a lot", async () => {
    const t = await go(logRoutes(), [...args, "--tail", "5000"]);
    expect(bytes(t.out)).toBeLessThan(17_000);
    expect(t.out).toContain("more line(s) cut; full log: aihub fabric logs");
    const s = await go(logRoutes(), [...args, "--search", "klantnummer"]);
    expect(s.out).toContain("ValueError: BENCH-abc123-ERR");
    expect(bytes(s.out)).toBeLessThan(4_000);
  });

  it("without a Python traceback the excerpt is the first ERROR record with its stack, not an INFO line", () => {
    const lines = ["2026-01-01 10:00:00,1 INFO X: CacheMissException !", "2026-01-01 10:00:01,2 ERROR Executor: task failed", "  at org.apache.Foo(Foo.scala:1)", "Caused by: java.lang.OutOfMemoryError", "INFO done"];
    expect(errorExcerpt(lines)).toEqual(lines.slice(1, 4));
    expect(errorExcerpt(["INFO only", "nothing wrong"])).toEqual([]);
  });

  it("spark logs --json is bounded too (the last 60 lines unless --tail), the cause still comes from the whole log", async () => {
    const r = [...logRoutes()];
    const a = await go(r, ["spark", "logs", "--workspace", "aihub-test-dev-bench", "--item", "nb_bench_fail", "--job", "jf", "--file", "stdout", "--json"]);
    const j = JSON.parse(a.out).result;
    expect(j.lines).toBeGreaterThan(400);
    expect(j.text.split("\n").length).toBeLessThanOrEqual(61);
    expect(bytes(a.out)).toBeLessThan(17_000);
    const e = await go(r, ["spark", "logs", "--workspace", "aihub-test-dev-bench", "--item", "nb_bench_fail", "--job", "jf"]);
    expect(bytes(e.out)).toBeLessThan(17_000);
    expect(e.out).toContain("the whole log (");
  });
});

describe("F02 run and wait: one call gives the end result, and on failure the cause", () => {
  function runRoutes(job: unknown, id = "nb-fail"): Route[] {
    return [
      items,
      { method: "POST", match: new RegExp(`/items/${id}/jobs/instances\\?jobType=RunNotebook$`), respond: () => ({ status: 202, headers: { location: `https://api.fabric.microsoft.com/v1/workspaces/${WS}/items/${id}/jobs/instances/jf` } }) },
      ...logRoutes(job).slice(1),
      get(new RegExp(`items/${id}/jobs/instances/jf$`), job),
    ];
  }

  it("run --wait on a failing notebook prints the failed cell and the exception in the same call", async () => {
    const a = await go(runRoutes(failedJob), ["run", "--workspace", "aihub-test-dev-bench", "--item", "nb_bench_fail", "--wait"]);
    expect(a.code).toBe(1);
    expect(a.out).toContain("job jf: Failed (nb_bench_fail)");
    expect(a.out).toContain("ValueError: BENCH-abc123-ERR");
    expect(a.out).toContain("likely cause: code-error");
    expect(a.out).toContain("full log: aihub fabric logs --workspace aihub-test-dev-bench --item nb_bench_fail --job jf");
    expect(bytes(a.out)).toBeLessThan(2_000);
    expect(a.errs[0]).toContain("ended as Failed");
  });

  it("run --wait on a good notebook: started + Completed, nothing else", async () => {
    const ok = { id: "jf", status: "Completed", startTimeUtc: "2026-11-24T19:43:19", endTimeUtc: "2026-11-24T19:43:31" };
    const a = await go(runRoutes(ok, "nb-ok"), ["run", "--workspace", "aihub-test-dev-bench", "--item", "nb_bench_ok", "--wait"]);
    expect(a.code).toBe(0);
    expect(a.out).toContain("job jf: Completed (nb_bench_ok)");
    expect(bytes(a.out)).toBeLessThan(400);
  });

  it("run without --wait points to status --wait on this job (with the workspace), never to a second run", async () => {
    const a = await go(runRoutes({ id: "jf", status: "InProgress" }, "nb-ok"), ["run", "--workspace", "aihub-test-dev-bench", "--item", "nb_bench_ok"]);
    expect(a.out).toContain("wait for the result: aihub fabric status --workspace aihub-test-dev-bench --item nb_bench_ok --job jf --wait");
    const b = await go(runRoutes({ id: "jf", status: "Completed" }, "nb-ok"), ["status", "--workspace", "aihub-test-dev-bench", "--item", "nb_bench_ok", "--job", "jf", "--wait"]);
    expect(b.code).toBe(0);
    expect(b.out).toContain("job jf: Completed");
    expect(b.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("run --json is one JSON line (no 'started' text line in front of it)", async () => {
    const a = await go(runRoutes({ id: "jf", status: "Completed" }, "nb-ok"), ["run", "--workspace", "aihub-test-dev-bench", "--item", "nb_bench_ok", "--wait", "--json"]);
    expect(a.lines).toHaveLength(1);
    expect(JSON.parse(a.out).result.job.status).toBe("Completed");
  });
});

describe("F04 item edit: change a notebook in place, optionally run it", () => {
  const NB = '# Fabric notebook source\n\n# CELL ********************\n\nregio = "zuid"  # parameter\ncode = "BENCH"\nprint(regio)\n';
  const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");
  const definition = post(/items\/nb-edit\/getDefinition$/, {
    definition: { parts: [{ path: "notebook-content.py", payload: b64(NB), payloadType: "InlineBase64" }, { path: ".platform", payload: b64('{"metadata":{"type":"Notebook"}}'), payloadType: "InlineBase64" }] },
  });
  const update = post(/items\/nb-edit\/updateDefinition$/);
  const sent = (calls: { url: string; body?: any }[]) => {
    const c = calls.find((x) => /updateDefinition$/.test(x.url));
    return c ? Buffer.from(c.body.definition.parts.find((p: { path: string }) => p.path === "notebook-content.py").payload, "base64").toString("utf8") : undefined;
  };
  const base = ["item", "edit", "--workspace", "aihub-test-dev-bench", "--item", "nb_bench_edit"];

  it("--set name=value keeps the quotes and the comment of the assignment; .platform is not sent", async () => {
    const a = await go([items, definition, update], [...base, "--set", "regio=noord-abc123"]);
    expect(a.code).toBe(0);
    expect(sent(a.calls)).toContain('regio = "noord-abc123"  # parameter');
    expect(sent(a.calls)).not.toContain('"zuid"');
    const body = a.calls.find((x) => /updateDefinition$/.test(x.url))!.body;
    expect(body.definition.parts.map((p: { path: string }) => p.path)).toEqual(["notebook-content.py"]);
    expect(a.out).toContain('notebook-content.py line 5: regio = "zuid"  # parameter  ->  regio = "noord-abc123"  # parameter');
    expect(bytes(a.out)).toBeLessThan(400);
  });

  it("--replace without quotes (what survives PowerShell) changes the one occurrence", async () => {
    const a = await go([items, definition, update], [...base, "--replace", "zuid", "--with", "noord-abc123"]);
    expect(a.code).toBe(0);
    expect(sent(a.calls)).toContain('regio = "noord-abc123"');
  });

  it("refuses text that is missing or not unique, before anything is written", async () => {
    const none = await go([items, definition, update], [...base, "--replace", "oost", "--with", "west"]);
    expect(none.code).toBe(1);
    expect(none.errs[0]).toContain("'oost' does not occur in Notebook nb_bench_edit");
    expect(none.errs[0]).toContain("--set name=value");
    const two = await go([items, definition, update], [...base, "--replace", "regio", "--with", "x"]);
    expect(two.code).toBe(1);
    expect(two.errs[0]).toContain("'regio' occurs 2 times (notebook-content.py line 5, notebook-content.py line 7)");
    for (const r of [none, two]) expect(r.calls.some((c) => /updateDefinition/.test(c.url))).toBe(false);
  });

  it("--dry-run shows the changed line and writes nothing; ACC is refused before any call", async () => {
    const a = await go([items, definition, update], [...base, "--set", "regio=noord", "--dry-run"]);
    expect(a.out).toContain('regio = "zuid"  # parameter  ->  regio = "noord"  # parameter');
    expect(a.calls.some((c) => /updateDefinition/.test(c.url))).toBe(false);
    const acc = await go([items, definition, update], ["item", "edit", "--workspace", "ACC-test-project", "--item", "nb_bench_edit", "--set", "regio=x"]);
    expect(acc.errs[0]).toContain("is ACC");
    expect(acc.calls).toHaveLength(0);
  });

  it("--replace-file/--with-file for long text (a trailing newline of the file is ignored)", async () => {
    const d = tmp();
    writeFileSync(join(d, "old.txt"), 'regio = "zuid"  # parameter\r\n');
    writeFileSync(join(d, "new.txt"), 'regio = "noord"  # parameter\n');
    const a = await go([items, definition, update], [...base, "--replace-file", join(d, "old.txt"), "--with-file", join(d, "new.txt")]);
    expect(a.code).toBe(0);
    expect(sent(a.calls)).toContain('regio = "noord"  # parameter\ncode');
  });

  it("--run --wait edits, runs and reports the end result in one call", async () => {
    const run: Route = { method: "POST", match: /items\/nb-edit\/jobs\/instances\?jobType=RunNotebook$/, respond: () => ({ status: 202, headers: { location: `https://api.fabric.microsoft.com/v1/workspaces/${WS}/items/nb-edit/jobs/instances/je` } }) };
    const a = await go([items, definition, update, run, get(/items\/nb-edit\/jobs\/instances\/je$/, { id: "je", status: "Completed" })], [...base, "--set", "regio=noord", "--run", "--wait"]);
    expect(a.code).toBe(0);
    expect(a.out).toContain("updated Notebook nb_bench_edit");
    expect(a.out).toContain("job je: Completed (nb_bench_edit)");
    expect(a.calls.findIndex((c) => /updateDefinition/.test(c.url))).toBeLessThan(a.calls.findIndex((c) => /jobType=RunNotebook/.test(c.url)));
  });
});

describe("F05 git commit: inline message, says what was committed and whether the workspace is clean", () => {
  const dirty = { workspaceHead: "aaaaaaaa11", remoteCommitHash: "aaaaaaaa11", changes: [{ itemMetadata: { displayName: "nb_bench_f05", itemType: "Notebook" }, workspaceChange: "Added", conflictType: "None" }] };
  const clean = { workspaceHead: "cccccccc33", remoteCommitHash: "cccccccc33", changes: [] };
  function routes(): Route[] {
    let n = 0;
    return [{ match: new RegExp(`/workspaces/${WS}/git/status$`), respond: () => ({ body: n++ === 0 ? dirty : clean }) }, post(/git\/commitToGit$/)];
  }

  it("--message inline commits and reads the status once more: clean, new head, what went in", async () => {
    const a = await go(routes(), ["git", "commit", "--workspace", "aihub-test-dev-bench", "--message", "Voeg notebook toe"]);
    expect(a.code).toBe(0);
    expect(a.calls.find((c) => /commitToGit$/.test(c.url))!.body.comment).toBe("Voeg notebook toe");
    expect(a.out).toContain('committed 1 change(s) of aihub-test-dev-bench to git as cccccccc: "Voeg notebook toe"');
    expect(a.out).toContain("Notebook nb_bench_f05: Added");
    expect(a.out).toContain("the workspace is clean");
  });

  it("without a message it names what changed (one call is enough)", async () => {
    const a = await go(routes(), ["git", "commit", "--workspace", "aihub-test-dev-bench"]);
    expect(a.code).toBe(0);
    expect(a.calls.find((c) => /commitToGit$/.test(c.url))!.body.comment).toBe("Update nb_bench_f05 from Fabric workspace aihub-test-dev-bench");
  });
});

describe("F01 and the noise", () => {
  it("items: the lakehouse's own SQL endpoint is a mark on the lakehouse row, not a fifth item", async () => {
    const a = await go([items], ["items", "--workspace", "aihub-test-dev-bench"]);
    expect(a.out).toContain("4 item(s) in aihub-test-dev-bench (dev)");
    expect(a.out).toContain("Lakehouse (+SQL endpoint) | lh_bench | lh-1");
    expect(a.out).not.toContain("SQLEndpoint");
    const t = await go([get(new RegExp(`/workspaces/${WS}/items\\?type=SQLEndpoint$`), { value: [ITEMS[4]] })], ["items", "--workspace", "aihub-test-dev-bench", "--type", "SQLEndpoint"]);
    expect(t.out).toContain("SQLEndpoint | lh_bench");
  });

  it("help is one short screen; a group gives the detail", async () => {
    const h = await go([], ["--help"]);
    expect(h.code).toBe(0);
    expect(bytes(h.out)).toBeLessThan(1_500);
    expect(h.out).toContain("run --item I --wait");
    expect(h.out).toContain("failures");
    const g = await go([], ["help", "why"]);
    expect(g.out).toContain("aihub fabric logs --workspace W --item I --job J");
    const sub = await go([], ["run", "--help"]);
    expect(sub.out).toBe("usage: aihub fabric run --workspace W --item I --wait [--params-file F]   (start, wait, end result; on failure the cause)");
  });

  it("a wrong command gets the one usage line it meant, not the whole manual", async () => {
    const a = await go([], ["definition", "--workspace", "aihub-test-dev-bench", "--item", "nb"]);
    expect(a.code).toBe(1);
    expect(a.errs[0]).toContain("unknown fabric command 'definition'; did you mean:");
    expect(a.errs[0]).toContain("aihub fabric item definition --workspace W --item I [--out dir]");
    expect(bytes(a.errs[0])).toBeLessThan(400);
    const b = await go([], ["items", "--nope"]);
    expect(b.errs[0]).toContain("Unknown option '--nope'");
    expect(b.errs[0]).toContain("usage: aihub fabric items --workspace W");
    expect(bytes(b.errs[0])).toBeLessThan(300);
  });
});

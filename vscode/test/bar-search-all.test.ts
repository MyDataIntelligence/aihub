import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { LatestOnly, partLines, searchAllArgs, streamCli } from "../src/bar/searchAll";
import { BAR_COMMANDS } from "../src/bar/types";

/** A fake child process: stderr and stdout are emitters, close ends it. */
function fakeSpawn() {
  const kids: any[] = [];
  const fn = ((_cmd: string, _args: string[]) => {
    const p: any = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.pid = undefined;
    p.killed = false;
    p.kill = () => {
      p.killed = true;
      p.emit("close", null);
    };
    kids.push(p);
    return p;
  }) as never;
  return { fn, kids };
}

describe("Search Everywhere in the bar", () => {
  it("builds one aihub search all call, streamed", () => {
    expect(searchAllArgs({ text: " orders " })).toEqual(["search", "all", "--text", "orders", "--stream", "--json"]);
    expect(searchAllArgs({ text: "#12", kinds: ["workitems", "prs", "bogus" as never], top: 50, project: "test-project", org: "ferron-test", refresh: true })).toEqual([
      "search", "all", "--text", "#12", "--kinds", "workitems,prs", "--top", "50", "--project", "test-project", "--org", "ferron-test", "--refresh", "--stream", "--json",
    ]);
    expect(() => searchAllArgs({ text: " " })).toThrow(/search text/);
    expect(BAR_COMMANDS.searchAll).toBe("aihub.bar.searchAll");
  });

  it("reads the parts from stderr and skips other lines", () => {
    expect(partLines('{"part":{"kind":"repos"}}\nwarning: x\n{"part":{"kind":"wiki"}}\n{"part":{cut')).toEqual([{ kind: "repos" }, { kind: "wiki" }]);
  });

  it("hands each part over as it arrives, also when a line comes in two pieces", async () => {
    const f = fakeSpawn();
    const seen: unknown[] = [];
    const s = streamCli("node", ["x"], ".", (l) => seen.push(...partLines(l)), f.fn);
    const p = f.kids[0];
    p.stderr.emit("data", Buffer.from('{"part":{"kind":"re'));
    p.stderr.emit("data", Buffer.from('pos"}}\n{"part":{"kind":"files"}}\n'));
    p.stdout.emit("data", Buffer.from('{"kinds":[]}'));
    p.emit("close", 0);
    const r = await s.done;
    expect(seen).toEqual([{ kind: "repos" }, { kind: "files" }]);
    expect(r).toMatchObject({ code: 0, stdout: '{"kinds":[]}', stopped: false });
  });

  it("a newer search stops the older one, which then says stopped and hands nothing more", async () => {
    const f = fakeSpawn();
    const latest = new LatestOnly();
    const seen: unknown[] = [];
    const first = latest.start(streamCli("node", ["a"], ".", (l) => seen.push(...partLines(l)), f.fn));
    latest.start(streamCli("node", ["b"], ".", () => undefined, f.fn));
    f.kids[0].stderr.emit("data", Buffer.from('{"part":{"kind":"late"}}\n'));
    expect(f.kids[0].killed).toBe(true);
    expect((await first.done).stopped).toBe(true);
    expect(seen).toEqual([]);
    expect(f.kids[1].killed).toBe(false);
  });
});

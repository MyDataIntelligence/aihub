import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "../proc.js";
import type { PipelineStep } from "./pipelineYaml.js";

/**
 * How one step becomes a process, the way the Azure Pipelines agent starts it: `script:` through bash (cmd on Windows
 * without bash), `bash:`/`Bash@3` through bash, `pwsh:`/`powershell:`/`PowerShell@2` through PowerShell and
 * `PythonScript@0` through the team's interpreter. Inline scripts are written to a file in Agent.TempDirectory first.
 * Which programs exist is asked through `Shells`, so the choice is unit-tested without bash or Python installed.
 */
export interface Shells {
  platform: NodeJS.Platform;
  /** full path of a program on PATH, or undefined */
  which: (program: string) => string | undefined;
}

export interface Command {
  file: string;
  args: string[];
  /** the command as a person would type it */
  display: string;
  /** an inline script written to this file before the run */
  script?: { path: string; content: string };
  /** cmd.exe gets its command line as written */
  verbatim?: boolean;
  /** a program the step needs is not on this PC */
  missing?: string;
}

const WSL = /[\\/]windows[\\/]system32[\\/]/i;
const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Programs on PATH, read from the folders (no process); on Windows with PATHEXT. WSL's bash in System32 does not count as
 * bash; Git for Windows' bash counts also when only its `cmd` folder (git.exe) is on PATH, as in a PowerShell or VS Code
 * terminal, so `script:` steps get the same shell whichever terminal started preflight.
 */
export function pathShells(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Shells {
  const memo = new Map<string, string | undefined>();
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  const bashLike = (program: string) => platform === "win32" && /^bash(\.exe)?$/i.test(program);
  const onPath = (program: string): string | undefined => {
    if (isAbsolute(program)) return existsSync(program) ? program : undefined;
    for (const d of dirs)
      for (const e of [...(platform === "win32" && /\.[a-z]+$/i.test(program) ? [""] : []), ...exts]) {
        const p = join(d, program + e);
        if (isFile(p) && !(bashLike(program) && WSL.test(p))) return p; // WSL's bash is not a Windows bash: look further
      }
    return undefined;
  };
  // <Git>\cmd\git.exe, <Git>\bin\git.exe or <Git>\mingw64\bin\git.exe -> <Git>\bin\bash.exe or <Git>\usr\bin\bash.exe
  const gitBash = (): string | undefined => {
    const git = onPath("git");
    if (!git) return undefined;
    for (const root of [dirname(dirname(git)), dirname(dirname(dirname(git)))])
      for (const p of [join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe")]) if (isFile(p)) return p;
    return undefined;
  };
  return {
    platform,
    which: (program) => {
      if (memo.has(program)) return memo.get(program);
      const hit = onPath(program) ?? (bashLike(program) ? gitBash() : undefined);
      memo.set(program, hit);
      return hit;
    },
  };
}

/**
 * A bash script on Windows gets the preflight folders with forward slashes: bash removes a backslash outside quotes, so
 * `ls $(Build.SourcesDirectory)/jobs` would lose every separator. `dirs` are the native paths preflight itself expanded.
 */
export function posixPaths(text: string, dirs: string[]): string {
  let out = text;
  for (const d of [...new Set(dirs)].filter((x) => x.includes("\\")).sort((a, b) => b.length - a.length)) out = out.split(d).join(d.replace(/\\/g, "/"));
  return out;
}

/** Splits an argument string like the agent does: spaces separate, double or single quotes group, quotes are removed. */
export function splitArgs(s: string | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  let cur = "";
  let q: string | undefined;
  let any = false;
  for (const c of s.replace(/\r?\n/g, " ")) {
    if (q) {
      if (c === q) q = undefined;
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      any = true;
    } else if (/\s/.test(c)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}

const quote = (a: string) => (a === "" ? '""' : /[\s"'$`\\|&;<>()]/.test(a) ? `"${a.replace(/(["\\$`])/g, "\\$1")}"` : a);
const show = (file: string, args: string[]) => [file, ...args].map(quote).join(" ");

export interface CommandInput {
  /** expanded inline script */
  inline?: string;
  /** absolute script file */
  scriptFile?: string;
  /** expanded arguments */
  arguments?: string;
}

/** The interpreter for PythonScript@0: preflight.python, else python on Windows, python3 elsewhere, falling back to python. */
export function pythonFor(sh: Shells, configured?: string): string {
  if (configured) return configured;
  if (sh.platform === "win32") return "python";
  return sh.which("python3") ? "python3" : "python";
}

/** The shell of a `script:` step: preflight.shell, else bash when found, else cmd (Windows) or sh. */
export function scriptShell(sh: Shells, configured?: "bash" | "cmd" | "pwsh"): "bash" | "cmd" | "pwsh" | "sh" {
  if (configured) return configured;
  if (sh.which("bash")) return "bash";
  return sh.platform === "win32" ? "cmd" : "sh";
}

export function commandFor(step: PipelineStep, input: CommandInput, o: { sh: Shells; tempDir: string; python?: string; shell?: "bash" | "cmd" | "pwsh"; id: string }): Command {
  const tmp = (ext: string) => join(o.tempDir, `${o.id}${ext}`);
  const args = splitArgs(input.arguments);
  const need = (program: string, cmd: Command): Command => (o.sh.which(program) || isAbsolute(program) ? cmd : { ...cmd, missing: program });
  // on Windows the full path: by name, the first bash.exe on PATH may be WSL's
  const bashFile = o.sh.platform === "win32" ? (o.sh.which("bash") ?? "bash") : "bash";
  const bash = (file: string, content?: string): Command =>
    need("bash", { file: bashFile, args: ["--noprofile", "--norc", file, ...(content === undefined ? args : [])], display: show("bash", [file, ...(content === undefined ? args : [])]), ...(content !== undefined ? { script: { path: file, content } } : {}) });
  const ps = (program: string, file: string, content?: string): Command => {
    const call = `. '${file.replace(/'/g, "''")}'${content === undefined && args.length ? ` ${args.map(quote).join(" ")}` : ""}`;
    return need(program, {
      file: program,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Unrestricted", "-Command", call],
      display: `${program} -Command "${call}"`,
      ...(content !== undefined ? { script: { path: file, content: `$ErrorActionPreference = 'Stop'\n${content}\nif (Test-Path -LiteralPath variable:\\LASTEXITCODE) { exit $LASTEXITCODE }\n` } } : {}),
    });
  };
  const powershellProgram = (k: "pwsh" | "powershell") => (k === "powershell" && o.sh.platform === "win32" ? "powershell" : "pwsh");
  switch (step.kind) {
    case "python": {
      const py = pythonFor(o.sh, o.python);
      if (input.inline !== undefined) {
        const f = tmp(".py");
        return need(py, { file: py, args: [f, ...args], display: show(py, [f, ...args]), script: { path: f, content: input.inline } });
      }
      return need(py, { file: py, args: [input.scriptFile!, ...args], display: show(py, [input.scriptFile!, ...args]) });
    }
    case "bash":
      return input.inline !== undefined ? bash(tmp(".sh"), input.inline) : bash(input.scriptFile!);
    case "pwsh":
    case "powershell":
      return input.inline !== undefined ? ps(powershellProgram(step.kind), tmp(".ps1"), input.inline) : ps(powershellProgram(step.kind), input.scriptFile!);
    case "script": {
      const kind = scriptShell(o.sh, o.shell);
      const text = input.inline ?? "";
      if (kind === "bash") return bash(tmp(".sh"), text);
      if (kind === "pwsh") return ps("pwsh", tmp(".ps1"), text);
      if (kind === "cmd") {
        const f = tmp(".cmd");
        return { file: "cmd.exe", args: ["/D", "/E:ON", "/V:OFF", "/S", "/C", `"CALL "${f}""`], display: `cmd.exe /C CALL "${f}"`, script: { path: f, content: `@echo off\r\n${text.replace(/\r?\n/g, "\r\n")}\r\n` }, verbatim: true };
      }
      const f = tmp(".sh");
      return need("sh", { file: "sh", args: [f], display: show("sh", [f]), script: { path: f, content: text } });
    }
    default:
      return { file: "", args: [], display: "", missing: step.task ?? step.kind };
  }
}

export interface RunResult {
  code: number;
  output: string;
  seconds: number;
  error?: string;
}

/** Runs one command; every output line goes to `onLine` as it arrives. The output kept is capped at 4 MB (the tail). */
export function runCommand(cmd: Command, o: { cwd: string; env: NodeJS.ProcessEnv; onLine: (line: string) => void; timeoutMs?: number; now?: () => number }): Promise<RunResult> {
  const now = o.now ?? Date.now;
  const t0 = now();
  if (cmd.script) {
    mkdirSync(resolve(cmd.script.path, ".."), { recursive: true });
    writeFileSync(cmd.script.path, cmd.script.content, "utf8");
  }
  return new Promise((done) => {
    let out = "";
    const keep = (s: string) => {
      out += s;
      if (out.length > 4_000_000) out = out.slice(-3_000_000);
    };
    let partial = { o: "", e: "" };
    const feed = (which: "o" | "e", chunk: Buffer) => {
      const text = partial[which] + chunk.toString("utf8");
      const lines = text.split("\n");
      partial = { ...partial, [which]: lines.pop() ?? "" };
      for (const l of lines) {
        keep(`${l}\n`);
        o.onLine(l.replace(/\r$/, ""));
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd.file, cmd.args, { cwd: o.cwd, env: o.env, windowsVerbatimArguments: cmd.verbatim, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return done({ code: 1, output: "", seconds: (now() - t0) / 1000, error: (e as Error).message });
    }
    const timer = setTimeout(() => child.kill(), o.timeoutMs ?? 60 * 60_000);
    let error: string | undefined;
    child.stdout?.on("data", (c: Buffer) => feed("o", c));
    child.stderr?.on("data", (c: Buffer) => feed("e", c));
    child.on("error", (e) => (error = (e as NodeJS.ErrnoException).code === "ENOENT" ? `${cmd.file} is not installed or not on PATH` : e.message));
    child.on("close", (code) => {
      clearTimeout(timer);
      for (const w of ["o", "e"] as const)
        if (partial[w]) {
          keep(partial[w]);
          o.onLine(partial[w].replace(/\r$/, ""));
        }
      done({ code: code ?? 1, output: out, seconds: Math.round((now() - t0) / 100) / 10, error });
    });
  });
}

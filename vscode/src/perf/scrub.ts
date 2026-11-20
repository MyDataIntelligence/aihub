import { homedir } from "node:os";

/**
 * Everything the performance log writes goes through here. It never keeps tokens, PATs, passwords, e-mail
 * addresses, URL queries or free text (commit messages, replies); paths become relative to the workspace.
 */

export interface ScrubOptions {
  /** Workspace folders: a path inside one is written relative to it. */
  roots?: string[];
  home?: string;
}

const MAX_LEN = 300;
const REDACTED = "<redacted>";

/** Flags whose value is a secret. */
const SECRET_FLAG = /^--?(token|pat|password|passwd|pwd|secret|client-secret|api-?key|access-token|auth|authorization|bearer|sas)$/i;
/** `--token=...`, `password=...`, `AIHUB_ADO_PAT=...`. */
const SECRET_ASSIGN = /\b((?:[A-Za-z0-9]+[_-])*(?:token|pat|password|passwd|secret|api-?key|authorization|sig)(?:[_-][A-Za-z0-9]+)*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s&"',;]+)/gi;
/** Flags whose value is free text that may hold names or content. */
const TEXT_FLAG = /^(-m|--message|--reply|--replies|--title|--description|--body|--comment|--text|--query|-q)$/i;

const TOKEN_PATTERNS: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /[A-Za-z0-9+/]{40,}={1,2}/g,
];
/** Long random-looking runs without separators (Azure DevOps PATs are 52 or 84 characters). Git object ids (40/64 hex) stay. */
const LONG_RUN = /[A-Za-z0-9+=]{32,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const URL_RE = /\b(?:https?|git|ssh):\/\/[^\s"'<>]+/gi;

const looksRandom = (s: string) => {
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(s)) return false;
  return /[0-9]/.test(s) && /[A-Za-z]/.test(s);
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function urlPart(u: string): string {
  try {
    const p = new URL(u);
    return `${p.protocol}//${p.host}${p.pathname}`;
  } catch {
    return u.replace(/[?#].*$/, "").replace(/\/\/[^/@]*@/, "//");
  }
}

export class Scrubber {
  private roots: { re: RegExp; bare: RegExp }[] = [];
  private home: RegExp | undefined;

  constructor(opts: ScrubOptions = {}) {
    this.setRoots(opts.roots ?? []);
    const home = opts.home ?? safeHome();
    if (home && home.length > 3) this.home = new RegExp(pathPattern(home), "gi");
  }

  setRoots(roots: string[]) {
    this.roots = [...roots]
      .filter((r) => r && r.length > 3)
      .sort((a, b) => b.length - a.length)
      .map((r) => ({ re: new RegExp(`${pathPattern(r)}[\\\\/]`, "gi"), bare: new RegExp(`${pathPattern(r)}(?![\\w.-])`, "gi") }));
  }

  /** Masks one string: URLs lose their query and user, secrets and e-mail addresses go, paths become relative. */
  text(s: string): string {
    let out = s.length > 4 * MAX_LEN ? s.slice(0, 4 * MAX_LEN) : s;
    out = out.replace(URL_RE, urlPart);
    for (const re of TOKEN_PATTERNS) out = out.replace(re, (m, scheme?: string) => (typeof scheme === "string" && /^(bearer|basic)$/i.test(scheme) ? `${scheme} ${REDACTED}` : REDACTED));
    out = out.replace(SECRET_ASSIGN, (_m, k: string) => `${k}=${REDACTED}`);
    out = out.replace(EMAIL, "<email>");
    for (const r of this.roots) out = out.replace(r.re, "").replace(r.bare, ".");
    if (this.home) out = out.replace(this.home, "~");
    out = out.replace(LONG_RUN, (m) => (looksRandom(m) ? REDACTED : m));
    return out.length > MAX_LEN ? `${out.slice(0, MAX_LEN)}...` : out;
  }

  /** Masks a command line: the value after a secret flag or a free-text flag goes as a whole. */
  args(args: readonly string[]): string[] {
    const out: string[] = [];
    let mask: string | undefined;
    for (const a of args.slice(0, 40)) {
      if (mask) {
        out.push(mask);
        mask = undefined;
        continue;
      }
      const eq = a.indexOf("=");
      const flag = a.startsWith("-") && eq > 0 ? a.slice(0, eq) : a;
      if (SECRET_FLAG.test(flag)) eq > 0 && flag !== a ? out.push(`${flag}=${REDACTED}`) : (out.push(a), (mask = REDACTED));
      else if (TEXT_FLAG.test(flag)) eq > 0 && flag !== a ? out.push(`${flag}=<text>`) : (out.push(a), (mask = "<text>"));
      else out.push(this.text(a));
    }
    if (args.length > 40) out.push(`... ${args.length - 40} more`);
    return out;
  }

  /** Scrubs every string in a JSON-like value (depth-limited). */
  value(v: unknown, depth = 0): unknown {
    if (typeof v === "string") return this.text(v);
    if (v === null || typeof v !== "object" || depth > 4) return v;
    if (Array.isArray(v)) return v.slice(0, 100).map((x) => this.value(x, depth + 1));
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = this.value(x, depth + 1);
    return o;
  }
}

/** A path that matches both slash styles. */
function pathPattern(p: string): string {
  return p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]+/)
    .map(escapeRe)
    .join("[\\\\/]+");
}

function safeHome(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

/** Finds what the scrubber should have removed: used by the tests on the written log. */
export function findSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const re of TOKEN_PATTERNS) for (const m of text.matchAll(new RegExp(re.source, re.flags))) if (!m[0].includes(REDACTED)) hits.push(m[0]);
  for (const m of text.matchAll(new RegExp(EMAIL.source, "g"))) hits.push(m[0]);
  for (const m of text.matchAll(new RegExp(LONG_RUN.source, "g"))) if (looksRandom(m[0])) hits.push(m[0]);
  for (const m of text.matchAll(/[?&](?:sig|token|code|access_token|api-key)=[^&\s"]+/gi)) hits.push(m[0]);
  return hits;
}

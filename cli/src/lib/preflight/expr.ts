/**
 * The small part of the Azure Pipelines expression language preflight evaluates itself: `$(Name)` macros,
 * plain `${{ parameters.x }}` / `${{ variables.x }}` template references and step conditions. Anything else is reported
 * as "cannot evaluate" so the step does not run on a guess.
 */

/** `$(Name)`: letters, digits, `_` and `.` (the names Azure accepts); `$(date)` in a shell script is the same text. */
export const MACRO = /\$\(([A-Za-z_][A-Za-z0-9_.]*)\)/g;
const TEMPLATE = /\$\{\{([\s\S]*?)\}\}/g;
const PLAIN_REF = /^\s*(parameters|variables)(?:\.([A-Za-z_][A-Za-z0-9_.-]*)|\[\s*'([^']+)'\s*\])\s*$/;

/** A lookup returns the value or undefined (unknown). */
export type Lookup = (name: string) => string | undefined;

export interface Expanded {
  text: string;
  /** macro or parameter names nobody could fill */
  missing: string[];
  /** template expressions that are not a plain reference */
  cannot: string[];
  /** every macro name referenced (also the ones that were filled) */
  used: string[];
}

/**
 * Expands template references first (compile time), then macros (runtime). `keepShell`: in an inline script, an unknown
 * all-lowercase name without a dot (`$(pwd)`, `$(date)`) is shell command substitution and is left as it is.
 */
export function expand(text: string, o: { variable: Lookup; parameter: (name: string) => string | undefined; keepShell?: boolean }): Expanded {
  const missing = new Set<string>();
  const cannot: string[] = [];
  const used = new Set<string>();
  let t = text.replace(TEMPLATE, (whole, inner: string) => {
    const m = PLAIN_REF.exec(inner);
    if (!m) {
      cannot.push(whole.trim());
      return whole;
    }
    const name = m[2] ?? m[3];
    const v = m[1] === "parameters" ? o.parameter(name) : o.variable(name);
    if (v === undefined) {
      missing.add(m[1] === "parameters" ? `parameters.${name}` : name);
      return whole;
    }
    return v;
  });
  t = t.replace(MACRO, (whole, name: string) => {
    const v = o.variable(name);
    if (v === undefined) {
      if (o.keepShell && /^[a-z_][a-z0-9_]*$/.test(name)) return whole;
      missing.add(name);
      return whole;
    }
    used.add(name);
    return v;
  });
  return { text: t, missing: [...missing], cannot, used: [...used] };
}

/** Every `$(Name)` a text names (for the token check before anything runs). */
export function macroNames(text: string): string[] {
  return [...new Set([...text.matchAll(MACRO)].map((m) => m[1]))];
}

// ---- conditions ---------------------------------------------------------------------------------------------------

type Tok = { t: "id" | "str" | "num" | "(" | ")" | "," | "[" | "]" | "."; v: string };

function lex(s: string): Tok[] | undefined {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ("(),[].".includes(c)) {
      out.push({ t: c as Tok["t"], v: c });
      i++;
      continue;
    }
    if (c === "'") {
      let v = "";
      i++;
      for (;;) {
        if (i >= s.length) return undefined;
        if (s[i] === "'") {
          if (s[i + 1] === "'") {
            v += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += s[i++];
      }
      out.push({ t: "str", v });
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(s.slice(i));
    if (num) {
      out.push({ t: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(s.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    return undefined;
  }
  return out;
}

type Val = string | boolean | number;
class Cannot extends Error {}

export interface ConditionState {
  /** no earlier step failed */
  succeeded: boolean;
  variable: Lookup;
}

const FUNCS = new Set(["succeeded", "always", "failed", "and", "or", "not", "eq", "ne", "startswith", "endswith", "contains", "in", "notin", "succeededorfailed", "canceled", "xor"]);

/** true / false, or undefined with the reason when the condition uses something outside the supported subset. */
export function evalCondition(cond: string | undefined, st: ConditionState): { value?: boolean; reason?: string } {
  if (cond === undefined || !String(cond).trim()) return { value: st.succeeded };
  const toks = lex(String(cond));
  if (!toks) return { reason: "condition could not be evaluated" };
  let p = 0;
  const peek = () => toks[p];
  const take = (t?: Tok["t"]): Tok => {
    const x = toks[p];
    if (!x || (t && x.t !== t)) throw new Cannot();
    p++;
    return x;
  };
  const varRef = (): Val => {
    // variables['X'] or variables.X(.Y)
    if (peek()?.t === "[") {
      take("[");
      const k = take("str").v;
      take("]");
      return lookupVar(k);
    }
    take(".");
    let k = take("id").v;
    while (peek()?.t === ".") {
      take(".");
      k += `.${take("id").v}`;
    }
    return lookupVar(k);
  };
  const lookupVar = (k: string): Val => {
    const v = st.variable(k);
    if (v === undefined) throw new Cannot(`variable ${k} is not known`);
    return v;
  };
  const expr = (): Val => {
    const x = take();
    if (x.t === "str") return x.v;
    if (x.t === "num") return Number(x.v);
    if (x.t !== "id") throw new Cannot();
    const id = x.v.toLowerCase();
    if (id === "true") return true;
    if (id === "false") return false;
    if (id === "variables") return varRef();
    if (!FUNCS.has(id) || ["canceled", "xor", "succeededorfailed", "notin"].includes(id)) throw new Cannot();
    take("(");
    const args: Val[] = [];
    if (peek()?.t !== ")") {
      args.push(expr());
      while (peek()?.t === ",") {
        take(",");
        args.push(expr());
      }
    }
    take(")");
    return call(id, args);
  };
  const call = (f: string, a: Val[]): Val => {
    switch (f) {
      case "succeeded":
        if (a.length) throw new Cannot(); // succeeded('job') names other jobs
        return st.succeeded;
      case "failed":
        if (a.length) throw new Cannot();
        return !st.succeeded;
      case "always":
        return true;
      case "and":
        if (a.length < 2) throw new Cannot();
        return a.every(truthy);
      case "or":
        if (a.length < 2) throw new Cannot();
        return a.some(truthy);
      case "not":
        if (a.length !== 1) throw new Cannot();
        return !truthy(a[0]);
      case "eq":
        return eq(a[0], a[1]);
      case "ne":
        return !eq(a[0], a[1]);
      case "startswith":
        return str(a[0]).toLowerCase().startsWith(str(a[1]).toLowerCase());
      case "endswith":
        return str(a[0]).toLowerCase().endsWith(str(a[1]).toLowerCase());
      case "contains":
        return str(a[0]).toLowerCase().includes(str(a[1]).toLowerCase());
      case "in":
        return a.slice(1).some((x) => eq(a[0], x));
    }
    throw new Cannot();
  };
  try {
    const v = expr();
    if (p !== toks.length) throw new Cannot();
    return { value: truthy(v) };
  } catch (e) {
    return { reason: e instanceof Cannot && e.message ? `condition could not be evaluated (${e.message})` : "condition could not be evaluated" };
  }
}

const str = (v: Val): string => (typeof v === "boolean" ? (v ? "True" : "False") : String(v));
const truthy = (v: Val): boolean => (typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : v !== "" && v.toLowerCase() !== "false");
/** Azure compares case-insensitively and converts the right side to the type of the left. */
function eq(a: Val, b: Val): boolean {
  if (typeof a === "boolean") return a === truthy(b);
  if (typeof a === "number") return a === Number(b);
  return str(a).toLowerCase() === str(b).toLowerCase();
}

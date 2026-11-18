import { createHash, createPrivateKey, createSign, randomUUID, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultExec, type Exec } from "./auth.js";
import { AihubError } from "./errors.js";
import { makeFabricAuth } from "./fabric.js";
import { redact } from "./fabric-redact.js";
import { trace } from "./trace.js";

export type Audience = "fabric" | "storage" | "sql" | "powerbi" | "kusto";

/** Resource per audience (az `--resource`); the client-credentials scope is `<resource>/.default`. */
export const RESOURCES: Record<Audience, string> = {
  fabric: "https://api.fabric.microsoft.com",
  storage: "https://storage.azure.com",
  sql: "https://database.windows.net/", // trailing slash: that is the audience the SQL endpoint accepts (tedious is closed right after login without it)
  powerbi: "https://analysis.windows.net/powerbi/api",
  kusto: "https://kusto.kusto.windows.net",
};
export const scopeFor = (a: Audience) => `${RESOURCES[a].replace(/\/$/, "")}/.default`;
const TOKEN_ENV: Record<Audience, string> = {
  fabric: "AIHUB_FABRIC_TOKEN",
  storage: "AIHUB_ONELAKE_TOKEN",
  sql: "AIHUB_SQL_TOKEN",
  powerbi: "AIHUB_POWERBI_TOKEN",
  kusto: "AIHUB_KUSTO_TOKEN",
};

export interface SpConfig {
  tenant: string;
  clientId: string;
  /** `store:<name>` (OS credential store), `kv://<vault>/<secret>` (Key Vault, read with az) or `cert:<path>`. */
  secretRef: string;
}
export interface SpFile {
  default?: string;
  principals: Record<string, SpConfig>;
}

export interface Identity {
  kind: "service-principal" | "token" | "user";
  name?: string;
  clientId?: string;
  tenant?: string;
  /** Why this identity was chosen (flag, env, workspace, default). */
  source: string;
}

export interface AuthDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  exec?: Exec;
  now?: () => number;
  /** Folder of the user config; default AIHUB_HOME or ~/.aihub. */
  home?: string;
  tokenCache?: string;
}

const homeOf = (d: { env: NodeJS.ProcessEnv; home?: string }) => d.home ?? (d.env.AIHUB_HOME || join(homedir(), ".aihub"));
export const spFile = (d: { env: NodeJS.ProcessEnv; home?: string }) => join(homeOf(d), "fabric-sp.json");

export function loadSpFile(d: { env: NodeJS.ProcessEnv; home?: string }): SpFile {
  try {
    const j = JSON.parse(readFileSync(spFile(d), "utf8")) as SpFile;
    return { default: j.default, principals: j.principals ?? {} };
  } catch {
    return { principals: {} };
  }
}
export function saveSpFile(d: { env: NodeJS.ProcessEnv; home?: string }, f: SpFile): void {
  const p = spFile(d);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(f, null, 2), { mode: 0o600 });
}

// ---- secret storage: OS credential store, never the repository --------------------------------

const SERVICE = "aihub-fabric-sp";

/** Store a secret with the OS tool: macOS keychain, libsecret (secret-tool), Windows DPAPI file. */
export function storeSecret(d: AuthDeps, name: string, secret: string): void {
  const exec = d.exec ?? defaultExec;
  if (process.platform === "darwin") exec("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", name, "-w", secret]);
  else if (process.platform === "win32") {
    const file = join(homeOf(d), "sp-secrets", `${name}.dpapi`);
    mkdirSync(dirname(file), { recursive: true });
    exec("powershell", ["-NoProfile", "-Command", `$s = [Console]::In.ReadToEnd().Trim() | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString; Set-Content -Path '${file}' -Value $s`], secret);
  } else exec("secret-tool", ["store", "--label", `aihub ${name}`, "service", SERVICE, "account", name], secret);
}

export function readStoredSecret(d: AuthDeps, name: string): string {
  const exec = d.exec ?? defaultExec;
  let out: string;
  if (process.platform === "darwin") out = exec("security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
  else if (process.platform === "win32") {
    const file = join(homeOf(d), "sp-secrets", `${name}.dpapi`);
    out = exec("powershell", ["-NoProfile", "-Command", `$s = Get-Content -Path '${file}' | ConvertTo-SecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`]);
  } else out = exec("secret-tool", ["lookup", "service", SERVICE, "account", name]);
  const s = out.trim();
  if (!s) throw new AihubError(`the secret of service principal '${name}' is not in the credential store; add it again with: aihub fabric auth sp add ${name} ...`);
  return s;
}

/** `kv://<vault>/<secret>` read with az (the caller must be allowed to read that Key Vault secret). */
export function readKeyVaultSecret(d: AuthDeps, ref: string): string {
  const m = /^kv:\/\/([^/]+)\/([^/]+)$/.exec(ref);
  if (!m) throw new AihubError(`'${ref}' is not a Key Vault reference like kv://<vault>/<secret>`);
  const exec = d.exec ?? defaultExec;
  try {
    return exec("az", ["keyvault", "secret", "show", "--vault-name", m[1], "--name", m[2], "--query", "value", "-o", "tsv", "--only-show-errors"]).trim();
  } catch {
    throw new AihubError(`could not read Key Vault secret ${m[1]}/${m[2]}: check 'az login' and your access to that vault`);
  }
}

// ---- client credentials -----------------------------------------------------------------------------

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Signed client assertion for certificate login (PEM file with the private key and the certificate). */
export function certAssertion(pemPath: string, tenant: string, clientId: string, now: number): string {
  const pem = readFileSync(pemPath, "utf8");
  const certPem = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(pem)?.[0];
  if (!certPem) throw new AihubError(`certificate file '${pemPath}' has no CERTIFICATE block`);
  const thumb = createHash("sha1").update(new X509Certificate(certPem).raw).digest();
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", "x5t": b64u(thumb) }));
  const sec = Math.floor(now / 1000);
  const body = b64u(JSON.stringify({ aud: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, iss: clientId, sub: clientId, jti: randomUUID(), nbf: sec, exp: sec + 600 }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(createPrivateKey(pem));
  return `${head}.${body}.${b64u(sig)}`;
}

export class FabricIdentity {
  private readonly now: () => number;
  private readonly mem = new Map<string, { token: string; expiresAt: number }>();
  private userAuth = new Map<Audience, () => Promise<string>>();
  private hinted: string | undefined;
  private chosen: Identity | undefined;

  constructor(
    private readonly d: AuthDeps,
    private readonly flagSp?: string,
  ) {
    this.now = d.now ?? Date.now;
  }

  /** A workspace or group in team.yaml may name a service principal; flag and env still win. */
  hint(spName: string | undefined): void {
    if (spName && !this.hinted) {
      this.hinted = spName;
      this.chosen = undefined;
    }
  }

  /** Precedence: --sp, AIHUB_FABRIC_SP, AZURE_CLIENT_* env, team.yaml hint, user default SP, token env, az user. */
  resolve(): Identity {
    if (this.chosen) return this.chosen;
    const env = this.d.env;
    const file = loadSpFile(this.d);
    const named = (name: string, source: string): Identity => {
      const sp = file.principals[name];
      if (!sp) throw new AihubError(`service principal '${name}' is not registered; add it with: aihub fabric auth sp add ${name} --tenant T --client-id C ...${Object.keys(file.principals).length ? ` (registered: ${Object.keys(file.principals).join(", ")})` : ""}`);
      return { kind: "service-principal", name, clientId: sp.clientId, tenant: sp.tenant, source };
    };
    let id: Identity;
    if (this.flagSp) id = named(this.flagSp, "--sp");
    else if (env.AIHUB_FABRIC_SP) id = named(env.AIHUB_FABRIC_SP, "AIHUB_FABRIC_SP");
    else if (env.AZURE_CLIENT_ID && env.AZURE_TENANT_ID && (env.AZURE_CLIENT_SECRET || env.AZURE_CLIENT_CERTIFICATE_PATH)) id = { kind: "service-principal", name: "env", clientId: env.AZURE_CLIENT_ID, tenant: env.AZURE_TENANT_ID, source: "AZURE_CLIENT_* environment" };
    else if (this.hinted) id = named(this.hinted, "team.yaml fabric.servicePrincipal");
    else if (file.default) id = named(file.default, "user default service principal");
    else if (env.AIHUB_FABRIC_TOKEN) id = { kind: "token", source: "AIHUB_FABRIC_TOKEN" };
    else id = { kind: "user", source: "az login" };
    return (this.chosen = id);
  }

  /** The bearer header for one audience, from the chosen identity. */
  async token(aud: Audience): Promise<string> {
    const id = this.resolve();
    if (trace.verbose) trace.log(`fabric identity: ${describe(id)}`);
    if (id.kind !== "service-principal") return this.user(aud)();
    const key = `${id.name}|${id.clientId}|${aud}`;
    const hit = this.mem.get(key) ?? this.disk(key);
    if (hit && hit.expiresAt - 120_000 > this.now()) return `Bearer ${hit.token}`;
    const t = await this.fetchSpToken(id, aud);
    this.mem.set(key, t);
    this.saveDisk(key, t);
    return `Bearer ${t.token}`;
  }

  private user(aud: Audience): () => Promise<string> {
    let f = this.userAuth.get(aud);
    if (!f) {
      f = makeFabricAuth({ env: this.d.env, exec: this.d.exec, resource: RESOURCES[aud], tokenVar: TOKEN_ENV[aud], cacheFile: this.d.tokenCache && `${this.d.tokenCache}.${aud}` });
      this.userAuth.set(aud, f);
    }
    return f;
  }

  private cacheFile(key: string): string | undefined {
    return this.d.tokenCache ? `${this.d.tokenCache}.sp-${createHash("sha256").update(key).digest("hex").slice(0, 16)}` : join(homeOf(this.d), "sp-tokens", `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`);
  }
  private disk(key: string): { token: string; expiresAt: number } | undefined {
    try {
      const f = this.cacheFile(key);
      return f && existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { token: string; expiresAt: number }) : undefined;
    } catch {
      return undefined;
    }
  }
  private saveDisk(key: string, t: { token: string; expiresAt: number }): void {
    try {
      const f = this.cacheFile(key);
      if (!f) return;
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify(t), { mode: 0o600 });
    } catch {
      /* the cache is optional */
    }
  }

  private async fetchSpToken(id: Identity, aud: Audience): Promise<{ token: string; expiresAt: number }> {
    const env = this.d.env;
    const form = new URLSearchParams({ client_id: id.clientId!, scope: scopeFor(aud), grant_type: "client_credentials" });
    let secret: string | undefined;
    const sp = id.name === "env" ? undefined : loadSpFile(this.d).principals[id.name!];
    if (id.name === "env") {
      if (env.AZURE_CLIENT_SECRET) {
        secret = env.AZURE_CLIENT_SECRET;
        form.set("client_secret", secret);
      } else form.set("client_assertion", certAssertion(env.AZURE_CLIENT_CERTIFICATE_PATH!, id.tenant!, id.clientId!, this.now()));
    } else if (sp!.secretRef.startsWith("cert:")) form.set("client_assertion", certAssertion(sp!.secretRef.slice(5), id.tenant!, id.clientId!, this.now()));
    else {
      secret = sp!.secretRef.startsWith("kv://") ? readKeyVaultSecret(this.d, sp!.secretRef) : readStoredSecret(this.d, id.name!);
      form.set("client_secret", secret);
    }
    if (form.has("client_assertion")) form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    const res = await this.d.fetch(`https://login.microsoftonline.com/${id.tenant}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const text = await res.text();
    let j: { access_token?: string; expires_in?: number | string; error_description?: string; error?: string } = {};
    try {
      j = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok || !j.access_token) {
      const why = redact((j.error_description ?? j.error ?? text.slice(0, 200)).split(/\r?\n/)[0]);
      throw new AihubError(`service principal '${id.name}' could not sign in for ${aud} (${res.status}): ${secret ? why.split(secret).join("<redacted>") : why}`);
    }
    return { token: j.access_token, expiresAt: this.now() + Number(j.expires_in ?? 3600) * 1000 };
  }

  /** Expiry of the token for one audience, for `auth status` (fetches it when needed). */
  async expiry(aud: Audience): Promise<number | undefined> {
    await this.token(aud);
    const id = this.resolve();
    return this.mem.get(`${id.name}|${id.clientId}|${aud}`)?.expiresAt;
  }
}

export const describe = (id: Identity): string =>
  id.kind === "service-principal" ? `service principal ${id.name} (client ${id.clientId}, tenant ${id.tenant}) via ${id.source}` : id.kind === "token" ? `bearer token from ${id.source}` : `signed-in user (${id.source})`;

export const identityJson = (id: Identity) => ({ kind: id.kind, name: id.name, clientId: id.clientId, tenant: id.tenant, source: id.source });

const MARK = "<redacted>";

/** Patterns ported from the legacy Hub log redaction: group 1 stays, group 2 is replaced (group 3 stays). */
const PATTERNS: RegExp[] = [
  /(\bauthorization["']?\s*[:=]\s*)([^\r\n]+)/gi,
  /([?&](?:sig|sv|se|st|sp|sr|srt|ss|spr|skoid|sktid|skt|ske|sks|skv|sdd)=)([^&\s"'<>]+)/gi,
  /(fs\.azure\.(?:account\.key|sas)\.[\w.-]+["']?\s*[:=]\s*["']?)([^\s,;"']+)/gi,
  /(abfss?:\/\/[^:/@\s]+:)([^@\s]+)(@)/gi,
  /(client[_-]?assertion["']?\s*[:=]\s*)([^\s,;&"']+)/gi,
  /(client[_-]?secret["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi,
  /(\b(?:password|pwd)\s*=\s*)([^;\s"']+)/gi,
  /(sharedaccesssignature\s*=\s*)([^;\s"']+)/gi,
  /(\b(?:accountkey|account_key|sastoken|access_token|refresh_token|id_token)["']?\s*[:=]\s*["']?)([^\s,;&"']+)/gi,
  /(\b(?:token|secret|api[_-]?key|passwd|password|pwd)\s*[=:]\s*["']?)([^\s,;&"']{3,})/gi,
  /(\bbearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
  /(\b[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|ACCESS_?KEY)[A-Z0-9_]*\s*=\s*)(\S+)/g,
];
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/** Secrets out of a text: SAS signatures, storage keys, Authorization, client secrets, connection-string passwords, PEM, JWT. */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, (m, a: string, b: string, c?: string) => (b.trim() === MARK ? m : `${a}${MARK}${typeof c === "string" ? c : ""}`));
  return out.replace(PEM, MARK).replace(JWT, MARK);
}

import { spawn } from "./proc.js";
import { AihubError } from "./errors.js";
import { redact } from "./fabric-redact.js";

export interface SqlEndpoint {
  host: string;
  port: number;
  database: string;
}
export interface SqlResult {
  columns: string[];
  rows: unknown[][];
}

/**
 * Found by the live Fabric check (2026-11-18): the SQL analytics endpoint of a lakehouse closed every connection of tedious (16, 18 and 19, TLS 1.2/1.3, strict) right after
 * the TLS hello or the LOGIN7 packet, while ODBC 18 and .NET SqlClient with the same Entra token returned the rows. On Windows .NET SqlClient is always there (Windows
 * PowerShell), so when tedious loses the connection the same read-only query runs through it. The token and the query go through the environment, never the command line.
 */
export const POWERSHELL_SQL_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$c = New-Object System.Data.SqlClient.SqlConnection("Server=$($env:AIHUB_SQL_HOST),$($env:AIHUB_SQL_PORT);Database=$($env:AIHUB_SQL_DB);Encrypt=True;Connect Timeout=30")
$c.AccessToken = $env:AIHUB_SQL_TOKEN
$c.Open()
try {
  $cmd = $c.CreateCommand(); $cmd.CommandText = $env:AIHUB_SQL_QUERY; $cmd.CommandTimeout = [int]$env:AIHUB_SQL_TIMEOUT
  $r = $cmd.ExecuteReader()
  $cols = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $r.FieldCount; $i++) { [void]$cols.Add($r.GetName($i)) }
  $rows = New-Object System.Collections.ArrayList
  $max = [int]$env:AIHUB_SQL_MAXROWS
  while ($rows.Count -le $max -and $r.Read()) {
    $row = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $r.FieldCount; $i++) {
      $v = $r.GetValue($i)
      if ($v -is [DBNull]) { $v = $null } elseif ($v -is [datetime]) { $v = $v.ToString('o') } elseif ($v -is [byte[]]) { $v = '0x' + (($v | ForEach-Object { $_.ToString('x2') }) -join '') }
      [void]$row.Add($v)
    }
    [void]$rows.Add([object[]]$row.ToArray())
  }
  [Console]::Out.Write((@{ columns = $cols.ToArray(); rows = $rows.ToArray() } | ConvertTo-Json -Compress -Depth 6))
} finally { $c.Close() }
`;

/** Normalises what ConvertTo-Json made of the result: a single column or row comes back as a scalar. */
export function parseSqlJson(text: string): SqlResult {
  const j = JSON.parse(text) as { columns?: unknown; rows?: unknown };
  const columns = (Array.isArray(j.columns) ? j.columns : j.columns === undefined ? [] : [j.columns]).map(String);
  let rows: unknown[] = Array.isArray(j.rows) ? j.rows : j.rows === undefined || j.rows === null ? [] : [j.rows];
  rows = rows.map((r) => (Array.isArray(r) ? r : [r]));
  return { columns, rows: rows as unknown[][] };
}

/** True for the errors that mean "the connection was dropped", the case the fallback is for. */
export function isDroppedConnection(message: string): boolean {
  return /socket hang up|ESOCKET|Connection lost|unexpected end of message|ECONNRESET/i.test(message);
}

export function powershellSqlQuery(ep: SqlEndpoint, query: string, maxRows: number, timeoutSeconds: number, token: string, exe = "powershell.exe"): Promise<SqlResult> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      AIHUB_SQL_HOST: ep.host,
      AIHUB_SQL_PORT: String(ep.port),
      AIHUB_SQL_DB: ep.database,
      AIHUB_SQL_TOKEN: token,
      AIHUB_SQL_QUERY: query,
      AIHUB_SQL_TIMEOUT: String(timeoutSeconds),
      AIHUB_SQL_MAXROWS: String(maxRows),
    };
    const encoded = Buffer.from(POWERSHELL_SQL_SCRIPT, "utf16le").toString("base64");
    const child = spawn(exe, ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", encoded], { env, windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new AihubError(`the SQL query through .NET SqlClient timed out after ${timeoutSeconds + 40} s`));
    }, (timeoutSeconds + 40) * 1000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new AihubError(`could not start ${exe}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new AihubError(`the query failed (.NET SqlClient): ${redact(err || out).trim().split("\n").slice(0, 3).join(" ").slice(0, 400)}`));
      try {
        resolve(parseSqlJson(out));
      } catch {
        reject(new AihubError(`the query returned something that is not JSON: ${redact(out).slice(0, 200)}`));
      }
    });
  });
}

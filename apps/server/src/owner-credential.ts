import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { chmod, lstat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { DatabaseSync } from "node:sqlite"

const OWNER_AUTH_DATABASE_NAME = ".henshin-server-auth.sqlite"
const OWNER_TOKEN_BYTES = 32
const execFileAsync = promisify(execFile)
const WINDOWS_POWERSHELL_PATH = path.win32.resolve(
  process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
)

const WINDOWS_PROTECT_AUTH_FILE_SCRIPT = `$ErrorActionPreference = 'Stop'
$path = $env:HENSHIN_AUTH_PATH
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.FileSecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($currentSid)
$rules = @(
  $currentSid
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
)
foreach ($sid in $rules) {
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
  ))
}
if ($env:HENSHIN_AUTH_CREATE -eq '1') {
  $stream = [System.IO.FileStream]::new(
    $path,
    [System.IO.FileMode]::CreateNew,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.IO.FileShare]::ReadWrite,
    4096,
    [System.IO.FileOptions]::None,
    $acl
  )
  $stream.Dispose()
} else {
  [System.IO.File]::SetAccessControl($path, $acl)
}`

export class OwnerCredentialError extends Error {
  readonly name = "OwnerCredentialError"
}
const ownerCredentialDatabasePath = (dbPath: string): string =>
  path.join(path.dirname(dbPath), OWNER_AUTH_DATABASE_NAME)

const isMissingPath = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT"

const verifyPath = async (filePath: string, create: boolean): Promise<void> => {
  try {
    const entry = await lstat(filePath)
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new OwnerCredentialError("server startup failed at authentication: owner credential state is unavailable")
    }
  } catch (error) {
    if (!isMissingPath(error)) throw error
    if (!create) throw new OwnerCredentialError("owner credential is not initialized; run --initialize-owner")
  }
}

const protectWindowsAuthFile = async (filePath: string, create: boolean): Promise<void> => {
  if (process.platform !== "win32") return

  let createFile = false
  try {
    await lstat(filePath)
  } catch (error) {
    if (!isMissingPath(error) || !create) throw error
    createFile = true
  }
  await execFileAsync(
    WINDOWS_POWERSHELL_PATH,
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROTECT_AUTH_FILE_SCRIPT],
    {
      windowsHide: true,
      env: { ...process.env, HENSHIN_AUTH_PATH: filePath, HENSHIN_AUTH_CREATE: createFile ? "1" : "0" }
    }
  )
}

const openAuthDatabase = async (dbPath: string, create: boolean): Promise<DatabaseSync> => {
  const filePath = ownerCredentialDatabasePath(dbPath)
  await verifyPath(filePath, create)
  await protectWindowsAuthFile(filePath, create)
  const database = new DatabaseSync(filePath, { timeout: 0 })
  try {
    await chmod(filePath, 0o600)
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS owner_credential (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        verifier TEXT NOT NULL CHECK (length(verifier) = 64),
        database_name TEXT NOT NULL
      );
    `)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

export const hashBearerToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex")

export const writeOwnerCredential = async (dbPath: string, command: "initialize" | "rotate"): Promise<string> => {
  const database = await openAuthDatabase(dbPath, command === "initialize")
  try {
    const token = randomBytes(OWNER_TOKEN_BYTES).toString("base64url")
    const verifier = hashBearerToken(token)
    const name = path.basename(dbPath)
    if (command === "initialize") {
      const inserted = database.prepare(
        "INSERT INTO owner_credential(id, verifier, database_name) VALUES(1, ?, ?) ON CONFLICT(id) DO NOTHING"
      ).run(verifier, name)
      if (!inserted.changes) throw new OwnerCredentialError("server initialization failed: owner credential is already initialized")
    } else {
      const updated = database.prepare("UPDATE owner_credential SET verifier = ? WHERE id = 1 AND database_name = ?").run(verifier, name)
      if (!updated.changes) {
        const owner = database.prepare("SELECT id FROM owner_credential WHERE id = 1").get()
        throw new OwnerCredentialError(owner
          ? "owner credential belongs to another database; select it with --database"
          : "owner credential is not initialized; run --initialize-owner")
      }
    }
    return token
  } finally {
    database.close()
  }
}

export const readOwnerCredential = async (
  dbPath: string
): Promise<{ readonly verifier: string; readonly databaseName: string }> => {
  const database = await openAuthDatabase(dbPath, false)
  try {
    const row = database.prepare("SELECT verifier, database_name FROM owner_credential WHERE id = 1").get() as
      | { verifier: string; database_name: string }
      | undefined
    if (
      row === undefined ||
      !/^[0-9a-f]{64}$/u.test(row.verifier) ||
      row.database_name.length === 0
    ) {
      throw new OwnerCredentialError(
        "server startup failed at authentication: owner credential is not initialized"
      )
    }
    return { verifier: row.verifier, databaseName: row.database_name }
  } finally {
    database.close()
  }
}

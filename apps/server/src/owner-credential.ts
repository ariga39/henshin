import { createHash, randomBytes } from "node:crypto"
import { chmod, lstat } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

const OWNER_AUTH_DATABASE_NAME = ".henshin-server-auth.sqlite"
const OWNER_TOKEN_BYTES = 32

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
    if (!create || !isMissingPath(error)) throw error
  }
}
const openAuthDatabase = async (dbPath: string, create: boolean): Promise<DatabaseSync> => {
  const filePath = ownerCredentialDatabasePath(dbPath)
  await verifyPath(filePath, create)
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

/**
 * Initializes the independent-service owner credential. The plaintext token is
 * returned only to the explicit local initialization caller; the auth database
 * stores only its fixed-size SHA-256 verifier.
 */
export const initializeOwnerCredential = async (dbPath: string): Promise<string> => {
  const database = await openAuthDatabase(dbPath, true)
  try {
    const existing = database.prepare("SELECT id FROM owner_credential WHERE id = 1").get()
    if (existing !== undefined) {
      throw new OwnerCredentialError("server initialization failed: owner credential is already initialized")
    }
    const token = randomBytes(OWNER_TOKEN_BYTES).toString("base64url")
    database.prepare("INSERT INTO owner_credential(id, verifier, database_name) VALUES(1, ?, ?)").run(
      hashBearerToken(token),
      path.basename(dbPath)
    )
    return token
  } finally {
    database.close()
  }
}

export const readOwnerCredential = async (
  dbPath: string
): Promise<{ readonly verifier: string; readonly databaseName: string }> => {
  let database: DatabaseSync
  try {
    database = await openAuthDatabase(dbPath, false)
  } catch (error) {
    if (isMissingPath(error)) {
      throw new OwnerCredentialError(
        "server startup failed at authentication: owner credential is not initialized"
      )
    }
    throw error
  }

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

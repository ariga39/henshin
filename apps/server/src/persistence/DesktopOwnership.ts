import { chmod, realpath } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

export const DESKTOP_OWNER_DATABASE_NAME = ".henshin-desktop-owner.sqlite"

export class DesktopOwnershipError extends Error {
  readonly code = "desktop_ownership"

  constructor(message: string) {
    super(message)
    this.name = "DesktopOwnershipError"
  }
}

/**
 * Resolves the existing desktop data directory without creating it. The
 * maintenance command and Electron main both use this canonical directory for
 * their cooperative ownership guard.
 */
export const canonicalizeDesktopDataDirectory = async (dataDirectory: string): Promise<string> => {
  try {
    return await realpath(path.resolve(dataDirectory))
  } catch {
    throw new DesktopOwnershipError("desktop maintenance failed at data-directory: data directory is unavailable")
  }
}

/**
 * Reserves the desktop data directory for the lifetime of the caller. The
 * guard database is deliberately separate from the client store so a failed
 * maintenance attempt cannot modify the application database while acquiring
 * ownership.
 */
export const acquireDesktopOwnership = async (dataDirectory: string): Promise<DatabaseSync> => {
  const canonicalDirectory = await canonicalizeDesktopDataDirectory(dataDirectory)
  let guard: DatabaseSync | undefined
  try {
    guard = new DatabaseSync(path.join(canonicalDirectory, DESKTOP_OWNER_DATABASE_NAME), { timeout: 0 })
    guard.exec("BEGIN IMMEDIATE;")
    await chmod(path.join(canonicalDirectory, DESKTOP_OWNER_DATABASE_NAME), 0o600)
    return guard
  } catch (error) {
    try {
      guard?.close()
    } catch {
      // Preserve the ownership diagnostic when opening or reserving fails.
    }
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("locked")) {
      throw new DesktopOwnershipError("desktop maintenance failed at ownership: data directory is already owned")
    }
    throw new DesktopOwnershipError("desktop maintenance failed at ownership: data directory ownership is unavailable")
  }
}

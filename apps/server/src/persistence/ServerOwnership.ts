import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { Data, Effect, Layer } from "effect"
import { DatabaseSync } from "node:sqlite"

const OWNER_DATABASE_NAME = ".henshin-server-owner.sqlite"

export type ServerOwnershipStage = "data-directory" | "ownership"

export class ServerOwnershipError extends Data.TaggedError("ServerOwnershipError")<{
  readonly stage: ServerOwnershipStage
  readonly message: string
}> {}

const unavailableDirectory = new ServerOwnershipError({
  stage: "data-directory",
  message: "server startup failed at data-directory: data directory is unavailable"
})

const unavailableOwnership = new ServerOwnershipError({
  stage: "ownership",
  message: "server startup failed at ownership: data directory ownership is unavailable"
})

const alreadyOwned = new ServerOwnershipError({
  stage: "ownership",
  message: "server startup failed at ownership: data directory is already owned"
})

const unavailableDatabasePath = new ServerOwnershipError({
  stage: "data-directory",
  message: "server startup failed at data-directory: database path is unavailable"
})

const isMissingPath = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT"

/**
 * Resolves an existing database file, including a symlink whose target is in
 * another directory. Dangling database-file symlinks are rejected. For a new
 * database, only the existing parent directory is resolved. Hardlinks, mount
 * aliases, and NAS locking are outside this prototype's guarantees.
 */
export const canonicalizeDatabasePath = async (dbPath: string): Promise<string> => {
  const absolutePath = path.resolve(dbPath)
  let entry: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    entry = await lstat(absolutePath)
  } catch (error) {
    if (!isMissingPath(error)) throw unavailableDirectory
  }

  let existingPath: string | undefined
  if (entry?.isSymbolicLink() === true) {
    try {
      existingPath = await realpath(absolutePath)
    } catch {
      throw unavailableDatabasePath
    }
  } else if (entry !== undefined) {
    try {
      existingPath = await realpath(absolutePath)
    } catch {
      throw unavailableDatabasePath
    }
  }

  const candidate = existingPath ?? absolutePath
  let dataDirectory: string
  try {
    dataDirectory = await realpath(path.dirname(candidate))
  } catch {
    throw unavailableDirectory
  }
  return path.join(dataDirectory, path.basename(candidate))
}

const canonicalDataDirectory = (dbPath: string): Effect.Effect<string, ServerOwnershipError> =>
  Effect.tryPromise({
    try: () => realpath(path.dirname(dbPath)),
    catch: () => unavailableDirectory
  })

const acquire = (dbPath: string): Effect.Effect<DatabaseSync, ServerOwnershipError> =>
  canonicalDataDirectory(dbPath).pipe(
    Effect.flatMap((dataDirectory) =>
      Effect.try({
        try: () => {
          const guard = new DatabaseSync(path.join(dataDirectory, OWNER_DATABASE_NAME), { timeout: 0 })
          try {
            guard.exec("BEGIN EXCLUSIVE;")
            return guard
          } catch (error) {
            guard.close()
            throw error
          }
        },
        catch: (error) => {
          const message = error instanceof Error ? error.message : String(error)
          return new ServerOwnershipError({
            stage: "ownership",
            message: message.includes("locked") ? alreadyOwned.message : unavailableOwnership.message
          })
        }
      })
    )
  )

/**
 * Prototype server ownership covers the real directory containing `dbPath`.
 * The guard is a separate SQLite database in that existing directory. The
 * directory must already exist; this layer never creates directories or
 * removes the guard database, including during release.
 */
export const ServerOwnershipLayer = (dbPath: string): Layer.Layer<never, ServerOwnershipError> =>
  Layer.effectDiscard(
    Effect.acquireRelease(acquire(dbPath), (guard) => Effect.sync(() => guard.close()))
  )

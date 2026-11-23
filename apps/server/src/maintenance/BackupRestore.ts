import { DatabaseSync, backup } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdtemp, open, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import {
  BackupRestoreFailure,
  archivePath,
  currentIdentity,
  loadArchive,
  validateSnapshot,
  type RestoreArtifact,
  type RestoreManifest,
  type RestorePreview
} from "./BackupRestoreArchive"
import { revalidateWritableLocation } from "../analysis/NativeSourceBoundary"
import { acquireServerOwnership } from "../persistence/ServerOwnership"
import { assertOwnerCredentialWritable, writeOwnerCredential } from "../owner-credential"

export type { RestoreArtifact } from "./BackupRestoreArchive"

const RESTORE_MARKER = ".henshin-restore.json"
const RESTORE_STATE_TABLE = "server_restore_state"
const ROOT_VERIFICATION_TABLE = "server_root_verification"

const createRestoreTables = (database: DatabaseSync): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${RESTORE_STATE_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL CHECK (status IN ('normal', 'needs-reconciliation')),
      artifact_id TEXT,
      restored_at_ms INTEGER,
      recovery_point TEXT
    );
    CREATE TABLE IF NOT EXISTS ${ROOT_VERIFICATION_TABLE} (
      root_id TEXT PRIMARY KEY REFERENCES server_roots(root_id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('verified', 'needs-verification')),
      updated_at_ms INTEGER NOT NULL
    );
  `)
}

const markRestoredState = (statePath: string, manifest: RestoreManifest): void => {
  const database = new DatabaseSync(statePath)
  try {
    createRestoreTables(database)
    const now = Date.now()
    database.prepare(`
      INSERT INTO ${RESTORE_STATE_TABLE}(id, status, artifact_id, restored_at_ms, recovery_point)
      VALUES(1, 'needs-reconciliation', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, artifact_id = excluded.artifact_id,
        restored_at_ms = excluded.restored_at_ms, recovery_point = excluded.recovery_point
    `).run(manifest.artifact_id, now, manifest.snapshot_completed_at)
    const roots = database.prepare("SELECT root_id FROM server_roots").all() as Array<{ root_id: string }>
    const markRoot = database.prepare(`
      INSERT INTO ${ROOT_VERIFICATION_TABLE}(root_id, status, updated_at_ms)
      VALUES(?, 'needs-verification', ?)
      ON CONFLICT(root_id) DO UPDATE SET status = excluded.status, updated_at_ms = excluded.updated_at_ms
    `)
    for (const root of roots) markRoot.run(root.root_id, now)
  } finally {
    database.close()
  }
}

const clearThumbnailCache = async (dbPath: string): Promise<void> => {
  const cachePath = join(dirname(dbPath), "thumbnail-cache")
  try {
    const entry = await lstat(cachePath)
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new BackupRestoreFailure("cache-unsafe", "thumbnail cache is not an owned directory")
  } catch (error) {
    if (error instanceof BackupRestoreFailure) throw error
    if ((error as { code?: string }).code !== "ENOENT") throw new BackupRestoreFailure("cache-unavailable", "thumbnail cache cannot be cleared")
  }
  await rm(cachePath, { recursive: true, force: true })
  await mkdirOwned(cachePath)
}

const mkdirOwned = async (directory: string): Promise<void> => {
  const { mkdir } = await import("node:fs/promises")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
}

const markerPath = (dbPath: string): string => join(dirname(dbPath), RESTORE_MARKER)
const markerRecoveryPath = (dbPath: string): string => `${markerPath(dbPath)}.recovery`

const optionalSidecar = (dbPath: string, suffix: "-wal" | "-shm"): string => `${dbPath}${suffix}`

const moveIfPresent = async (source: string, target: string): Promise<boolean> => {
  try {
    await rename(source, target)
    return true
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false
    throw error
  }
}

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const writeMarker = async (dbPath: string, marker: Record<string, string>): Promise<void> => {
  const path = markerPath(dbPath)
  const recoveryPath = markerRecoveryPath(dbPath)
  const directory = dirname(path)
  try {
    await lstat(path)
    throw new BackupRestoreFailure("restore-marker", "restore recovery marker is already present")
  } catch (error) {
    if (error instanceof BackupRestoreFailure) throw error
    if ((error as { code?: string }).code !== "ENOENT") throw error
  }
  await rm(recoveryPath, { force: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  const temporaryRecoveryPath = `${recoveryPath}.${randomUUID()}.tmp`
  let primaryRenamed = false
  let recoveryRenamed = false
  const bytes = JSON.stringify(marker)
  try {
    for (const [temporary, final] of [[temporaryPath, path], [temporaryRecoveryPath, recoveryPath]] as const) {
      const handle = await open(temporary, "wx", 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, final)
      if (final === path) primaryRenamed = true
      else recoveryRenamed = true
      await syncDirectory(directory)
    }
  } catch (error) {
    if (!primaryRenamed) await rm(path, { force: true }).catch(() => undefined)
    if (!recoveryRenamed) await rm(recoveryPath, { force: true }).catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    await rm(temporaryRecoveryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

const readMarker = async (dbPath: string): Promise<Record<string, string> | undefined> => {
  const read = async (path: string): Promise<Record<string, string> | undefined> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record<string, string>
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return undefined
      return undefined
    }
  }
  const primary = await read(markerPath(dbPath))
  if (primary !== undefined) return primary
  const recovery = await read(markerRecoveryPath(dbPath))
  if (recovery !== undefined) return recovery
  try {
    await stat(markerPath(dbPath))
    throw new BackupRestoreFailure(
      "restore-marker",
      "restore recovery marker is unreadable; preserve the target, rollback copy, and archive and use the explicit restore recovery procedure"
    )
  } catch (error) {
    if (error instanceof BackupRestoreFailure) throw error
    if ((error as { code?: string }).code !== "ENOENT") throw error
    return undefined
  }
}

const removeOwnedStaging = async (dbPath: string, stagingDirectory: string | undefined): Promise<void> => {
  if (stagingDirectory === undefined) return
  const dataDirectory = dirname(dbPath)
  const sameDirectory = await realpath(dirname(stagingDirectory)).then(
    (parent) => realpath(dataDirectory).then((current) => parent === current),
    () => false
  )
  if (!sameDirectory || !basename(stagingDirectory).startsWith(".backup-restore-")) {
    throw new BackupRestoreFailure("restore-marker", "restore recovery marker names an unsafe staging directory")
  }
  await rm(stagingDirectory, { recursive: true, force: true })
}

export const completeRestoreCredentialDelivery = async (dbPath: string): Promise<void> => {
  const marker = await readMarker(dbPath)
  if (marker !== undefined) await removeOwnedStaging(dbPath, marker.stagingDirectory)
  await rm(markerPath(dbPath), { force: true })
  await rm(markerRecoveryPath(dbPath), { force: true })
}

export const recoverInterruptedRestore = async (
  dbPath: string,
  existingGuard?: DatabaseSync,
  ownerCommand?: "initialize" | "rotate"
): Promise<string | undefined> => {
  if (existingGuard === undefined && await readMarker(dbPath) === undefined) return
  const guard = existingGuard ?? await acquireServerOwnership(dbPath)
  try {
    const marker = await readMarker(dbPath)
    if (marker === undefined) return
    if (marker.databaseName !== basename(dbPath)) {
      throw new BackupRestoreFailure("restore-marker", "restore recovery requires the original database path")
    }
    const rollbackPath = marker.rollbackPath
    const replacementPath = marker.replacementPath
    if (rollbackPath === undefined || replacementPath === undefined) throw new BackupRestoreFailure("restore-marker", "restore recovery marker is incomplete")
    const rollbackWalPath = marker.rollbackWalPath
    const rollbackShmPath = marker.rollbackShmPath
    const targetWalPath = optionalSidecar(dbPath, "-wal")
    const targetShmPath = optionalSidecar(dbPath, "-shm")
    let targetHasPendingRestore = false
    try {
      const database = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const row = database.prepare(`SELECT artifact_id FROM ${RESTORE_STATE_TABLE} WHERE id = 1 AND status = 'needs-reconciliation'`).get() as { artifact_id: string | null } | undefined
        targetHasPendingRestore = row?.artifact_id === marker.artifactId
      } finally {
        database.close()
      }
    } catch {
      // A missing or incomplete target is recovered from the preserved copy below.
    }
    if (!targetHasPendingRestore) {
      try { await stat(dbPath) } catch {
        await rename(rollbackPath, dbPath)
      }
      if (rollbackWalPath !== undefined) await moveIfPresent(rollbackWalPath, targetWalPath)
      if (rollbackShmPath !== undefined) await moveIfPresent(rollbackShmPath, targetShmPath)
      await rm(replacementPath, { force: true })
      await removeOwnedStaging(dbPath, marker.stagingDirectory)
      await completeRestoreCredentialDelivery(dbPath)
      return
    }
    if (ownerCommand !== "rotate") {
      throw new BackupRestoreFailure("restore-credential", "restore installed the replacement; run --rotate-owner before starting the restored service")
    }
    const token = await writeOwnerCredential(dbPath, "rotate")
    await rm(replacementPath, { force: true })
    return token
  } finally {
    if (existingGuard === undefined) guard.close()
  }
}

export const restoreExistingAuthority = async (input: {
  readonly dbPath: string
  readonly artifact: RestoreArtifact
  readonly confirm: boolean
  /** Test-only interruption seam; production callers leave this unset. */
  readonly beforeInstall?: () => Promise<void>
  /** Test-only interruption seam; production callers leave this unset. */
  readonly beforeSidecarMove?: () => Promise<void>
  /** Test-only interruption seam; production callers leave this unset. */
  readonly afterInstall?: () => Promise<void>
}): Promise<RestorePreview & { readonly ownerToken: string; readonly rollbackPath: string }> => {
  if (!input.confirm) throw new BackupRestoreFailure("confirmation-required", "restore requires explicit --confirm after reviewing the recovery point")
  const target = currentIdentity(input.dbPath)
  const destination = await revalidateWritableLocation({
    selectedPath: input.artifact.destination.selectedPath,
    canonicalPath: input.artifact.destination.canonicalPath,
    identity: { device: input.artifact.destination.device, inode: input.artifact.destination.inode }
  })
  if (!destination.ok) throw new BackupRestoreFailure("destination-changed", "backup destination changed and requires replacement")
  const archive = await archivePath(input.artifact)
  const stagingDirectory = await mkdtemp(join(dirname(input.dbPath), ".backup-restore-"))
  await chmod(stagingDirectory, 0o700)
  try {
    const inputs = await loadArchive(archive, stagingDirectory, input.artifact, target.changeRevision)
    if (inputs.manifest.instance_id !== target.instanceId || inputs.manifest.library_id !== target.libraryId) throw new BackupRestoreFailure("authority-mismatch", "backup belongs to another server instance or library")
    validateSnapshot(inputs, target)
    markRestoredState(inputs.statePath, inputs.manifest)
    await clearThumbnailCache(input.dbPath)
    const rollbackPath = join(dirname(input.dbPath), `.henshin-rollback-${randomUUID()}.sqlite`)
    const replacementPath = join(stagingDirectory, "replacement.sqlite")
    await rename(inputs.statePath, replacementPath)
    const current = new DatabaseSync(input.dbPath, { readOnly: true })
    try {
      await backup(current, rollbackPath)
    } finally {
      current.close()
    }
    const rollback = await open(rollbackPath, "r")
    try { await rollback.sync() } finally { await rollback.close() }
    const rollbackWalPath = `${rollbackPath}-wal`
    const rollbackShmPath = `${rollbackPath}-shm`
    const targetWalPath = optionalSidecar(input.dbPath, "-wal")
    const targetShmPath = optionalSidecar(input.dbPath, "-shm")
    await assertOwnerCredentialWritable(input.dbPath)
    await writeMarker(input.dbPath, {
      artifactId: input.artifact.artifactId,
      rollbackPath,
      replacementPath,
      stagingDirectory,
      databaseName: basename(input.dbPath),
      rollbackWalPath,
      rollbackShmPath
    })
    if (input.beforeSidecarMove !== undefined) await input.beforeSidecarMove()
    await moveIfPresent(targetWalPath, rollbackWalPath)
    await moveIfPresent(targetShmPath, rollbackShmPath)
    if (input.beforeInstall !== undefined) await input.beforeInstall()
    await rename(replacementPath, input.dbPath)
    if (input.afterInstall !== undefined) await input.afterInstall()
    const ownerToken = await writeOwnerCredential(input.dbPath, "rotate")
    const preview = {
      artifactId: input.artifact.artifactId,
      destinationId: input.artifact.destinationId,
      recoveryPoint: {
        snapshotStartedAt: inputs.manifest.snapshot_started_at,
        snapshotCompletedAt: inputs.manifest.snapshot_completed_at,
        libraryChangeRevision: inputs.manifest.library_change_revision
      },
      affectedInterval: {
        from: inputs.manifest.snapshot_completed_at,
        to: new Date().toISOString(),
        libraryChangeRevisions: {
          from: inputs.manifest.library_change_revision,
          to: target.changeRevision,
          estimatedLost: Math.max(0, target.changeRevision - inputs.manifest.library_change_revision)
        }
      },
      identity: { instanceId: inputs.manifest.instance_id, libraryId: inputs.manifest.library_id },
      requiresConfirmation: true as const
    }
    return { ...preview, ownerToken, rollbackPath }
  } catch (error) {
    if (error instanceof BackupRestoreFailure) throw error
    throw new BackupRestoreFailure(
      "restore-failed",
      `backup restore could not replace the existing target: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}

export const reconcileRestoredAuthority = async (dbPath: string): Promise<{ readonly status: "normal"; readonly roots: number; readonly destinations: number }> => {
  const database = new DatabaseSync(dbPath)
  try {
    createRestoreTables(database)
    const pending = database.prepare(`SELECT status FROM ${RESTORE_STATE_TABLE} WHERE id = 1`).get() as { status: string } | undefined
    if (pending?.status !== "needs-reconciliation") throw new BackupRestoreFailure("restore-not-pending", "server restore does not require reconciliation")
    const roots = database.prepare("SELECT root_id, selected_path, canonical_path, device, inode FROM server_roots ORDER BY rowid ASC").all() as Array<{ root_id: string; selected_path: string; canonical_path: string; device: string; inode: string }>
    const destinations = database.prepare("SELECT destination_id, selected_path, canonical_path, device, inode FROM backup_destinations ORDER BY rowid ASC").all() as Array<{ destination_id: string; selected_path: string; canonical_path: string; device: string; inode: string }>
    for (const location of [...roots, ...destinations]) {
      const current = await revalidateWritableLocation({ selectedPath: location.selected_path, canonicalPath: location.canonical_path, identity: { device: location.device, inode: location.inode } })
      if (!current.ok) throw new BackupRestoreFailure("location-unverified", "a restored root or backup destination requires replacement before reconciliation")
    }
    const now = Date.now()
    database.exec("BEGIN IMMEDIATE")
    try {
      database.prepare(`UPDATE ${RESTORE_STATE_TABLE} SET status = 'normal' WHERE id = 1`).run()
      database.prepare(`UPDATE ${ROOT_VERIFICATION_TABLE} SET status = 'verified', updated_at_ms = ?`).run(now)
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
    return { status: "normal", roots: roots.length, destinations: destinations.length }
  } finally {
    database.close()
  }
}

export const readRestoreStatus = (dbPath: string): "normal" | "needs-reconciliation" => {
  const database = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = database.prepare(`SELECT status FROM ${RESTORE_STATE_TABLE} WHERE id = 1`).get() as { status: "normal" | "needs-reconciliation" } | undefined
    return row?.status ?? "normal"
  } catch {
    return "normal"
  } finally {
    database.close()
  }
}

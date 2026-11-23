import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  DERIVED_PATHS,
  DESKTOP_RECOVERY_STATE_NAME,
  DESKTOP_DATABASE_NAME,
  DESKTOP_IDENTITY_NAME,
  isMissing,
  prepareDesktopRecoveryForApply,
  type DesktopRecoveryPreview,
  type DesktopRecoveryResult
} from "./DesktopBackupRecovery"

export const DESKTOP_RECOVERY_MARKER_NAME = ".desktop-recovery-in-progress.json"

type RecoveryMarker = {
  readonly format_version: 1
  readonly phase: "prepared" | "installed" | "state-written"
  readonly rollback_directory: string
  readonly had_recovery_state: boolean
}

const writePrivateJson = async (filePath: string, value: unknown): Promise<void> => {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
  try {
    await chmod(temporaryPath, 0o600)
    const file = await open(temporaryPath, "r+")
    try {
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporaryPath, filePath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

const copyRollbackFile = async (source: string, rollbackDirectory: string): Promise<void> => {
  const destination = path.join(rollbackDirectory, path.basename(source))
  await copyFile(source, destination)
  await chmod(destination, 0o600)
}

const addColumnIfMissing = (database: DatabaseSync, table: string, column: string): void => {
  const columns = new Set(
    (database.prepare(`PRAGMA table_info("${table}")`).all() as unknown as ReadonlyArray<{ name: string }>).map((row) => row.name)
  )
  if (!columns.has(column)) {
    database.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" INTEGER NOT NULL DEFAULT 1`)
  }
}

const normalizeRecoveredStore = (statePath: string): void => {
  const database = new DatabaseSync(statePath)
  try {
    addColumnIfMissing(database, "client_mappings", "requires_reauthorization")
    addColumnIfMissing(database, "reader_profiles", "requires_reauthorization")
    database.prepare("UPDATE client_mappings SET requires_reauthorization = 1").run()
    database.prepare("UPDATE reader_profiles SET requires_reauthorization = 1").run()
    database.prepare("UPDATE launch_journal SET status = 'unknown', updated_at_ms = ? WHERE status = 'prepared'").run(Date.now())
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } finally {
    database.close()
  }
}

const recoveryMarker = (value: unknown): RecoveryMarker => {
  if (typeof value !== "object" || value === null) throw new Error("desktop recovery marker is invalid")
  const marker = value as Partial<RecoveryMarker>
  if (
    marker.format_version !== 1 ||
    (marker.phase !== "prepared" && marker.phase !== "installed" && marker.phase !== "state-written") ||
    typeof marker.rollback_directory !== "string" ||
    typeof marker.had_recovery_state !== "boolean"
  ) throw new Error("desktop recovery marker is invalid")
  return marker as RecoveryMarker
}

export const applyDesktopRecovery = async (dataDirectory: string, archivePath: string): Promise<DesktopRecoveryResult> => {
  const prepared = await prepareDesktopRecoveryForApply(dataDirectory, archivePath)
  const { targetDirectory, stagingDirectory, bundle, preview } = prepared
  try {
    normalizeRecoveredStore(bundle.statePath)

    const rollbackDirectory = path.join(targetDirectory, `.desktop-recovery-rollback-${randomUUID()}`)
    await mkdir(rollbackDirectory, { mode: 0o700 })
    await chmod(rollbackDirectory, 0o700)
    await copyRollbackFile(path.join(targetDirectory, DESKTOP_DATABASE_NAME), rollbackDirectory)
    await copyRollbackFile(path.join(targetDirectory, DESKTOP_IDENTITY_NAME), rollbackDirectory)
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = path.join(targetDirectory, `${DESKTOP_DATABASE_NAME}${suffix}`)
      try {
        await copyRollbackFile(sidecar, rollbackDirectory)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    const recoveryStatePath = path.join(targetDirectory, DESKTOP_RECOVERY_STATE_NAME)
    let hadRecoveryState = false
    try {
      const state = await lstat(recoveryStatePath)
      if (!state.isFile() || state.isSymbolicLink()) throw new Error("desktop recovery state is not a regular file")
      await copyRollbackFile(recoveryStatePath, rollbackDirectory)
      hadRecoveryState = true
    } catch (error) {
      if (!isMissing(error)) throw error
    }

    const markerPath = path.join(targetDirectory, DESKTOP_RECOVERY_MARKER_NAME)
    const markerBase = { format_version: 1 as const, rollback_directory: rollbackDirectory, had_recovery_state: hadRecoveryState }
    await writePrivateJson(markerPath, { ...markerBase, phase: "prepared" })

    const liveDatabase = path.join(targetDirectory, DESKTOP_DATABASE_NAME)
    for (const suffix of ["-wal", "-shm"]) {
      try {
        await rm(path.join(targetDirectory, `${DESKTOP_DATABASE_NAME}${suffix}`))
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    await rename(bundle.statePath, liveDatabase)
    await chmod(liveDatabase, 0o600)
    await writePrivateJson(markerPath, { ...markerBase, phase: "installed" })

    for (const derivedPath of DERIVED_PATHS) {
      await rm(path.join(targetDirectory, derivedPath), { recursive: true, force: true })
    }
    await writePrivateJson(recoveryStatePath, {
      format_version: 1,
      installation_id: preview.target_installation_id,
      recovery_point: preview.recovery_point.completed_at,
      requires_fresh_authentication: true,
      mappings_require_review: true,
      reader_profiles_require_review: true,
      automatic_reader_launch_disabled: true,
      unresolved_dispatches: "unknown",
      drafts_require_fresh_state_reapplication: true,
      command_attempts_require_reconciliation: true
    })
    await writePrivateJson(markerPath, { ...markerBase, phase: "state-written" })
    await rm(markerPath, { force: true })
    return { preview, rollback_directory: rollbackDirectory, recovery_state_path: recoveryStatePath }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}


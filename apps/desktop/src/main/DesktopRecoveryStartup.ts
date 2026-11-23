import { randomUUID } from "node:crypto"
import { chmod, copyFile, lstat, open, readFile, realpath, rename, rm } from "node:fs/promises"
import path from "node:path"

const DATABASE_NAME = "prototype-client.db"
const IDENTITY_NAME = "device-id"
const RECOVERY_STATE_NAME = "desktop-recovery-state.json"
const MARKER_NAME = ".desktop-recovery-in-progress.json"

type RecoveryMarker = {
  readonly format_version: 1
  readonly phase: "prepared" | "installed" | "state-written"
  readonly rollback_directory: string
  readonly had_recovery_state: boolean
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

const isWithin = (child: string, parent: string): boolean => {
  const relativePath = path.relative(parent, child)
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
}

const parseMarker = (value: unknown): RecoveryMarker => {
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

const restoreFile = async (source: string, destination: string): Promise<void> => {
  const temporaryPath = `${destination}.${randomUUID()}.rollback-tmp`
  await copyFile(source, temporaryPath)
  try {
    await chmod(temporaryPath, 0o600)
    const file = await open(temporaryPath, "r+")
    try {
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporaryPath, destination)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

const rollbackOptionalFile = async (rollbackDirectory: string, targetDirectory: string, name: string): Promise<void> => {
  const source = path.join(rollbackDirectory, name)
  const destination = path.join(targetDirectory, name)
  try {
    const sourceStat = await lstat(source)
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("desktop recovery rollback material is not a regular file")
    await restoreFile(source, destination)
  } catch (error) {
    if (!isMissing(error)) throw error
    await rm(destination, { force: true })
  }
}

export const recoverInterruptedDesktopRecovery = async (dataDirectory: string): Promise<void> => {
  const targetDirectory = await realpath(dataDirectory)
  const markerPath = path.join(targetDirectory, MARKER_NAME)
  let markerBytes: string
  try {
    markerBytes = await readFile(markerPath, "utf8")
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  const markerStat = await lstat(markerPath)
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("desktop recovery marker is not a regular file")
  const marker = parseMarker(JSON.parse(markerBytes) as unknown)
  const rollbackDirectory = await realpath(marker.rollback_directory)
  if (!isWithin(rollbackDirectory, targetDirectory) || !path.basename(rollbackDirectory).startsWith(".desktop-recovery-rollback-")) {
    throw new Error("desktop recovery rollback directory is invalid")
  }

  for (const suffix of ["-wal", "-shm"]) {
    await rm(path.join(targetDirectory, `${DATABASE_NAME}${suffix}`), { force: true })
  }
  await restoreFile(path.join(rollbackDirectory, DATABASE_NAME), path.join(targetDirectory, DATABASE_NAME))
  await restoreFile(path.join(rollbackDirectory, IDENTITY_NAME), path.join(targetDirectory, IDENTITY_NAME))
  if (marker.had_recovery_state) {
    await restoreFile(path.join(rollbackDirectory, RECOVERY_STATE_NAME), path.join(targetDirectory, RECOVERY_STATE_NAME))
  } else {
    await rm(path.join(targetDirectory, RECOVERY_STATE_NAME), { force: true })
  }
  await rm(markerPath, { force: true })
}


import { backup, DatabaseSync } from "node:sqlite"
import { chmod, lstat, link, mkdtemp, open, realpath, rm, stat, unlink } from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import {
  digest,
  jsonBytes,
  verifyArchive,
  writeArchive
} from "./BackupArchive"

const MAX_STATE_BYTES = 512 * 1024 * 1024
const MAX_CONFIGURATION_BYTES = 4 * 1024 * 1024
const MAX_MANIFEST_BYTES = 256 * 1024
const IO_CHUNK_BYTES = 1024 * 1024
const DESKTOP_DATABASE_NAME = "prototype-client.db"
const DESKTOP_IDENTITY_NAME = "device-id"
const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const DURABLE_TABLES = new Set([
  "unsent_drafts",
  "command_attempts",
  "client_mappings",
  "reader_profiles",
  "launch_journal"
])

export interface DesktopBackupArchiveContext {
  readonly dataDirectory: string
  readonly databasePath?: string
  readonly outputPath: string
  readonly installationId: string
  readonly label: string | null
  /** Test-only failure seam; production callers leave this unset. */
  readonly beforePublish?: () => Promise<void>
}

export interface DesktopBackupArchiveResult {
  readonly archivePath: string
  readonly manifestDigest: string
  readonly archiveSizeBytes: number
  readonly installationId: string
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`

const isWithin = (child: string, parent: string): boolean => {
  const relativePath = path.relative(parent, child)
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
}

const assertDisjoint = (left: string, right: string, message: string): void => {
  if (isWithin(left, right) || isWithin(right, left)) throw new Error(message)
}

const resolveOutput = async (dataDirectory: string, outputPath: string): Promise<string> => {
  const requested = path.resolve(outputPath)
  const outputDirectory = await realpath(path.dirname(requested))
  assertDisjoint(
    outputDirectory,
    dataDirectory,
    "desktop backup destination overlaps the desktop data directory"
  )
  return path.join(outputDirectory, path.basename(requested))
}

const digestFile = async (filePath: string, expectedSize: number): Promise<string> => {
  const file = await open(filePath, "r")
  try {
    const hash = createHash("sha256")
    const buffer = new Uint8Array(IO_CHUNK_BYTES)
    let offset = 0
    while (offset < expectedSize) {
      const result = await file.read(buffer, 0, Math.min(buffer.length, expectedSize - offset), offset)
      if (result.bytesRead === 0) throw new Error("desktop backup payload ended before its declared size")
      hash.update(buffer.subarray(0, result.bytesRead))
      offset += result.bytesRead
    }
    if ((await file.stat()).size !== expectedSize) throw new Error("desktop backup payload changed during verification")
    return hash.digest("hex")
  } finally {
    await file.close()
  }
}

const validateSnapshot = (snapshot: DatabaseSync): void => {
  const integrity = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
  if (integrity.integrity_check !== "ok") throw new Error("desktop backup snapshot failed SQLite integrity check")
  if (snapshot.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new Error("desktop backup snapshot failed SQLite foreign-key check")
  }
}

const sourcePaths = (snapshot: DatabaseSync): ReadonlyArray<string> =>
  (snapshot.prepare("SELECT canonical_path FROM client_mappings").all() as unknown as ReadonlyArray<{ canonical_path: string }>)
    .map((row) => path.resolve(row.canonical_path))

/**
 * The client database also contains an evictable resolution cache. Copy the
 * SQLite store first for a coherent stopped-process snapshot, then remove that
 * cache and every object outside the application-owned durable schema. This
 * keeps a future or test-only secret table from becoming backup content.
 */
const retainDurableSchema = (snapshot: DatabaseSync): void => {
  snapshot.exec("PRAGMA foreign_keys = OFF")
  const objects = snapshot.prepare(`
    SELECT type, name, tbl_name
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'view' THEN 1 WHEN 'table' THEN 2 ELSE 3 END
  `).all() as unknown as ReadonlyArray<{ type: string; name: string; tbl_name: string }>
  for (const object of objects) {
    if (object.type === "table" && !DURABLE_TABLES.has(object.name)) {
      snapshot.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(object.name)}`)
    } else if (object.type === "view") {
      snapshot.exec(`DROP VIEW IF EXISTS ${quoteIdentifier(object.name)}`)
    } else if (object.type === "trigger") {
      snapshot.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(object.name)}`)
    } else if (object.type === "index" && !DURABLE_TABLES.has(object.tbl_name)) {
      snapshot.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(object.name)}`)
    }
  }
  if (snapshot.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get() !== undefined) {
    const retained = [...DURABLE_TABLES].map((name) => `'${name.replaceAll("'", "''")}'`).join(", ")
    snapshot.exec(`DELETE FROM sqlite_sequence WHERE name NOT IN (${retained})`)
  }
  snapshot.exec("PRAGMA foreign_keys = ON")
  validateSnapshot(snapshot)
  snapshot.exec("VACUUM")
}

const readConfiguration = (installationId: string) => ({
  format_version: 1,
  store_kind: "desktop",
  installation_id: installationId,
  included_data_classes: [
    "local mappings",
    "reader profiles",
    "launch journals",
    "saved drafts",
    "command attempts"
  ],
  excluded_data_classes: [
    "display and resolution caches",
    "desktop connection credentials",
    "collection files and source directories",
    "server state",
    "host service-manager and TLS configuration"
  ],
  credential_reset_instructions: "Reauthenticate the recovered desktop explicitly; copied connection credentials are not restored."
})

const writeAndVerify = async (
  archivePath: string,
  snapshotPath: string,
  stateSize: number,
  manifestBytes: Uint8Array,
  configurationBytes: Uint8Array
): Promise<void> => {
  await writeArchive(archivePath, snapshotPath, stateSize, manifestBytes, configurationBytes)
  await verifyArchive(archivePath, new Map([
    ["manifest.json", { size: manifestBytes.byteLength, sha256: digest(manifestBytes) }],
    ["state.sqlite", { size: stateSize, sha256: await digestFile(snapshotPath, stateSize) }],
    ["configuration.json", { size: configurationBytes.byteLength, sha256: digest(configurationBytes) }]
  ]))
}

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const publishWithoutReplacement = async (
  temporaryArchivePath: string,
  outputPath: string
): Promise<void> => {
  try {
    // Both paths are created in the same validated destination directory. A
    // hard link is atomic and fails with EEXIST instead of replacing a prior
    // verified recovery point, unlike rename(2).
    await link(temporaryArchivePath, outputPath)
  } catch (error) {
    switch (errorCode(error)) {
      case "EEXIST":
        throw new Error("desktop backup destination already exists")
      case "EXDEV":
      case "EOPNOTSUPP":
      case "ENOTSUP":
      case "EPERM":
        throw new Error("desktop backup publication is unsupported on this filesystem")
      default:
        throw error
    }
  }
}

export const createDesktopBackupArchive = async (
  context: DesktopBackupArchiveContext
): Promise<DesktopBackupArchiveResult> => {
  const dataDirectory = await realpath(path.resolve(context.dataDirectory))
  const databasePath = path.resolve(context.databasePath ?? path.join(dataDirectory, DESKTOP_DATABASE_NAME))
  const outputPath = await resolveOutput(dataDirectory, context.outputPath)
  if (path.dirname(databasePath) !== dataDirectory) {
    throw new Error("desktop client database must be inside the desktop data directory")
  }
  if (!INSTALLATION_ID_PATTERN.test(context.installationId)) {
    throw new Error("desktop installation identity is unavailable")
  }
  const canonicalDatabasePath = await realpath(databasePath)
  if (path.dirname(canonicalDatabasePath) !== dataDirectory) {
    throw new Error("desktop client database must be inside the desktop data directory")
  }

  try {
    const existing = await lstat(outputPath)
    if (existing.isSymbolicLink() || existing.isFile() || existing.isDirectory()) {
      throw new Error("desktop backup destination already exists")
    }
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  const stagingDirectory = await mkdtemp(path.join(dataDirectory, ".desktop-backup-staging-"))
  await chmod(stagingDirectory, 0o700)
  let temporaryArchivePath: string | undefined
  try {
    const snapshotPath = path.join(stagingDirectory, "state.sqlite")
    const snapshotStartedAt = new Date().toISOString()
    const source = new DatabaseSync(canonicalDatabasePath, { readOnly: true })
    let mappedSources: ReadonlyArray<string>
    try {
      mappedSources = sourcePaths(source)
      await backup(source, snapshotPath)
    } finally {
      source.close()
    }
    for (const mappedSource of mappedSources) {
      assertDisjoint(
        path.resolve(path.dirname(outputPath)),
        mappedSource,
        "desktop backup destination overlaps a configured collection mapping"
      )
    }

    const stateSizeBeforePrune = (await stat(snapshotPath)).size
    if (stateSizeBeforePrune > MAX_STATE_BYTES) throw new Error("desktop backup snapshot exceeds the size limit")
    const snapshot = new DatabaseSync(snapshotPath)
    try {
      retainDurableSchema(snapshot)
    } finally {
      snapshot.close()
    }
    const stateSize = (await stat(snapshotPath)).size
    if (stateSize > MAX_STATE_BYTES) throw new Error("desktop backup snapshot exceeds the size limit")
    const stateDigest = await digestFile(snapshotPath, stateSize)

    const configurationBytes = jsonBytes(readConfiguration(context.installationId))
    if (configurationBytes.byteLength > MAX_CONFIGURATION_BYTES) {
      throw new Error("desktop backup configuration exceeds the size limit")
    }
    const manifest = {
      format_version: 1,
      artifact_id: randomUUID(),
      store_kind: "desktop",
      installation_id: context.installationId,
      snapshot_started_at: snapshotStartedAt,
      snapshot_completed_at: new Date().toISOString(),
      retention_class: "archive",
      label: context.label,
      payloads: {
        "state.sqlite": { size_bytes: stateSize, sha256: stateDigest },
        "configuration.json": { size_bytes: configurationBytes.byteLength, sha256: digest(configurationBytes) }
      },
      included_data_classes: ["durable desktop local state and pending work"],
      excluded_data_classes: [
        "desktop connection credentials",
        "display and resolution caches",
        "collection files and source directories",
        "server state",
        "host service-manager and TLS configuration"
      ],
      credential_reset_instructions: "Reauthenticate the recovered desktop explicitly; copied connection credentials are not restored."
    }
    const manifestBytes = jsonBytes(manifest)
    if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("desktop backup manifest exceeds the size limit")

    temporaryArchivePath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomUUID()}.tmp`)
    await writeAndVerify(temporaryArchivePath, snapshotPath, stateSize, manifestBytes, configurationBytes)
    if (context.beforePublish !== undefined) await context.beforePublish()
    const outputParent = await realpath(path.dirname(outputPath))
    if (outputParent !== path.dirname(outputPath)) throw new Error("desktop backup destination changed before publication")
    await publishWithoutReplacement(temporaryArchivePath, outputPath)
    await syncDirectory(outputParent)
    await unlink(temporaryArchivePath)
    temporaryArchivePath = undefined
    await syncDirectory(outputParent)
    await verifyArchive(outputPath, new Map([
      ["manifest.json", { size: manifestBytes.byteLength, sha256: digest(manifestBytes) }],
      ["state.sqlite", { size: stateSize, sha256: stateDigest }],
      ["configuration.json", { size: configurationBytes.byteLength, sha256: digest(configurationBytes) }]
    ]))
    const archiveSizeBytes = (await stat(outputPath)).size
    return {
      archivePath: outputPath,
      manifestDigest: digest(manifestBytes),
      archiveSizeBytes,
      installationId: context.installationId
    }
  } finally {
    if (temporaryArchivePath !== undefined) await rm(temporaryArchivePath, { force: true })
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}

export { DESKTOP_DATABASE_NAME, DESKTOP_IDENTITY_NAME }

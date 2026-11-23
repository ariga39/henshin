import { backup, DatabaseSync } from "node:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import { join, dirname } from "node:path"
import {
  BlobWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter
} from "@zip.js/zip.js"
import {
  revalidateWritableLocation,
  validateWritableLocationSeparation,
  type SourceRootObservation,
  type WritableLocationObservation
} from "../analysis/NativeSourceBoundary"
import type {
  BackupArtifactCompletionOutcome,
  BackupArtifactReservationOutcome,
  BackupArtifactRow,
  BackupDestinationRow,
  ServerRootRow
} from "../persistence/worker-protocol"

const MAX_STATE_BYTES = 512 * 1024 * 1024
const MAX_CONFIGURATION_BYTES = 4 * 1024 * 1024
const MAX_MANIFEST_BYTES = 256 * 1024
const ARCHIVE_DIRECTORY = "archives"
const ARCHIVE_SUFFIX = ".henshin.zip"

export interface BackupArchiveContext {
  readonly dbPath: string
  readonly destination: BackupDestinationRow
  readonly roots: ReadonlyArray<ServerRootRow>
  readonly label: string | null
  readonly reserve: (request: {
    readonly artifactId: string
    readonly operationId: string
    readonly destinationId: string
    readonly relativePath: string
    readonly label: string | null
    readonly createdAtMs: number
  }) => Promise<BackupArtifactReservationOutcome>
  readonly complete: (request: {
    readonly artifactId: string
    readonly manifestDigest: string
    readonly sizeBytes: number
    readonly completedAtMs: number
  }) => Promise<BackupArtifactCompletionOutcome>
}

export interface BackupArchiveResult {
  readonly artifact: BackupArtifactRow
  readonly archivePath: string
  readonly manifestDigest: string
  readonly archiveSizeBytes: number
}

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

const jsonBytes = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`)

const sourceRootObservation = (root: ServerRootRow): SourceRootObservation => ({
  selectedPath: root.selectedPath,
  canonicalPath: root.canonicalPath,
  identity: { device: root.device, inode: root.inode }
})

const destinationObservation = (destination: BackupDestinationRow): WritableLocationObservation => ({
  selectedPath: destination.selectedPath,
  canonicalPath: destination.canonicalPath,
  identity: { device: destination.device, inode: destination.inode }
})

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

const ensureArchiveDirectory = async (destination: string): Promise<string> => {
  const expected = join(destination, ARCHIVE_DIRECTORY)
  try {
    const existing = await lstat(expected)
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("backup destination archive directory is unsafe")
  } catch (error) {
    if (!isMissing(error)) throw error
    await mkdir(expected)
  }
  const canonical = await realpath(expected)
  if (canonical !== expected) throw new Error("backup destination archive directory is unsafe")
  return canonical
}

const snapshotConfiguration = (snapshot: DatabaseSync) => {
  const state = snapshot.prepare(
    "SELECT instance_id, schema_version FROM server_state WHERE id = 1"
  ).get() as { instance_id: string; schema_version: number } | undefined
  const library = snapshot.prepare(
    "SELECT library_id, change_revision FROM server_library WHERE id = 1"
  ).get() as { library_id: string; change_revision: number } | undefined
  if (state === undefined || library === undefined) throw new Error("backup snapshot is missing server identity")

  const roots = snapshot.prepare(`
    SELECT root_id, label, selected_path, canonical_path, device, inode,
           mapping_revision, policy_revision, exclusions, state
    FROM server_roots ORDER BY rowid ASC
  `).all() as unknown as ReadonlyArray<{
    root_id: string
    label: string
    selected_path: string
    canonical_path: string
    device: string
    inode: string
    mapping_revision: number
    policy_revision: number
    exclusions: string
    state: "active"
  }>
  const destinations = snapshot.prepare(`
    SELECT destination_id, name, selected_path, canonical_path, device, inode, state
    FROM backup_destinations ORDER BY rowid ASC
  `).all() as unknown as ReadonlyArray<{
    destination_id: string
    name: string
    selected_path: string
    canonical_path: string
    device: string
    inode: string
    state: "active"
  }>

  return {
    format_version: 1,
    instance_id: state.instance_id,
    library_id: library.library_id,
    schema_version: state.schema_version,
    library_change_revision: library.change_revision,
    roots: roots.map((root) => ({
      root_id: root.root_id,
      label: root.label,
      selected_path: root.selected_path,
      canonical_path: root.canonical_path,
      device: root.device,
      inode: root.inode,
      mapping_revision: root.mapping_revision,
      policy_revision: root.policy_revision,
      exclusions: JSON.parse(root.exclusions) as unknown,
      state: root.state
    })),
    backup_destinations: destinations.map((destination) => ({
      destination_id: destination.destination_id,
      name: destination.name,
      selected_path: destination.selected_path,
      canonical_path: destination.canonical_path,
      device: destination.device,
      inode: destination.inode,
      state: destination.state
    }))
  }
}

const validateSnapshot = (snapshot: DatabaseSync): void => {
  const integrity = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
  if (integrity.integrity_check !== "ok") throw new Error("backup snapshot failed SQLite integrity check")
  if (snapshot.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new Error("backup snapshot failed SQLite foreign-key check")
  }
}

const verifyArchive = async (
  archiveBytes: Uint8Array,
  manifestBytes: Uint8Array,
  stateBytes: Uint8Array,
  configurationBytes: Uint8Array
): Promise<void> => {
  const reader = new ZipReader(new Uint8ArrayReader(archiveBytes))
  try {
    const entries = await reader.getEntries()
    const expected = new Map([
      ["manifest.json", manifestBytes],
      ["state.sqlite", stateBytes],
      ["configuration.json", configurationBytes]
    ])
    if (entries.length !== expected.size) throw new Error("backup archive has an unexpected member count")
    const seen = new Set<string>()
    for (const entry of entries) {
      if (entry.directory || entry.filename.includes("/") || entry.filename.startsWith("/") || seen.has(entry.filename)) {
        throw new Error("backup archive contains an unsafe member")
      }
      const wanted = expected.get(entry.filename)
      if (wanted === undefined) throw new Error("backup archive contains an unexpected member")
      seen.add(entry.filename)
      const actual = await entry.getData(new Uint8ArrayWriter())
      if (actual.byteLength !== wanted.byteLength || digest(actual) !== digest(wanted)) {
        throw new Error(`backup archive member failed verification: ${entry.filename}`)
      }
    }
  } finally {
    await reader.close()
  }
}

const writeFlushed = async (filePath: string, bytes: Uint8Array): Promise<void> => {
  const handle = await open(filePath, "wx")
  try {
    await handle.write(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const archiveBytes = async (
  manifestBytes: Uint8Array,
  stateBytes: Uint8Array,
  configurationBytes: Uint8Array
): Promise<Uint8Array> => {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  await writer.add("manifest.json", new Uint8ArrayReader(manifestBytes))
  await writer.add("state.sqlite", new Uint8ArrayReader(stateBytes))
  await writer.add("configuration.json", new Uint8ArrayReader(configurationBytes))
  const blob = await writer.close()
  return new Uint8Array(await blob.arrayBuffer())
}

export const createBackupArchive = async (context: BackupArchiveContext): Promise<BackupArchiveResult> => {
  const selected = await revalidateWritableLocation(destinationObservation(context.destination))
  if (!selected.ok) throw new Error("backup destination changed and requires replacement")
  const separation = await validateWritableLocationSeparation({
    sourceRoots: context.roots.map(sourceRootObservation),
    writableLocations: [dirname(context.dbPath), selected.value]
  })
  if (!separation.ok) throw new Error("backup destination overlaps a collection root or server data directory")

  const artifactId = randomUUID()
  const operationId = randomUUID()
  const relativePath = `${ARCHIVE_DIRECTORY}/${artifactId}${ARCHIVE_SUFFIX}`
  const reservation = await context.reserve({
    artifactId,
    operationId,
    destinationId: context.destination.destinationId,
    relativePath,
    label: context.label,
    createdAtMs: Date.now()
  })
  if (reservation.kind !== "reserved" && reservation.kind !== "replayed") {
    throw new Error(`backup artifact reservation failed: ${reservation.kind}`)
  }
  const artifact = reservation.artifact
  const archiveDirectory = await ensureArchiveDirectory(selected.value.canonicalPath)
  const finalPath = join(archiveDirectory, `${artifact.artifactId}${ARCHIVE_SUFFIX}`)
  const stagingDirectory = await mkdtemp(join(dirname(context.dbPath), ".backup-staging-"))
  let temporaryArchivePath: string | undefined
  try {
    const snapshotPath = join(stagingDirectory, "state.sqlite")
    const snapshotStartedAt = new Date().toISOString()
    const source = new DatabaseSync(context.dbPath, { readOnly: true })
    try {
      await backup(source, snapshotPath)
    } finally {
      source.close()
    }
    const stateBytes = new Uint8Array(await readFile(snapshotPath))
    if (stateBytes.byteLength > MAX_STATE_BYTES) throw new Error("backup snapshot exceeds the size limit")

    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
    let configuration: ReturnType<typeof snapshotConfiguration>
    try {
      validateSnapshot(snapshot)
      configuration = snapshotConfiguration(snapshot)
    } finally {
      snapshot.close()
    }
    const configurationBytes = jsonBytes(configuration)
    if (configurationBytes.byteLength > MAX_CONFIGURATION_BYTES) throw new Error("backup configuration exceeds the size limit")

    const manifest = {
      format_version: 1,
      artifact_id: artifact.artifactId,
      operation_id: artifact.operationId,
      destination_id: artifact.destinationId,
      relative_path: artifact.relativePath,
      publication_order: artifact.publicationOrder,
      store_kind: "server",
      instance_id: configuration.instance_id,
      library_id: configuration.library_id,
      application_version: "0.0.0",
      schema_version: configuration.schema_version,
      snapshot_started_at: snapshotStartedAt,
      snapshot_completed_at: new Date().toISOString(),
      library_change_revision: configuration.library_change_revision,
      retention_class: "archive",
      label: artifact.label,
      payloads: {
        "state.sqlite": { size_bytes: stateBytes.byteLength, sha256: digest(stateBytes) },
        "configuration.json": { size_bytes: configurationBytes.byteLength, sha256: digest(configurationBytes) }
      },
      included_data_classes: ["authoritative server state", "nonsecret application configuration"],
      excluded_data_classes: [
        "owner credentials",
        "authentication database",
        "owner token",
        "desktop connection credentials",
        "collection bytes",
        "host service-manager and TLS configuration"
      ],
      credential_reset_instructions: "Provision owner credentials separately and reset them before serving a recovered instance."
    }
    const manifestBytes = jsonBytes(manifest)
    if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("backup manifest exceeds the size limit")
    const bytes = await archiveBytes(manifestBytes, stateBytes, configurationBytes)
    temporaryArchivePath = join(archiveDirectory, `.${artifact.artifactId}.tmp`)
    await writeFlushed(temporaryArchivePath, bytes)
    await verifyArchive(new Uint8Array(await readFile(temporaryArchivePath)), manifestBytes, stateBytes, configurationBytes)

    if (process.env.HENSHIN_TEST_INTERRUPT_PUBLICATION === "1") {
      throw new Error("backup publication interrupted")
    }
    const revalidated = await revalidateWritableLocation(selected.value)
    if (!revalidated.ok) throw new Error("backup destination changed and publication was blocked")
    const beforePublishSeparation = await validateWritableLocationSeparation({
      sourceRoots: context.roots.map(sourceRootObservation),
      writableLocations: [dirname(context.dbPath), revalidated.value]
    })
    if (!beforePublishSeparation.ok) throw new Error("backup publication boundary is no longer separated")
    const finalParent = await realpath(dirname(finalPath))
    if (finalParent !== archiveDirectory) throw new Error("backup archive parent changed before publication")
    try {
      await lstat(finalPath)
      throw new Error("backup archive already exists")
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    await rename(temporaryArchivePath, finalPath)
    temporaryArchivePath = undefined
    const directoryHandle = await open(archiveDirectory, "r")
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
    const finalBytes = new Uint8Array(await readFile(finalPath))
    await verifyArchive(finalBytes, manifestBytes, stateBytes, configurationBytes)
    const finalSize = (await stat(finalPath)).size
    const completed = await context.complete({
      artifactId: artifact.artifactId,
      manifestDigest: digest(manifestBytes),
      sizeBytes: finalSize,
      completedAtMs: Date.now()
    })
    if (completed.kind !== "completed" && completed.kind !== "replayed") {
      throw new Error(`backup artifact publication was not recorded: ${completed.kind}`)
    }
    return {
      artifact: completed.artifact,
      archivePath: finalPath,
      manifestDigest: digest(manifestBytes),
      archiveSizeBytes: finalSize
    }
  } finally {
    if (temporaryArchivePath !== undefined) await rm(temporaryArchivePath, { force: true })
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}

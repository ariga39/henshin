import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdtemp, open, realpath, rm, stat } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { Option, Schema } from "effect"
import {
  BackupArchiveMemberSizeError,
  BackupArchiveSizeError,
  digestFile,
  inspectBackupArchive,
  MAX_CONFIGURATION_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_STATE_BYTES,
  readBackupArchiveMember,
  streamBackupArchiveEntry
} from "./BackupArchiveIO"
import { revalidateWritableLocation } from "../analysis/NativeSourceBoundary"

const ARCHIVE_DIRECTORY = "archives"
const ARCHIVE_SUFFIX = ".henshin.zip"
const CURRENT_SCHEMA_VERSION = 10
const RESTORE_MARKER = ".henshin-restore.json"
const RESTORE_STATE_TABLE = "server_restore_state"
const ROOT_VERIFICATION_TABLE = "server_root_verification"

const Digest = Schema.String.check(Schema.isMinLength(64), Schema.isMaxLength(64))
const ArchivePayload = Schema.Struct({ size_bytes: Schema.Natural, sha256: Digest })
const ArchiveManifest = Schema.Struct({
  format_version: Schema.Literal(1),
  artifact_id: Schema.String,
  operation_id: Schema.String,
  destination_id: Schema.String,
  relative_path: Schema.String,
  publication_order: Schema.Natural,
  store_kind: Schema.Literal("server"),
  instance_id: Schema.String,
  library_id: Schema.String,
  application_version: Schema.String,
  schema_version: Schema.Natural,
  snapshot_started_at: Schema.String,
  snapshot_completed_at: Schema.String,
  library_change_revision: Schema.Int,
  retention_class: Schema.Literal("archive"),
  label: Schema.NullOr(Schema.String),
  payloads: Schema.Struct({
    "state.sqlite": ArchivePayload,
    "configuration.json": ArchivePayload
  }),
  included_data_classes: Schema.Array(Schema.String),
  excluded_data_classes: Schema.Array(Schema.String),
  credential_reset_instructions: Schema.String
})
type ArchiveManifest = typeof ArchiveManifest.Type

const SnapshotConfiguration = Schema.Struct({
  format_version: Schema.Literal(1),
  instance_id: Schema.String,
  library_id: Schema.String,
  schema_version: Schema.Natural,
  library_change_revision: Schema.Int,
  roots: Schema.Array(Schema.Unknown),
  backup_destinations: Schema.Array(Schema.Unknown)
})
type SnapshotConfiguration = typeof SnapshotConfiguration.Type

export type RestoreArtifact = {
  readonly artifactId: string
  readonly destinationId: string
  readonly operationId: string
  readonly relativePath: string
  readonly publicationOrder: number
  readonly label: string | null
  readonly manifestDigest: string
  readonly sizeBytes: number
  readonly createdAtMs: number
  readonly completedAtMs: number
  readonly destination: {
    readonly selectedPath: string
    readonly canonicalPath: string
    readonly device: string
    readonly inode: string
  }
}

export type RestoreArtifactBinding = Pick<RestoreArtifact, "artifactId" | "destinationId" | "relativePath" | "manifestDigest">

export const listRestoreArtifacts = (dbPath: string): ReadonlyArray<RestoreArtifact> => {
  const database = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return (database.prepare(`
      SELECT a.artifact_id, a.destination_id, a.operation_id, a.relative_path, a.publication_order,
             a.label, a.manifest_digest, a.size_bytes, a.created_at_ms, a.completed_at_ms,
             d.selected_path, d.canonical_path, d.device, d.inode
      FROM backup_artifacts a
      JOIN backup_destinations d ON d.destination_id = a.destination_id
      WHERE a.status = 'completed' AND a.manifest_digest IS NOT NULL AND a.size_bytes IS NOT NULL
      ORDER BY a.publication_order DESC
    `).all() as Array<{
      artifact_id: string
      destination_id: string
      operation_id: string
      relative_path: string
      publication_order: number
      label: string | null
      manifest_digest: string
      size_bytes: number
      created_at_ms: number
      completed_at_ms: number
      selected_path: string
      canonical_path: string
      device: string
      inode: string
    }>).map((row) => ({
      artifactId: row.artifact_id,
      destinationId: row.destination_id,
      operationId: row.operation_id,
      relativePath: row.relative_path,
      publicationOrder: row.publication_order,
      label: row.label,
      manifestDigest: row.manifest_digest,
      sizeBytes: row.size_bytes,
      createdAtMs: row.created_at_ms,
      completedAtMs: row.completed_at_ms,
      destination: {
        selectedPath: row.selected_path,
        canonicalPath: row.canonical_path,
        device: row.device,
        inode: row.inode
      }
    }))
  } finally {
    database.close()
  }
}

export class BackupRestoreFailure extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "BackupRestoreFailure"
    this.code = code
  }
}

export type RestoreManifest = ArchiveManifest

export type RestoreTargetIdentity = {
  readonly instanceId: string
  readonly libraryId: string
  readonly changeRevision: number
}

export interface RestorePreview {
  readonly artifactId: string
  readonly recoveryPoint: {
    readonly snapshotStartedAt: string
    readonly snapshotCompletedAt: string
    readonly libraryChangeRevision: number
  }
  readonly affectedInterval: {
    readonly from: string
    readonly to: string
    readonly libraryChangeRevisions: {
      readonly from: number
      readonly to: number
      readonly estimatedLost: number
    }
  }
  readonly identity: {
    readonly instanceId: string
    readonly libraryId: string
  }
  readonly requiresConfirmation: true
}

export interface RestoreInputs {
  readonly manifest: RestoreManifest
  readonly configuration: SnapshotConfiguration
  readonly statePath: string
  readonly currentLibraryChangeRevision: number
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

const decodeManifest = (bytes: Uint8Array): ArchiveManifest => {
  try {
    const decoded = Schema.decodeUnknownOption(ArchiveManifest)(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
    if (Option.isSome(decoded)) return decoded.value
  } catch {
    // Report one bounded diagnostic for malformed archive members.
  }
  throw new BackupRestoreFailure("invalid-json", "backup manifest is invalid")
}

const decodeConfiguration = (bytes: Uint8Array): SnapshotConfiguration => {
  try {
    const decoded = Schema.decodeUnknownOption(SnapshotConfiguration)(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
    if (Option.isSome(decoded)) return decoded.value
  } catch {
    // Report one bounded diagnostic for malformed archive members.
  }
  throw new BackupRestoreFailure("invalid-json", "backup configuration is invalid")
}

const writeChunk = async (file: FileHandle, chunk: Uint8Array): Promise<void> => {
  let offset = 0
  while (offset < chunk.length) {
    const result = await file.write(chunk, offset, chunk.length - offset, null)
    if (result.bytesWritten === 0) throw new Error("backup restore output made no progress")
    offset += result.bytesWritten
  }
}

export const archivePath = async (artifact: RestoreArtifact): Promise<string> => {
  if (
    !artifact.relativePath.startsWith(`${ARCHIVE_DIRECTORY}/`) ||
    artifact.relativePath.includes("\\") ||
    artifact.relativePath.includes("\u0000")
  ) throw new BackupRestoreFailure("unsafe-artifact-path", "backup artifact path is invalid")
  const directory = join(artifact.destination.canonicalPath, ARCHIVE_DIRECTORY)
  try {
    if (await realpath(directory) !== directory) throw new Error("archive directory changed")
  } catch {
    throw new BackupRestoreFailure("destination-unavailable", "backup destination archive directory is unavailable")
  }
  const candidate = resolve(artifact.destination.canonicalPath, artifact.relativePath)
  const child = relative(directory, candidate)
  if (child.length === 0 || child.startsWith("..") || child.includes("/") || child.includes("\\") || !child.endsWith(ARCHIVE_SUFFIX)) {
    throw new BackupRestoreFailure("unsafe-artifact-path", "backup artifact path is invalid")
  }
  try {
    const entry = await lstat(candidate)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("artifact is not a regular file")
  } catch {
    throw new BackupRestoreFailure("artifact-unavailable", "backup artifact is unavailable")
  }
  return candidate
}

const readManifest = async (archive: string): Promise<{ readonly manifest: RestoreManifest; readonly bytes: Uint8Array }> => {
  try {
    return await inspectBackupArchive(archive, async (entries) => {
      const entry = entries.find((candidate) => candidate.filename === "manifest.json")
      if (entries.length !== 3 || entry === undefined || entry.directory || entry.symlink) {
        throw new BackupRestoreFailure("archive-members", "backup artifact has unexpected members")
      }
      if (entry.uncompressedSize !== undefined && entry.uncompressedSize > MAX_MANIFEST_BYTES) {
        throw new BackupArchiveMemberSizeError()
      }
      const bytes = await readBackupArchiveMember(entry, MAX_MANIFEST_BYTES)
      return { manifest: decodeManifest(bytes), bytes }
    })
  } catch (error) {
    if (error instanceof BackupRestoreFailure) throw error
    if (error instanceof BackupArchiveSizeError) throw new BackupRestoreFailure("archive-too-large", "backup artifact exceeds the size limit")
    if (error instanceof BackupArchiveMemberSizeError) throw new BackupRestoreFailure("member-too-large", "backup artifact member exceeds the size limit")
    throw new BackupRestoreFailure("archive-invalid", "backup artifact cannot be read")
  }
}

export const loadArchive = async (
  archive: string,
  stagingDirectory: string,
  artifact: RestoreArtifactBinding,
  currentLibraryChangeRevision: number
): Promise<RestoreInputs> => {
  const statePath = join(stagingDirectory, "state.sqlite")
  let stateFile: FileHandle | undefined
  try {
    const loaded = await inspectBackupArchive(archive, async (entries) => {
      if (entries.length !== 3) throw new BackupRestoreFailure("archive-members", "backup artifact has unexpected members")
      const expected = new Set(["manifest.json", "state.sqlite", "configuration.json"])
      const members = new Map<string, Uint8Array>()
      let stateSize: number | undefined
      for (const entry of entries) {
        if (entry.directory || entry.symlink || !expected.has(entry.filename) || members.has(entry.filename) || (entry.filename === "state.sqlite" && stateSize !== undefined)) {
          throw new BackupRestoreFailure("archive-members", "backup artifact has unsafe members")
        }
        const limit = entry.filename === "state.sqlite"
          ? MAX_STATE_BYTES
          : entry.filename === "configuration.json" ? MAX_CONFIGURATION_BYTES : MAX_MANIFEST_BYTES
        if (entry.uncompressedSize !== undefined && entry.uncompressedSize > limit) throw new BackupArchiveMemberSizeError()
        if (entry.filename === "state.sqlite") {
          stateFile = await open(statePath, "wx", 0o600)
          try {
            stateSize = await streamBackupArchiveEntry(entry, limit, (chunk) => writeChunk(stateFile as FileHandle, chunk))
            await stateFile.sync()
          } finally {
            await stateFile.close()
            stateFile = undefined
          }
        } else {
          members.set(entry.filename, await readBackupArchiveMember(entry, limit))
        }
      }
      const manifestBytes = members.get("manifest.json")
      const configurationBytes = members.get("configuration.json")
      if (manifestBytes === undefined || configurationBytes === undefined || stateSize === undefined) {
        throw new BackupRestoreFailure("archive-members", "backup artifact is incomplete")
      }
      const manifest = decodeManifest(manifestBytes)
      const configuration = decodeConfiguration(configurationBytes)
      if (
        sha256(manifestBytes) !== artifact.manifestDigest ||
        manifest.artifact_id !== artifact.artifactId ||
        manifest.destination_id !== artifact.destinationId ||
        manifest.relative_path !== artifact.relativePath ||
        manifest.retention_class !== "archive" ||
        manifest.payloads["state.sqlite"].size_bytes !== stateSize ||
        manifest.payloads["state.sqlite"].sha256 !== await digestFile(statePath, stateSize) ||
        manifest.payloads["configuration.json"].size_bytes !== configurationBytes.byteLength ||
        manifest.payloads["configuration.json"].sha256 !== sha256(configurationBytes)
      ) throw new BackupRestoreFailure("payload-digest", "backup artifact payload does not match its manifest")
      if (
        configuration.instance_id !== manifest.instance_id ||
        configuration.library_id !== manifest.library_id ||
        configuration.schema_version !== manifest.schema_version ||
        configuration.library_change_revision !== manifest.library_change_revision
      ) throw new BackupRestoreFailure("identity-mismatch", "backup manifest and configuration disagree")
      return { manifest, configuration, statePath, currentLibraryChangeRevision }
    })
    return loaded
  } catch (error) {
    if (error instanceof BackupRestoreFailure) throw error
    if (error instanceof BackupArchiveSizeError) throw new BackupRestoreFailure("archive-too-large", "backup artifact exceeds the size limit")
    if (error instanceof BackupArchiveMemberSizeError) throw new BackupRestoreFailure("member-too-large", "backup artifact member exceeds the size limit")
    throw new BackupRestoreFailure("archive-invalid", "backup artifact cannot be read")
  } finally {
    if (stateFile !== undefined) await stateFile.close()
  }
}

export const currentIdentity = (dbPath: string): RestoreTargetIdentity => {
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(dbPath, { readOnly: true, timeout: 0 })
    const state = database.prepare("SELECT instance_id, schema_version FROM server_state WHERE id = 1").get() as
      | { instance_id: string; schema_version: number }
      | undefined
    const library = database.prepare("SELECT library_id, change_revision FROM server_library WHERE id = 1").get() as
      | { library_id: string; change_revision: number }
      | undefined
    if (state === undefined || library === undefined) throw new BackupRestoreFailure("target-invalid", "existing target has no server identity")
    if (state.schema_version > CURRENT_SCHEMA_VERSION) throw new BackupRestoreFailure("schema-unsupported", "existing target schema is newer than this server")
    return { instanceId: state.instance_id, libraryId: library.library_id, changeRevision: library.change_revision }
  } catch (error) {
    if (error instanceof BackupRestoreFailure) throw error
    throw new BackupRestoreFailure("target-unreadable", "existing target cannot be read")
  } finally {
    database?.close()
  }
}

export const validateSnapshot = (inputs: RestoreInputs, target: { readonly instanceId: string; readonly libraryId: string }): void => {
  const snapshot = new DatabaseSync(inputs.statePath, { readOnly: true })
  try {
    const integrity = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
    if (integrity.integrity_check !== "ok") throw new BackupRestoreFailure("sqlite-integrity", "backup snapshot failed integrity validation")
    if (snapshot.prepare("PRAGMA foreign_key_check").all().length !== 0) throw new BackupRestoreFailure("sqlite-foreign-keys", "backup snapshot failed foreign-key validation")
    const state = snapshot.prepare("SELECT instance_id, schema_version FROM server_state WHERE id = 1").get() as
      | { instance_id: string; schema_version: number }
      | undefined
    const library = snapshot.prepare("SELECT library_id, change_revision FROM server_library WHERE id = 1").get() as
      | { library_id: string; change_revision: number }
      | undefined
    if (state === undefined || library === undefined) throw new BackupRestoreFailure("snapshot-identity", "backup snapshot has no server identity")
    if (
      state.instance_id !== inputs.manifest.instance_id ||
      library.library_id !== inputs.manifest.library_id ||
      library.change_revision !== inputs.manifest.library_change_revision ||
      state.schema_version !== inputs.manifest.schema_version ||
      state.instance_id !== inputs.configuration.instance_id ||
      library.library_id !== inputs.configuration.library_id ||
      state.schema_version !== inputs.configuration.schema_version
    ) throw new BackupRestoreFailure("identity-mismatch", "backup manifest, configuration, and snapshot disagree")
    if (state.instance_id !== target.instanceId || library.library_id !== target.libraryId) {
      throw new BackupRestoreFailure("authority-mismatch", "backup belongs to another server instance or library")
    }
    if (state.schema_version > CURRENT_SCHEMA_VERSION) throw new BackupRestoreFailure("schema-unsupported", "backup snapshot schema is newer than this server")
  } finally {
    snapshot.close()
  }
}


export const readRestorePoint = async (
  artifact: RestoreArtifact,
  targetOrDbPath: RestoreTargetIdentity | string,
  stagingRoot = typeof targetOrDbPath === "string" ? dirname(targetOrDbPath) : dirname(artifact.destination.canonicalPath)
): Promise<RestorePreview> => {
  const target = typeof targetOrDbPath === "string" ? currentIdentity(targetOrDbPath) : targetOrDbPath
  const destination = await revalidateWritableLocation({
    selectedPath: artifact.destination.selectedPath,
    canonicalPath: artifact.destination.canonicalPath,
    identity: { device: artifact.destination.device, inode: artifact.destination.inode }
  })
  if (!destination.ok) throw new BackupRestoreFailure("destination-changed", "backup destination changed and requires replacement")
  const archive = await archivePath(artifact)
  const { manifest, bytes } = await readManifest(archive)
  if (manifest.artifact_id !== artifact.artifactId || manifest.destination_id !== artifact.destinationId || manifest.relative_path !== artifact.relativePath || sha256(bytes) !== artifact.manifestDigest) {
    throw new BackupRestoreFailure("artifact-mismatch", "backup manifest is not bound to the catalog artifact")
  }
  const stagingDirectory = await mkdtemp(join(stagingRoot, ".backup-restore-preview-"))
  await chmod(stagingDirectory, 0o700)
  try {
    const inputs = await loadArchive(archive, stagingDirectory, artifact, target.changeRevision)
    validateSnapshot(inputs, target)
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
  return {
    artifactId: artifact.artifactId,
    recoveryPoint: {
      snapshotStartedAt: manifest.snapshot_started_at,
      snapshotCompletedAt: manifest.snapshot_completed_at,
      libraryChangeRevision: manifest.library_change_revision
    },
    affectedInterval: {
      from: manifest.snapshot_completed_at,
      to: new Date().toISOString(),
      libraryChangeRevisions: {
        from: manifest.library_change_revision,
        to: target.changeRevision,
        estimatedLost: Math.max(0, target.changeRevision - manifest.library_change_revision)
      }
    },
    identity: { instanceId: manifest.instance_id, libraryId: manifest.library_id },
    requiresConfirmation: true
  }
}

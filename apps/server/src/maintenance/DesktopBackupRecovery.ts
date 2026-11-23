import { prepareDesktopBackupSource } from "./DesktopBackupArchive"
import { pathToFileURL } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm
} from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import {
  inspectBackupArchive,
  readBackupArchiveMember,
  streamBackupArchiveEntry,
  MAX_CONFIGURATION_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_STATE_BYTES
} from "./BackupArchiveIO"

export const DESKTOP_DATABASE_NAME = "prototype-client.db"
export const DESKTOP_IDENTITY_NAME = "device-id"
export const DESKTOP_RECOVERY_STATE_NAME = "desktop-recovery-state.json"
const DESKTOP_STORE_SCHEMA_VERSION = 1
const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const DURABLE_TABLES = new Set([
  "desktop_store_metadata",
  "unsent_drafts",
  "command_attempts",
  "client_mappings",
  "reader_profiles",
  "launch_journal"
])
export const DERIVED_PATHS = ["thumbnail-cache"]

interface DesktopPayload {
  readonly size_bytes: number
  readonly sha256: string
}

interface DesktopManifest {
  readonly format_version: 1
  readonly store_kind: "desktop"
  readonly installation_id: string
  readonly application_version: string
  readonly schema_version: number
  readonly snapshot_started_at: string
  readonly snapshot_completed_at: string
  readonly retention_class: "archive"
  readonly payloads: {
    readonly "state.sqlite": DesktopPayload
    readonly "configuration.json": DesktopPayload
  }
  readonly included_data_classes: ReadonlyArray<string>
  readonly excluded_data_classes: ReadonlyArray<string>
  readonly credential_reset_instructions: string
}

interface DesktopConfiguration {
  readonly format_version: 1
  readonly store_kind: "desktop"
  readonly installation_id: string
  readonly schema_version: number
  readonly included_data_classes: ReadonlyArray<string>
  readonly excluded_data_classes: ReadonlyArray<string>
  readonly credential_reset_instructions: string
}

export interface DesktopTarget {
  readonly installationId: string
  readonly mappingsChanged: boolean
  readonly latestUpdatedAtMs: number | null
}

export interface LoadedDesktopBundle {
  readonly manifest: DesktopManifest
  readonly configuration: DesktopConfiguration
  readonly statePath: string
  readonly stateSize: number
}

export interface DesktopRecoveryPreview {
  readonly store_kind: "desktop"
  readonly applied: false
  readonly mappings_changed_since_backup: boolean
  readonly target_installation_id: string
  readonly recovery_installation_id: string
  readonly recovery_point: {
    readonly started_at: string
    readonly completed_at: string
    readonly schema_version: number
    readonly application_version: string
  }
  readonly lost_interval: {
    readonly from: string
    readonly to: string
    readonly estimated_milliseconds: number
  }
  readonly pending_work: {
    readonly drafts: number
    readonly command_attempts: number
    readonly launch_journal: number
  }
  readonly requires_confirmation: true
  readonly requires_fresh_authentication: true
  readonly mappings_require_review: true
  readonly reader_profiles_require_review: true
  readonly automatic_reader_launch_disabled: true
  readonly source_files_untouched: true
  readonly selected_backup_untouched: true
}

export interface DesktopRecoveryResult {
  readonly preview: DesktopRecoveryPreview
  readonly rollback_directory: string
  readonly recovery_state_path: string
}

export const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

export const isWithin = (child: string, parent: string): boolean => {
  const relativePath = path.relative(parent, child)
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

const decodeJson = <A>(bytes: Uint8Array, label: string): A => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as A
  } catch {
    throw new Error(`desktop backup ${label} is invalid`)
  }
}

const assertPayload = (value: unknown, label: string): DesktopPayload => {
  if (
    typeof value !== "object" || value === null ||
    !Number.isSafeInteger((value as { size_bytes?: unknown }).size_bytes) ||
    (value as { size_bytes: number }).size_bytes < 0 ||
    typeof (value as { sha256?: unknown }).sha256 !== "string" ||
    !/^[0-9a-f]{64}$/iu.test((value as { sha256: string }).sha256)
  ) throw new Error(`desktop backup ${label} payload metadata is invalid`)
  return value as DesktopPayload
}

const validateManifest = (value: unknown): DesktopManifest => {
  if (typeof value !== "object" || value === null) throw new Error("desktop backup manifest is invalid")
  const manifest = value as Partial<DesktopManifest> & { payloads?: Record<string, unknown> }
  if (
    manifest.format_version !== 1 || manifest.store_kind !== "desktop" ||
    !INSTALLATION_ID_PATTERN.test(manifest.installation_id ?? "") ||
    typeof manifest.application_version !== "string" || manifest.application_version.length === 0 ||
    manifest.schema_version !== DESKTOP_STORE_SCHEMA_VERSION ||
    typeof manifest.snapshot_started_at !== "string" || Number.isNaN(Date.parse(manifest.snapshot_started_at)) ||
    typeof manifest.snapshot_completed_at !== "string" || Number.isNaN(Date.parse(manifest.snapshot_completed_at)) ||
    manifest.retention_class !== "archive" || manifest.payloads === undefined
  ) throw new Error("desktop backup manifest is invalid")
  const state = assertPayload(manifest.payloads["state.sqlite"], "state.sqlite")
  const configuration = assertPayload(manifest.payloads["configuration.json"], "configuration.json")
  if (!Array.isArray(manifest.included_data_classes) || !Array.isArray(manifest.excluded_data_classes) || typeof manifest.credential_reset_instructions !== "string") {
    throw new Error("desktop backup manifest is invalid")
  }
  return { ...manifest, payloads: { "state.sqlite": state, "configuration.json": configuration } } as DesktopManifest
}

const validateConfiguration = (value: unknown): DesktopConfiguration => {
  if (typeof value !== "object" || value === null) throw new Error("desktop backup configuration is invalid")
  const configuration = value as Partial<DesktopConfiguration>
  if (
    configuration.format_version !== 1 || configuration.store_kind !== "desktop" ||
    !INSTALLATION_ID_PATTERN.test(configuration.installation_id ?? "") ||
    configuration.schema_version !== DESKTOP_STORE_SCHEMA_VERSION ||
    !Array.isArray(configuration.included_data_classes) || !Array.isArray(configuration.excluded_data_classes) ||
    typeof configuration.credential_reset_instructions !== "string"
  ) throw new Error("desktop backup configuration is invalid")
  return configuration as DesktopConfiguration
}

const writeChunk = async (file: FileHandle, chunk: Uint8Array, offset: { value: number }): Promise<void> => {
  let written = 0
  while (written < chunk.byteLength) {
    const result = await file.write(chunk, written, chunk.byteLength - written, offset.value + written)
    if (result.bytesWritten === 0) throw new Error("desktop backup restore staging made no progress")
    written += result.bytesWritten
  }
  offset.value += written
}

export const loadDesktopBackupArchive = async (archivePath: string, stagingDirectory: string): Promise<LoadedDesktopBundle> => {
  const archiveStat = await lstat(archivePath)
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) throw new Error("desktop backup archive is not a regular file")
  const statePath = path.join(stagingDirectory, "state.sqlite")
  let stateFile: FileHandle | undefined
  let stateSize = 0
  let stateDigest = ""
  let manifestBytes: Uint8Array | undefined
  let configurationBytes: Uint8Array | undefined
  try {
    await inspectBackupArchive(archivePath, async (entries) => {
      if (entries.length !== 3) throw new Error("desktop backup archive has unexpected members")
      const names = new Set<string>()
      for (const entry of entries) {
        if (entry.directory || entry.symlink || entry.filename.includes("/") || entry.filename.includes("\\") || names.has(entry.filename)) {
          throw new Error("desktop backup archive contains an unsafe member")
        }
        names.add(entry.filename)
        const limit = entry.filename === "state.sqlite"
          ? MAX_STATE_BYTES
          : entry.filename === "configuration.json" ? MAX_CONFIGURATION_BYTES : MAX_MANIFEST_BYTES
        if (entry.uncompressedSize !== undefined && entry.uncompressedSize > limit) {
          throw new Error("desktop backup archive member exceeds the size limit")
        }
        if (entry.filename === "state.sqlite") {
          stateFile = await open(statePath, "wx", 0o600)
          const hash = createHash("sha256")
          const offset = { value: 0 }
          try {
            stateSize = await streamBackupArchiveEntry(entry, limit, async (chunk) => {
              hash.update(chunk)
              await writeChunk(stateFile as FileHandle, chunk, offset)
            })
            await stateFile.sync()
          } finally {
            await stateFile.close()
            stateFile = undefined
          }
          stateDigest = hash.digest("hex")
        } else if (entry.filename === "manifest.json") {
          manifestBytes = await readBackupArchiveMember(entry, limit)
        } else if (entry.filename === "configuration.json") {
          configurationBytes = await readBackupArchiveMember(entry, limit)
        } else {
          throw new Error("desktop backup archive contains an unexpected member")
        }
      }
    })
  } finally {
    await stateFile?.close().catch(() => undefined)
  }
  if (manifestBytes === undefined || configurationBytes === undefined || stateSize === 0) {
    throw new Error("desktop backup archive is incomplete")
  }
  const manifest = validateManifest(decodeJson<unknown>(manifestBytes, "manifest"))
  const configuration = validateConfiguration(decodeJson<unknown>(configurationBytes, "configuration"))
  if (
    manifest.payloads["state.sqlite"].size_bytes !== stateSize ||
    manifest.payloads["state.sqlite"].sha256 !== stateDigest ||
    manifest.payloads["configuration.json"].size_bytes !== configurationBytes.byteLength ||
    manifest.payloads["configuration.json"].sha256 !== sha256(configurationBytes) ||
    manifest.store_kind !== configuration.store_kind ||
    manifest.installation_id !== configuration.installation_id ||
    manifest.schema_version !== configuration.schema_version
  ) throw new Error("desktop backup manifest, configuration, and payloads disagree")
  return { manifest, configuration, statePath, stateSize }
}

export const validateDesktopSnapshot = (statePath: string, installationId: string): { readonly pending: DesktopRecoveryPreview["pending_work"] } => {
  const snapshot = new DatabaseSync(statePath, { readOnly: true })
  try {
    const integrity = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
    if (integrity.integrity_check !== "ok") throw new Error("desktop backup snapshot failed SQLite integrity check")
    if (snapshot.prepare("PRAGMA foreign_key_check").all().length !== 0) throw new Error("desktop backup snapshot failed SQLite foreign-key check")
    const objects = snapshot.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE substr(name, 1, 7) <> 'sqlite_'").all() as unknown as ReadonlyArray<{ type: string; name: string; tbl_name: string }>
    for (const object of objects) {
      if (object.type !== "table" || !DURABLE_TABLES.has(object.name)) throw new Error(`desktop backup snapshot has an unrecognized schema object: ${object.name}`)
    }
    for (const table of DURABLE_TABLES) {
      if (snapshot.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === undefined) {
        throw new Error(`desktop backup snapshot is missing durable table: ${table}`)
      }
    }
    const identity = snapshot.prepare("SELECT installation_id, schema_version FROM desktop_store_metadata WHERE id = 1").get() as { installation_id: string; schema_version: number } | undefined
    if (identity?.installation_id !== installationId || identity.schema_version !== DESKTOP_STORE_SCHEMA_VERSION) {
      throw new Error("desktop backup snapshot identity is invalid")
    }
    const pending = {
      drafts: Number((snapshot.prepare("SELECT COUNT(*) AS count FROM unsent_drafts WHERE present = 1").get() as { count: number }).count),
      command_attempts: Number((snapshot.prepare("SELECT COUNT(*) AS count FROM command_attempts WHERE status IN ('prepared', 'submitted', 'unresolved') AND dismissed = 0").get() as { count: number }).count),
      launch_journal: Number((snapshot.prepare("SELECT COUNT(*) AS count FROM launch_journal WHERE status IN ('prepared', 'unknown') OR (status = 'accepted' AND delivery_status <> 'acknowledged')").get() as { count: number }).count)
    }
    return { pending }
  } finally {
    snapshot.close()
  }
}

export const readDesktopRecoveryTarget = async (dataDirectory: string, stagingDirectory: string, snapshotPath: string): Promise<DesktopTarget> => {
  const installationId = (await readFile(path.join(dataDirectory, DESKTOP_IDENTITY_NAME), "utf8")).trim()
  if (!INSTALLATION_ID_PATTERN.test(installationId)) throw new Error("desktop maintenance failed at data-directory: installation identity is unavailable")
  const source = await prepareDesktopBackupSource(path.join(dataDirectory, DESKTOP_DATABASE_NAME), stagingDirectory)
  const database = new DatabaseSync(source.readOnly ? pathToFileURL(source.path).href + "?immutable=1" : source.path, {
    readOnly: source.readOnly, timeout: 0
  })
  try {
    const identity = database.prepare(
      "SELECT installation_id, schema_version FROM desktop_store_metadata WHERE id = 1"
    ).get()
    if (identity?.installation_id !== installationId) throw new Error("desktop target database and installation identity disagree")
    if (identity.schema_version !== DESKTOP_STORE_SCHEMA_VERSION) throw new Error("desktop target has an unsupported schema version")
    const latest = database.prepare(`
      SELECT MAX(updated_at_ms) AS updated_at_ms FROM (
        SELECT updated_at_ms FROM unsent_drafts
        UNION ALL SELECT updated_at_ms FROM command_attempts
        UNION ALL SELECT updated_at_ms FROM reader_profiles
        UNION ALL SELECT updated_at_ms FROM launch_journal
      )
    `).get() as { updated_at_ms: number | null }
    database.prepare("ATTACH DATABASE ? AS archived").run(snapshotPath)
    const columns = "instance_id, root_id, mapping_revision, selected_path, canonical_path, state"
    const live = `SELECT ${columns} FROM main.client_mappings`
    const saved = `SELECT ${columns} FROM archived.client_mappings`
    const comparison = database.prepare(`SELECT EXISTS(${live} EXCEPT ${saved}) OR EXISTS(${saved} EXCEPT ${live}) AS changed`).get()
    return { installationId, latestUpdatedAtMs: latest.updated_at_ms, mappingsChanged: comparison?.changed === 1 }
  } finally {
    database.close()
  }
}

export const previewDesktopRecovery = async (dataDirectory: string, archivePath: string): Promise<DesktopRecoveryPreview> => {
  const targetDirectory = await realpath(dataDirectory)
  const selectedArchive = await realpath(path.resolve(archivePath))
  if (isWithin(selectedArchive, targetDirectory)) throw new Error("desktop backup archive must be outside the desktop data directory")
  const stagingDirectory = await mkdtemp(path.join(targetDirectory, ".desktop-recovery-validation-"))
  await chmod(stagingDirectory, 0o700)
  try {
    const bundle = await loadDesktopBackupArchive(selectedArchive, stagingDirectory)
    const target = await readDesktopRecoveryTarget(targetDirectory, stagingDirectory, bundle.statePath)
    if (bundle.manifest.installation_id !== target.installationId) throw new Error("desktop backup belongs to another installation")
    const { pending } = validateDesktopSnapshot(bundle.statePath, bundle.manifest.installation_id)
    const recoveryPointMs = Date.parse(bundle.manifest.snapshot_completed_at)
    const latestTargetMs = target.latestUpdatedAtMs ?? recoveryPointMs
    const lostToMs = Math.max(recoveryPointMs, latestTargetMs, target.mappingsChanged ? Date.now() : recoveryPointMs)
    return {
      store_kind: "desktop",
      applied: false,
      mappings_changed_since_backup: target.mappingsChanged,
      target_installation_id: target.installationId,
      recovery_installation_id: bundle.manifest.installation_id,
      recovery_point: {
        started_at: bundle.manifest.snapshot_started_at,
        completed_at: bundle.manifest.snapshot_completed_at,
        schema_version: bundle.manifest.schema_version,
        application_version: bundle.manifest.application_version
      },
      lost_interval: {
        from: bundle.manifest.snapshot_completed_at,
        to: new Date(lostToMs).toISOString(),
        estimated_milliseconds: Math.max(0, lostToMs - recoveryPointMs)
      },
      pending_work: pending,
      requires_confirmation: true,
      requires_fresh_authentication: true,
      mappings_require_review: true,
      reader_profiles_require_review: true,
      automatic_reader_launch_disabled: true,
      source_files_untouched: true,
      selected_backup_untouched: true
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}

import { createHash } from "node:crypto"
import { lstat, rm, realpath } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { Option, Schema } from "effect"
import type { Entry } from "@zip.js/zip.js"
import {
  revalidateWritableLocation,
  validateWritableLocationSeparation,
  type SourceRootObservation,
  type WritableLocationObservation
} from "../analysis/NativeSourceBoundary"
import {
  inspectBackupArchive,
  MAX_CONFIGURATION_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_STATE_BYTES,
  readBackupArchiveMember,
  streamBackupArchiveEntry
} from "./BackupArchiveIO"
import type {
  BackupArtifactDeletionOutcome,
  BackupArtifactRow,
  BackupDestinationRow,
  BackupRetentionPolicyMutationOutcome,
  BackupRetentionPolicyRow,
  ServerRootRow
} from "../persistence/worker-protocol"

export const ROTATING_KEEP_COUNT = 7

const ROTATING_DIRECTORY = "rotating"
const ARCHIVE_SUFFIX = ".henshin.zip"
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const MAX_WARNING_CODE_LENGTH = 100
const MAX_WARNING_MESSAGE_LENGTH = 512

const Digest = Schema.String.check(Schema.isMinLength(64), Schema.isMaxLength(64))
const RetentionManifest = Schema.Struct({
  format_version: Schema.Literal(1),
  artifact_id: Schema.String,
  operation_id: Schema.String,
  destination_id: Schema.String,
  relative_path: Schema.String,
  publication_order: Schema.Natural,
  store_kind: Schema.Literal("server"),
  retention_class: Schema.Literal("rotating"),
  payloads: Schema.Struct({
    "state.sqlite": Schema.Struct({ size_bytes: Schema.Natural, sha256: Digest }),
    "configuration.json": Schema.Struct({ size_bytes: Schema.Natural, sha256: Digest })
  })
})

type FileIdentity = {
  readonly device: number | bigint
  readonly inode: number | bigint
  readonly size: number | bigint
}

type VerifiedArtifact = {
  readonly path: string
  readonly identity: FileIdentity
}

export interface BackupRetentionContext {
  readonly dbPath: string
  readonly destination: BackupDestinationRow
  readonly roots: ReadonlyArray<ServerRootRow>
  readonly policy: BackupRetentionPolicyRow
  readonly artifacts: ReadonlyArray<BackupArtifactRow>
  readonly markDeleted: (request: {
    readonly artifactId: string
    readonly deletedAtMs: number
  }) => Promise<BackupArtifactDeletionOutcome>
  readonly recordOutcome: (request: {
    readonly destinationId: string
    readonly outcome: "success" | "warning"
    readonly warningCode: string | null
    readonly warningMessage: string | null
    readonly completedAtMs: number
  }) => Promise<BackupRetentionPolicyMutationOutcome>
}

export interface BackupRetentionResult {
  readonly state: "disabled" | "applied" | "warning"
  readonly keepCount: typeof ROTATING_KEEP_COUNT
  readonly deletedArtifactIds: ReadonlyArray<string>
  readonly warningCode: string | null
  readonly warningMessage: string | null
}

const destinationObservation = (destination: BackupDestinationRow): WritableLocationObservation => ({
  selectedPath: destination.selectedPath,
  canonicalPath: destination.canonicalPath,
  identity: { device: destination.device, inode: destination.inode }
})

const sourceRootObservation = (root: ServerRootRow): SourceRootObservation => ({
  selectedPath: root.selectedPath,
  canonicalPath: root.canonicalPath,
  identity: { device: root.device, inode: root.inode }
})

const retentionWarning = (
  code: string,
  message: string,
  deletedArtifactIds: ReadonlyArray<string> = []
): BackupRetentionResult => ({
  state: "warning",
  keepCount: ROTATING_KEEP_COUNT,
  deletedArtifactIds,
  warningCode: code.slice(0, MAX_WARNING_CODE_LENGTH),
  warningMessage: message.slice(0, MAX_WARNING_MESSAGE_LENGTH)
})

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

const artifactPath = async (
  destination: BackupDestinationRow,
  relativePath: string
): Promise<string> => {
  if (
    !relativePath.startsWith(`${ROTATING_DIRECTORY}/`) ||
    relativePath.includes("\\") ||
    relativePath.includes("\u0000")
  ) throw new Error("catalog artifact path is unsafe")
  const directory = join(destination.canonicalPath, ROTATING_DIRECTORY)
  if (await realpath(directory) !== directory) throw new Error("rotating backup directory is unsafe")
  const resolved = resolve(destination.canonicalPath, relativePath)
  const child = relative(directory, resolved)
  if (child.length === 0 || child.startsWith("..") || child.includes("/") || child.includes("\\") || !child.endsWith(ARCHIVE_SUFFIX)) {
    throw new Error("catalog artifact path is unsafe")
  }
  return resolved
}

const identityOf = (entry: Awaited<ReturnType<typeof lstat>>): FileIdentity => ({
  device: entry.dev,
  inode: entry.ino,
  size: entry.size
})

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.device === right.device && left.inode === right.inode && left.size === right.size

const decodeRetentionManifest = (bytes: Uint8Array): typeof RetentionManifest.Type => {
  try {
    const decoded = Schema.decodeUnknownOption(RetentionManifest)(JSON.parse(textDecoder.decode(bytes)))
    if (Option.isSome(decoded)) return decoded.value
  } catch {
    // Convert malformed archive metadata into a bounded retention warning.
  }
  throw new Error("backup artifact manifest is invalid")
}

const digestEntry = async (
  entry: Entry,
  expected: { readonly size_bytes: number; readonly sha256: string }
): Promise<void> => {
  const hash = createHash("sha256")
  const size = await streamBackupArchiveEntry(entry, expected.size_bytes, (chunk) => {
    hash.update(chunk)
  })
  if (size !== expected.size_bytes || hash.digest("hex") !== expected.sha256) {
    throw new Error(`backup artifact payload failed verification: ${entry.filename}`)
  }
}

const verifyOwnedArchive = async (
  destination: BackupDestinationRow,
  artifact: BackupArtifactRow
): Promise<VerifiedArtifact> => {
  const path = await artifactPath(destination, artifact.relativePath)
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("catalog artifact is not an owned regular file")
  if (artifact.sizeBytes === null || before.size !== artifact.sizeBytes) {
    throw new Error("catalog artifact size does not match the published artifact")
  }
  if (artifact.manifestDigest === null) throw new Error("catalog artifact has no published manifest digest")

  await inspectBackupArchive(path, async (entries) => {
    if (entries.length !== 3) throw new Error("backup artifact has unexpected members")
    const byName = new Map<string, typeof entries[number]>()
    for (const entry of entries) {
      if (entry.directory || entry.symlink || byName.has(entry.filename) ||
        !["manifest.json", "state.sqlite", "configuration.json"].includes(entry.filename)) {
        throw new Error("backup artifact has unsafe members")
      }
      byName.set(entry.filename, entry)
    }
    const manifestEntry = byName.get("manifest.json")
    const stateEntry = byName.get("state.sqlite")
    const configurationEntry = byName.get("configuration.json")
    if (manifestEntry === undefined || stateEntry === undefined || configurationEntry === undefined) {
      throw new Error("backup artifact is incomplete")
    }
    if (manifestEntry.uncompressedSize !== undefined && manifestEntry.uncompressedSize > MAX_MANIFEST_BYTES) {
      throw new Error("backup artifact manifest exceeds the size limit")
    }
    const manifestBytes = await readBackupArchiveMember(manifestEntry, MAX_MANIFEST_BYTES)
    if (createHash("sha256").update(manifestBytes).digest("hex") !== artifact.manifestDigest) {
      throw new Error("backup artifact manifest digest does not match the catalog")
    }
    const manifest = decodeRetentionManifest(manifestBytes)
    if (manifest.artifact_id !== artifact.artifactId || manifest.operation_id !== artifact.operationId ||
      manifest.destination_id !== artifact.destinationId || manifest.relative_path !== artifact.relativePath ||
      manifest.publication_order !== artifact.publicationOrder || manifest.retention_class !== artifact.retentionClass) {
      throw new Error("backup artifact manifest identity does not match the catalog")
    }
    if (stateEntry.uncompressedSize !== undefined && stateEntry.uncompressedSize > MAX_STATE_BYTES) {
      throw new Error("backup artifact state exceeds the size limit")
    }
    if (configurationEntry.uncompressedSize !== undefined && configurationEntry.uncompressedSize > MAX_CONFIGURATION_BYTES) {
      throw new Error("backup artifact configuration exceeds the size limit")
    }
    await digestEntry(stateEntry, manifest.payloads["state.sqlite"])
    await digestEntry(configurationEntry, manifest.payloads["configuration.json"])
  })

  const after = await lstat(path)
  const identity = identityOf(after)
  if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(identityOf(before), identity)) {
    throw new Error("backup artifact changed during verification")
  }
  return { path, identity }
}

const revalidateVerifiedArtifact = async (verified: VerifiedArtifact): Promise<void> => {
  const current = await lstat(verified.path)
  if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(verified.identity, identityOf(current))) {
    throw new Error("backup artifact changed after verification")
  }
}

const record = async (
  context: BackupRetentionContext,
  result: BackupRetentionResult
): Promise<BackupRetentionResult> => {
  try {
    await context.recordOutcome({
      destinationId: context.destination.destinationId,
      outcome: result.state === "warning" ? "warning" : "success",
      warningCode: result.warningCode,
      warningMessage: result.warningMessage,
      completedAtMs: Date.now()
    })
    return result
  } catch (error) {
    return retentionWarning(
      "retention-state-unrecorded",
      `retention cleanup completed but its outcome could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
      result.deletedArtifactIds
    )
  }
}

export const applyBackupRetention = async (
  context: BackupRetentionContext
): Promise<BackupRetentionResult> => {
  if (!context.policy.enabled || (context.policy.state !== "enabled" && context.policy.state !== "warning")) {
    return {
      state: "disabled",
      keepCount: ROTATING_KEEP_COUNT,
      deletedArtifactIds: [],
      warningCode: null,
      warningMessage: null
    }
  }
  if (
    context.policy.authorizedDevice === null ||
    context.policy.authorizedInode === null ||
    context.policy.authorizedDevice !== context.destination.device ||
    context.policy.authorizedInode !== context.destination.inode
  ) {
    return record(context, retentionWarning("retention-authorization-stale", "retention authorization does not match the registered destination"))
  }

  const current = await revalidateWritableLocation(destinationObservation(context.destination))
  if (!current.ok) return record(context, retentionWarning("destination-changed", "backup destination changed and requires replacement"))
  const separation = await validateWritableLocationSeparation({
    sourceRoots: context.roots.map(sourceRootObservation),
    writableLocations: [dirname(context.dbPath), current.value]
  })
  if (!separation.ok) return record(context, retentionWarning("location-overlap", separation.message))

  const rotating = context.artifacts
    .filter((artifact) => artifact.destinationId === context.destination.destinationId && artifact.retentionClass === "rotating" && artifact.status === "completed")
    .sort((left, right) => left.publicationOrder - right.publicationOrder)
  if (rotating.length <= ROTATING_KEEP_COUNT) {
    return record(context, {
      state: "applied",
      keepCount: ROTATING_KEEP_COUNT,
      deletedArtifactIds: [],
      warningCode: null,
      warningMessage: null
    })
  }

  const newest = rotating[rotating.length - 1]
  let newestVerified: VerifiedArtifact
  try {
    newestVerified = await verifyOwnedArchive(context.destination, newest)
  } catch (error) {
    return record(context, retentionWarning(
      isMissing(error) ? "newest-recovery-point-missing" : "newest-recovery-point-invalid",
      isMissing(error) ? "newest verified rotating recovery point is missing" : (error instanceof Error ? error.message : String(error))
    ))
  }

  const eligible = rotating.slice(0, -ROTATING_KEEP_COUNT)
  const verified = new Map<string, VerifiedArtifact>([[newest.artifactId, newestVerified]])
  const deletedArtifactIds: Array<string> = []
  const recordDeleted = (artifactId: string): void => {
    if (!deletedArtifactIds.includes(artifactId)) deletedArtifactIds.push(artifactId)
  }
  const reconcileMissing = async (artifact: BackupArtifactRow): Promise<void> => {
    const deleted = await context.markDeleted({ artifactId: artifact.artifactId, deletedAtMs: Date.now() })
    if (deleted.kind !== "deleted" && deleted.kind !== "artifact_not_completed") {
      throw new Error(`catalog deletion was not recorded: ${deleted.kind}`)
    }
    recordDeleted(artifact.artifactId)
  }

  for (const artifact of eligible) {
    try {
      verified.set(artifact.artifactId, await verifyOwnedArchive(context.destination, artifact))
    } catch (error) {
      if (!isMissing(error)) {
        return record(context, retentionWarning(
          "catalog-ownership-uncertain",
          error instanceof Error ? error.message : String(error),
          deletedArtifactIds
        ))
      }
      try {
        await reconcileMissing(artifact)
      } catch (reconcileError) {
        return record(context, retentionWarning(
          "cleanup-failed",
          `retention cleanup stopped after reconciling ${deletedArtifactIds.length} artifact(s): ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`,
          deletedArtifactIds
        ))
      }
    }
  }

  try {
    await revalidateVerifiedArtifact(newestVerified)
  } catch (error) {
    return record(context, retentionWarning(
      isMissing(error) ? "newest-recovery-point-missing" : "catalog-ownership-uncertain",
      isMissing(error) ? "the newest verified rotating recovery point disappeared before cleanup; cleanup was left intact" :
        (error instanceof Error ? error.message : String(error)),
      deletedArtifactIds
    ))
  }
  for (const artifact of eligible) {
    const candidate = verified.get(artifact.artifactId)
    if (candidate === undefined) continue
    try {
      await revalidateVerifiedArtifact(candidate)
    } catch (error) {
      if (!isMissing(error)) {
        return record(context, retentionWarning(
          "catalog-ownership-uncertain",
          error instanceof Error ? error.message : String(error),
          deletedArtifactIds
        ))
      }
      try {
        await reconcileMissing(artifact)
        verified.delete(artifact.artifactId)
      } catch (reconcileError) {
        return record(context, retentionWarning(
          "cleanup-failed",
          `retention cleanup stopped after reconciling ${deletedArtifactIds.length} artifact(s): ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`,
          deletedArtifactIds
        ))
      }
    }
  }

  for (const artifact of eligible) {
    const candidate = verified.get(artifact.artifactId)
    if (candidate === undefined) continue
    try {
      await revalidateVerifiedArtifact(candidate)
      await rm(candidate.path)
      const deleted = await context.markDeleted({ artifactId: artifact.artifactId, deletedAtMs: Date.now() })
      if (deleted.kind !== "deleted" && deleted.kind !== "artifact_not_completed") {
        throw new Error(`catalog deletion was not recorded: ${deleted.kind}`)
      }
      recordDeleted(artifact.artifactId)
    } catch (error) {
      if (isMissing(error)) {
        try {
          await reconcileMissing(artifact)
          continue
        } catch (reconcileError) {
          return record(context, retentionWarning(
            "cleanup-failed",
            `retention cleanup stopped after reconciling ${deletedArtifactIds.length} artifact(s): ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`,
            deletedArtifactIds
          ))
        }
      }
      return record(context, retentionWarning(
        "cleanup-failed",
        `retention cleanup stopped after ${deletedArtifactIds.length} artifact(s): ${error instanceof Error ? error.message : String(error)}`,
        deletedArtifactIds
      ))
    }
  }
  return record(context, {
    state: "applied",
    keepCount: ROTATING_KEEP_COUNT,
    deletedArtifactIds,
    warningCode: null,
    warningMessage: null
  })
}

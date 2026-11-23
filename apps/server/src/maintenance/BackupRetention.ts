import { lstat, rm, realpath } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import {
  revalidateWritableLocation,
  validateWritableLocationSeparation,
  type SourceRootObservation,
  type WritableLocationObservation
} from "../analysis/NativeSourceBoundary"
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
  warningCode: code,
  warningMessage: message
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

const assertOwnedFile = async (destination: BackupDestinationRow, relativePath: string): Promise<string> => {
  const path = await artifactPath(destination, relativePath)
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("catalog artifact is not an owned regular file")
  return path
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
  try {
    await assertOwnedFile(context.destination, newest.relativePath)
  } catch (error) {
    return record(context, retentionWarning(
      isMissing(error) ? "newest-recovery-point-missing" : "catalog-ownership-uncertain",
      isMissing(error) ? "newest verified rotating recovery point is missing" : (error instanceof Error ? error.message : String(error))
    ))
  }

  const eligible = rotating.slice(0, -ROTATING_KEEP_COUNT)
  const paths = new Map<string, string>()
  try {
    for (const artifact of eligible) paths.set(artifact.artifactId, await assertOwnedFile(context.destination, artifact.relativePath))
  } catch (error) {
    return record(context, retentionWarning(
      isMissing(error) ? "eligible-artifact-missing" : "catalog-ownership-uncertain",
      isMissing(error) ? "an eligible rotating artifact is missing; cleanup was left intact" : (error instanceof Error ? error.message : String(error))
    ))
  }

  const deletedArtifactIds: Array<string> = []
  for (const artifact of eligible) {
    const path = paths.get(artifact.artifactId)
    if (path === undefined) return record(context, retentionWarning("catalog-ownership-uncertain", "eligible artifact path was not retained", deletedArtifactIds))
    try {
      await rm(path)
      const deleted = await context.markDeleted({ artifactId: artifact.artifactId, deletedAtMs: Date.now() })
      if (deleted.kind !== "deleted") throw new Error(`catalog deletion was not recorded: ${deleted.kind}`)
      deletedArtifactIds.push(artifact.artifactId)
    } catch (error) {
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

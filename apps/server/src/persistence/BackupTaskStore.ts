import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { BackupTask, type BackupTask as BackupTaskType } from "@henshin/contracts"
import { createBackupArchive, backupArchiveRelativePath } from "../maintenance/BackupArchive"
import { BackupDestinationStore } from "./BackupDestinationStore"
import { DatabaseWorker, DatabaseWorkerError } from "./DatabaseWorker"
import { RootStore } from "./RootStore"
import {
  BackupTaskRow,
  BackupTaskStartOutcome,
  BackupArtifactCompletionOutcome,
  BackupArtifactReservationOutcome,
  type BackupDestinationRow,
  type ServerRootRow
} from "./worker-protocol"

export type BackupTaskStartResult =
  | { readonly kind: "created" | "replayed"; readonly task: BackupTaskType }
  | { readonly kind: "operation_conflict" | "destination_not_found" }

const decodeTask = Schema.decodeUnknownOption(BackupTaskRow)
const decodeTasks = Schema.decodeUnknownOption(Schema.Array(BackupTaskRow))
const decodeStart = Schema.decodeUnknownOption(BackupTaskStartOutcome)

const taskView = (row: typeof BackupTaskRow.Type): BackupTaskType => ({
  task_id: row.task_id,
  kind: "backup",
  mode: "manual",
  artifact_id: row.artifact_id,
  operation_id: row.operation_id,
  destination_id: row.destination_id,
  retention_class: "archive",
  label: row.label,
  relative_path: row.relative_path,
  status: row.status,
  manifest_digest: row.manifest_digest,
  size_bytes: row.size_bytes,
  error: row.error_code === null || row.error_message === null
    ? null
    : { code: row.error_code, message: row.error_message },
  created_at_ms: row.created_at_ms,
  updated_at_ms: row.updated_at_ms,
  completed_at_ms: row.artifact_completed_at_ms
})

export class BackupTaskStore extends Context.Service<
  BackupTaskStore,
  {
    readonly start: (input: {
      readonly operationId: string
      readonly epoch: string
      readonly destinationId: string
      readonly label: string | null
    }) => Effect.Effect<BackupTaskStartResult, DatabaseWorkerError>
    readonly list: () => Effect.Effect<ReadonlyArray<BackupTaskType>, DatabaseWorkerError>
    readonly read: (taskId: string) => Effect.Effect<BackupTaskType | null, DatabaseWorkerError>
    readonly run: (taskId: string) => Effect.Effect<void>
  }
>()("henshin/server/BackupTaskStore") {
  static readonly layer = (
    dbPath: string
  ): Layer.Layer<BackupTaskStore, never, DatabaseWorker | BackupDestinationStore | RootStore> => Layer.effect(
    BackupTaskStore,
    Effect.gen(function*() {
      const worker = yield* DatabaseWorker
      const destinations = yield* BackupDestinationStore
      const roots = yield* RootStore
      const active = new Set<string>()

      const readRow = (taskId: string) => worker.call({ op: "readBackupTask", taskId }).pipe(
        Effect.flatMap((value) => value === null
          ? Effect.succeed(null)
          : Effect.try({
              try: () => {
                const decoded = decodeTask(value)
                if (Option.isNone(decoded)) throw new Error("invalid persisted backup task")
                return decoded.value
              },
              catch: () => new DatabaseWorkerError({ message: "invalid persisted backup task" })
            }))
      )

      const read = (taskId: string) => readRow(taskId).pipe(
        Effect.map((row) => row === null ? null : taskView(row))
      )

      const start = (input: {
        readonly operationId: string
        readonly epoch: string
        readonly destinationId: string
        readonly label: string | null
      }) => Effect.gen(function*() {
        const destination = (yield* destinations.list()).find(
          (candidate) => candidate.destinationId === input.destinationId
        )
        if (destination === undefined || destination.state !== "active") {
          return { kind: "destination_not_found" } as const
        }

        const taskId = randomUUID()
        const artifactId = randomUUID()
        const createdAtMs = Date.now()
        const outcome = yield* worker.call({
          op: "startBackupTask",
          taskId,
          operationId: input.operationId,
          epoch: input.epoch,
          artifactId,
          destinationId: destination.destinationId,
          relativePath: backupArchiveRelativePath(artifactId),
          label: input.label,
          createdAtMs,
          destinationSelectedPath: destination.selectedPath,
          destinationCanonicalPath: destination.canonicalPath,
          destinationDevice: destination.device,
          destinationInode: destination.inode
        }).pipe(
          Effect.flatMap((value) => {
            const decoded = decodeStart(value)
            return Option.isNone(decoded)
              ? Effect.fail(new DatabaseWorkerError({ message: "invalid backup task start result" }))
              : Effect.succeed(decoded.value)
          })
        )
        if (outcome.kind === "created" || outcome.kind === "replayed") {
          return { kind: outcome.kind, task: taskView(outcome.task) } as const
        }
        return outcome
      })

      const list = () => worker.call({ op: "listBackupTasks" }).pipe(
        Effect.flatMap((value) => {
          const decoded = decodeTasks(value)
          return Option.isNone(decoded)
            ? Effect.fail(new DatabaseWorkerError({ message: "invalid backup task list" }))
            : Effect.try({
                try: () => decoded.value.map(taskView),
                catch: () => new DatabaseWorkerError({ message: "invalid persisted backup task" })
              })
        })
      )

      const run = (taskId: string) => Effect.suspend(() => {
        if (active.has(taskId)) return Effect.void
        active.add(taskId)

        const finishFailure = () => worker.call({
          op: "finishBackupTask",
          taskId,
          status: "failed",
          errorCode: "archive_failed",
          errorMessage: "backup archive could not be published",
          updatedAtMs: Date.now()
        }).pipe(Effect.asVoid, Effect.catch(() => Effect.void))

        return Effect.gen(function*() {
          const task = yield* readRow(taskId)
          if (task === null || task.status === "succeeded") return

          yield* worker.call({ op: "markBackupTaskRunning", taskId, updatedAtMs: Date.now() })
          const currentRoots: ReadonlyArray<ServerRootRow> = yield* roots.list()
          const destination: BackupDestinationRow = {
            destinationId: task.destination_id,
            name: "registered backup destination",
            selectedPath: task.destination_selected_path,
            canonicalPath: task.destination_canonical_path,
            device: task.destination_device,
            inode: task.destination_inode,
            state: "active"
          }

          yield* Effect.tryPromise({
            try: () => createBackupArchive({
              dbPath,
              destination,
              roots: currentRoots,
              label: task.label,
              artifactId: task.artifact_id,
              operationId: task.operation_id,
              createdAtMs: task.created_at_ms,
              reserve: async (request) => {
                const value = await Effect.runPromise(worker.call({ op: "reserveBackupArtifact", ...request }))
                const decoded = Schema.decodeUnknownOption(BackupArtifactReservationOutcome)(value)
                if (Option.isNone(decoded)) throw new Error("invalid backup artifact reservation result")
                return decoded.value
              },
              complete: async (request) => {
                const value = await Effect.runPromise(worker.call({ op: "completeBackupArtifact", ...request }))
                const decoded = Schema.decodeUnknownOption(BackupArtifactCompletionOutcome)(value)
                if (Option.isNone(decoded)) throw new Error("invalid backup artifact completion result")
                return decoded.value
              }
            }),
            catch: () => new Error("backup archive failed")
          })
          yield* worker.call({ op: "finishBackupTask", taskId, status: "succeeded", errorCode: null, errorMessage: null, updatedAtMs: Date.now() })
        }).pipe(
          Effect.catch(() => finishFailure()),
          Effect.ensuring(Effect.sync(() => active.delete(taskId))),
          Effect.asVoid
        )
      })

      return BackupTaskStore.of({ start, list, read, run })
    })
  )
}

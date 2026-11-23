import { Schema } from "effect"
import { Uuid } from "./ids"

export const BackupRetentionClass = Schema.Literal("archive")
export type BackupRetentionClass = typeof BackupRetentionClass.Type

export const BackupTaskStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted"
])
export type BackupTaskStatus = typeof BackupTaskStatus.Type

export const BackupTaskError = Schema.Struct({
  code: Schema.String,
  message: Schema.String
})
export type BackupTaskError = typeof BackupTaskError.Type

export const BackupRequest = Schema.Struct({
  operation_id: Uuid,
  destination_id: Uuid,
  retention_class: BackupRetentionClass,
  label: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
  /** Explicitly reject path-shaped inputs; native output is administrator-owned. */
  path: Schema.optional(Schema.Never),
  output_path: Schema.optional(Schema.Never),
  native_output_path: Schema.optional(Schema.Never)
})
export type BackupRequest = typeof BackupRequest.Type

export const BackupTask = Schema.Struct({
  task_id: Uuid,
  kind: Schema.Literal("backup"),
  mode: Schema.Literal("manual"),
  artifact_id: Uuid,
  operation_id: Uuid,
  destination_id: Uuid,
  retention_class: BackupRetentionClass,
  label: Schema.NullOr(Schema.String),
  relative_path: Schema.String,
  status: BackupTaskStatus,
  manifest_digest: Schema.NullOr(Schema.String),
  size_bytes: Schema.NullOr(Schema.Natural),
  error: Schema.NullOr(BackupTaskError),
  created_at_ms: Schema.Int,
  updated_at_ms: Schema.Int,
  completed_at_ms: Schema.NullOr(Schema.Int)
})
export type BackupTask = typeof BackupTask.Type

export const BackupTaskSubmission = Schema.Struct({
  task: BackupTask
})
export type BackupTaskSubmission = typeof BackupTaskSubmission.Type

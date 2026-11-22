import { Schema } from "effect"
import { Revision, Uuid } from "./ids"
import { ReplacementResolutionCommand, ReplacementResolutionResult } from "./library"
import { StagedDiscovery } from "./root"

export const ReleaseHoldCommand = Schema.Struct({
  type: Schema.Literal("release-hold")
})
export type ReleaseHoldCommand = typeof ReleaseHoldCommand.Type

/** A conditional review command; the server adds authenticated instance/epoch context at the transport boundary. */
export const ReviewCandidateCommandRequest = Schema.Struct({
  root_id: Uuid,
  operation_id: Uuid,
  instance_id: Uuid,
  epoch: Uuid,
  expected_candidate_version: Schema.Natural,
  expected_mapping_revision: Revision,
  expected_policy_revision: Revision,
  expected_decision_version: Schema.optional(Revision),
  expected_location_revision: Schema.optional(Revision),
  command: Schema.Union([ReleaseHoldCommand, ReplacementResolutionCommand])
})
export type ReviewCandidateCommandRequest = typeof ReviewCandidateCommandRequest.Type

export const ReviewCommandResult = Schema.Struct({
  operation_id: Uuid,
  candidate: StagedDiscovery,
  resolution: Schema.optional(ReplacementResolutionResult)
})
export type ReviewCommandResult = typeof ReviewCommandResult.Type

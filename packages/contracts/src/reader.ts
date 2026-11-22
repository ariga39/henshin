import { Schema } from "effect"
import { Revision, Uuid } from "./ids"

export const ReaderEntryFormat = Schema.Union([
  Schema.Literal("archive"),
  Schema.Literal("image-directory")
])
export type ReaderEntryFormat = typeof ReaderEntryFormat.Type

export const ReaderLaunchMode = Schema.Union([
  Schema.Literal("explicit-executable"),
  Schema.Literal("system-association")
])
export type ReaderLaunchMode = typeof ReaderLaunchMode.Type

export const ReaderTargetMode = Schema.Union([
  Schema.Literal("archive"),
  Schema.Literal("directory"),
  Schema.Literal("first-image")
])
export type ReaderTargetMode = typeof ReaderTargetMode.Type

/** Profile data safe to expose to the renderer. Native paths stay in main. */
export const ReaderProfile = Schema.Struct({
  profile_id: Uuid,
  revision: Revision,
  name: Schema.String,
  launch_mode: ReaderLaunchMode,
  supported_formats: Schema.Array(ReaderEntryFormat),
  target_mode: ReaderTargetMode,
  executable_name: Schema.NullOr(Schema.String),
  argument_tokens: Schema.Array(Schema.String)
})
export type ReaderProfile = typeof ReaderProfile.Type

export const ReaderProfileListIpcRequest = Schema.Struct({})
export type ReaderProfileListIpcRequest = typeof ReaderProfileListIpcRequest.Type

export const ReaderExecutableSelection = Schema.Struct({
  selection_handle: Uuid,
  executable_name: Schema.String
})
export type ReaderExecutableSelection = typeof ReaderExecutableSelection.Type

export const ReaderExecutableSelectionIpcResult = Schema.NullOr(ReaderExecutableSelection)
export type ReaderExecutableSelectionIpcResult = typeof ReaderExecutableSelectionIpcResult.Type

export const ReaderExecutableSelectIpcRequest = Schema.Struct({})
export type ReaderExecutableSelectIpcRequest = typeof ReaderExecutableSelectIpcRequest.Type

export const ReaderProfileSaveIpcRequest = Schema.Struct({
  profile_id: Schema.NullOr(Uuid),
  expected_revision: Revision,
  name: Schema.String,
  launch_mode: ReaderLaunchMode,
  supported_formats: Schema.Array(ReaderEntryFormat),
  target_mode: ReaderTargetMode,
  argument_tokens: Schema.Array(Schema.String),
  selection_handle: Schema.NullOr(Uuid)
})
export type ReaderProfileSaveIpcRequest = typeof ReaderProfileSaveIpcRequest.Type

import { posix, win32 } from "node:path"
import { Context, Data, Effect, Layer, Option, Schema } from "effect"
import type {
  ReaderEntryFormat,
  ReaderLaunchMode,
  ReaderProfile,
  ReaderTargetMode
} from "@henshin/contracts"
import { LocalDatabaseWorker, LocalDatabaseWorkerError } from "./LocalDatabaseWorker"
import {
  ReaderProfileReadResult,
  ReaderProfileRows,
  ReaderProfileWriteOutcome,
  type DraftWorkerRequest,
  type ReaderProfileRow
} from "./draft-worker-protocol"

export interface ReaderProfileInput {
  readonly profileId: string
  readonly expectedRevision: string
  readonly name: string
  readonly launchMode: ReaderLaunchMode
  readonly supportedFormats: ReadonlyArray<ReaderEntryFormat>
  readonly targetMode: ReaderTargetMode
  readonly executablePath: string | null
  readonly argumentTokens: ReadonlyArray<string>
}

export interface StoredReaderProfile extends ReaderProfile {
  readonly executablePath: string | null
}

export class ReaderProfileConflictError extends Data.TaggedError("ReaderProfileConflictError")<{
  readonly currentRevision: string
}> {}

export class ReaderProfileNotFoundError extends Data.TaggedError("ReaderProfileNotFoundError")<{}> {}

export class ReaderProfileStoreFullError extends Data.TaggedError("ReaderProfileStoreFullError")<{}> {}

const decodeRows = Schema.decodeUnknownOption(ReaderProfileRows)
const decodeRow = Schema.decodeUnknownOption(ReaderProfileReadResult)
const decodeWrite = Schema.decodeUnknownOption(ReaderProfileWriteOutcome)

const executableName = (executablePath: string | null): string | null => {
  if (executablePath === null) return null
  return posix.isAbsolute(executablePath) ? posix.basename(executablePath) : win32.basename(executablePath)
}

const toStored = (row: ReaderProfileRow): StoredReaderProfile => ({
  profile_id: row.profileId,
  revision: row.revision,
  name: row.name,
  launch_mode: row.launchMode,
  supported_formats: row.supportedFormats,
  target_mode: row.targetMode,
  executable_name: executableName(row.executablePath),
  argument_tokens: row.argumentTokens,
  executablePath: row.executablePath
})

export const toReaderProfileView = (profile: StoredReaderProfile): ReaderProfile => ({
  profile_id: profile.profile_id,
  revision: profile.revision,
  name: profile.name,
  launch_mode: profile.launch_mode,
  supported_formats: profile.supported_formats,
  target_mode: profile.target_mode,
  executable_name: profile.executable_name,
  argument_tokens: profile.argument_tokens
})

const toRowInput = (input: ReaderProfileInput): Omit<ReaderProfileRow, "revision"> => ({
  profileId: input.profileId,
  name: input.name,
  launchMode: input.launchMode,
  supportedFormats: input.supportedFormats,
  targetMode: input.targetMode,
  executablePath: input.executablePath,
  argumentTokens: input.argumentTokens
})

export class ReaderProfileStore extends Context.Service<
  ReaderProfileStore,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<ReaderProfile>, LocalDatabaseWorkerError>
    readonly get: (profileId: string) => Effect.Effect<StoredReaderProfile | undefined, LocalDatabaseWorkerError>
    readonly save: (
      input: ReaderProfileInput
    ) => Effect.Effect<StoredReaderProfile, LocalDatabaseWorkerError | ReaderProfileConflictError | ReaderProfileNotFoundError | ReaderProfileStoreFullError>
  }
>()("henshin/desktop/ReaderProfileStore") {
  static readonly layerFromWorker: Layer.Layer<ReaderProfileStore, never, LocalDatabaseWorker> = Layer.effect(
    ReaderProfileStore,
    Effect.gen(function*() {
      const worker = yield* LocalDatabaseWorker
      const call = (request: DraftWorkerRequest): Effect.Effect<unknown, LocalDatabaseWorkerError> =>
        worker.call(request)

      const list = (): Effect.Effect<ReadonlyArray<ReaderProfile>, LocalDatabaseWorkerError> =>
        call({ op: "listReaderProfiles" }).pipe(
          Effect.flatMap((value): Effect.Effect<ReadonlyArray<ReaderProfile>, LocalDatabaseWorkerError> => {
            const decoded = decodeRows(value)
            if (Option.isNone(decoded)) {
              return Effect.fail(new LocalDatabaseWorkerError({ message: "invalid reader profile list" }))
            }
            return Effect.succeed(decoded.value.map((row) => toReaderProfileView(toStored(row))))
          })
        )

      const get = (profileId: string): Effect.Effect<StoredReaderProfile | undefined, LocalDatabaseWorkerError> =>
        call({ op: "getReaderProfile", profileId }).pipe(
          Effect.flatMap((value): Effect.Effect<StoredReaderProfile | undefined, LocalDatabaseWorkerError> => {
            const decoded = decodeRow(value)
            if (Option.isNone(decoded)) {
              return Effect.fail(new LocalDatabaseWorkerError({ message: "invalid reader profile read" }))
            }
            return Effect.succeed(decoded.value === null ? undefined : toStored(decoded.value))
          })
        )

      const save = (
        input: ReaderProfileInput
      ): Effect.Effect<
        StoredReaderProfile,
        LocalDatabaseWorkerError | ReaderProfileConflictError | ReaderProfileNotFoundError | ReaderProfileStoreFullError
      > =>
        call({ op: "saveReaderProfile", ...toRowInput(input), expectedRevision: input.expectedRevision }).pipe(
          Effect.flatMap((value): Effect.Effect<
            StoredReaderProfile,
            LocalDatabaseWorkerError | ReaderProfileConflictError | ReaderProfileNotFoundError | ReaderProfileStoreFullError
          > => {
            const decoded = decodeWrite(value)
            if (Option.isNone(decoded)) {
              return Effect.fail(new LocalDatabaseWorkerError({ message: "invalid reader profile save result" }))
            }
            switch (decoded.value.kind) {
              case "saved":
                return Effect.succeed(toStored(decoded.value.profile))
              case "conflict":
                return Effect.fail(new ReaderProfileConflictError({ currentRevision: decoded.value.currentRevision }))
              case "not_found":
                return Effect.fail(new ReaderProfileNotFoundError())
              case "full":
                return Effect.fail(new ReaderProfileStoreFullError())
            }
          })
        )

      return ReaderProfileStore.of({ list, get, save })
    })
  )
}

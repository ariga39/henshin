import { opendir } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { Effect } from "effect"
import {
  InvalidRequest,
  RequestContext,
  RootPreviewUnavailable,
  ServerApi,
  type RootPreview
} from "@henshin/contracts"
import { HttpApiBuilder } from "effect/http-api"
import { ServerState } from "../identity"

export const ROOT_PREVIEW_SAMPLE_LIMIT = 32

const childKind = (entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): RootPreview["children"][number]["kind"] => {
  if (entry.isFile()) return "file"
  if (entry.isDirectory()) return "directory"
  if (entry.isSymbolicLink()) return "symlink"
  return "other"
}

const enumerateChildren = (selectedPath: string): Effect.Effect<RootPreview, unknown> =>
  Effect.tryPromise({
    try: async () => {
      const directory = await opendir(selectedPath)
      const children: Array<RootPreview["children"][number]> = []
      try {
        while (children.length <= ROOT_PREVIEW_SAMPLE_LIMIT) {
          const entry = await directory.read()
          if (entry === null) break
          children.push({ name: entry.name, kind: childKind(entry) })
        }
      } finally {
        await directory.close()
      }

      const truncated = children.length > ROOT_PREVIEW_SAMPLE_LIMIT
      if (truncated) children.pop()
      const outcome: RootPreview["outcome"] = children.length === 0 ? "empty" : truncated ? "truncated" : "selected"

      return {
        selected_server_path: selectedPath,
        outcome,
        children,
        sample_limit: ROOT_PREVIEW_SAMPLE_LIMIT
      }
    },
    catch: (error) => error
  })

export const RootPreviewHandlers = HttpApiBuilder.group(ServerApi, "roots", (handlers) =>
  Effect.gen(function*() {
    const server = yield* ServerState

    return handlers.handle("preview", ({ payload }) =>
      Effect.gen(function*() {
        const context = yield* RequestContext
        const base = {
          request_id: context.request_id,
          instance_id: server.instanceId,
          epoch: server.epoch
        }

        if (!isAbsolute(payload.path)) {
          return yield* new InvalidRequest({
            code: "invalid_request",
            message: "path must be an absolute directory path",
            retryable: false,
            details: { field: "path" },
            ...base
          })
        }

        const preview = yield* enumerateChildren(payload.path).pipe(
          Effect.mapError(
            () =>
              new RootPreviewUnavailable({
                code: "root_preview_inaccessible",
                message: "selected directory is unavailable or inaccessible",
                retryable: true,
                ...base
              })
          )
        )

        return {
          instance_id: server.instanceId,
          epoch: server.epoch,
          request_id: context.request_id,
          server_time: Date.now(),
          data: preview
        }
      })
    )
  })
)

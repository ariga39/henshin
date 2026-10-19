import { Schema } from "effect"

/**
 * Success envelope shared by every prototype HTTP response.
 *
 * Mirrors the first-release envelope from docs/design/api-and-tasks.md:
 * `instance_id`, `epoch`, `request_id`, `server_time`, and the operation `data`.
 */
export const SuccessEnvelope = <S extends Schema.Top>(data: S) =>
  Schema.Struct({
    instance_id: Schema.String,
    epoch: Schema.String,
    request_id: Schema.String,
    server_time: Schema.Number,
    data
  })

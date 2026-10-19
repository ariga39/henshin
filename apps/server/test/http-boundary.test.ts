import { randomUUID } from "node:crypto"
import http from "node:http"
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { PrototypeHttpClient } from "@henshin/contracts"
import { makeTempDbPath, startServer, type RunningServer } from "./support/server-process"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const servers: RunningServer[] = []

const start = async (dbPath?: string): Promise<RunningServer> => {
  const server = await startServer(dbPath ?? (await makeTempDbPath()))
  servers.push(server)
  return server
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

const withClient = <A, E>(
  server: RunningServer,
  program: Effect.Effect<A, E, PrototypeHttpClient>
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      program,
      PrototypeHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken })
    )
  )

interface RawResponse {
  readonly status: number
  readonly body: string
}

/**
 * Sends a PUT with Transfer-Encoding: chunked (no Content-Length) over
 * node:http, so the chunked path is exercised for real.
 */
const chunkedPut = (server: RunningServer, payload: string): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: Number(new URL(server.baseUrl).port),
        method: "PUT",
        path: "/prototype/v1/note/note-1",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.bearerToken}`
        }
      },
      (response) => {
        let body = ""
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8")
        })
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }))
      }
    )
    request.on("error", reject)

    const chunkSize = 65_536
    let offset = 0
    const write = () => {
      while (offset < payload.length) {
        const part = payload.slice(offset, offset + chunkSize)
        offset += chunkSize
        if (!request.write(part)) {
          request.once("drain", write)
          return
        }
      }
      request.end()
    }
    write()
  })

describe("prototype HTTP boundary", () => {
  it("rejects missing and invalid bearer tokens without disclosing namespace or epoch", async () => {
    const server = await start()

    const missing = await fetch(`${server.baseUrl}/prototype/v1/handshake`)
    expect(missing.status).toBe(401)
    const missingBody = (await missing.json()) as Record<string, unknown>
    expect(missingBody.code).toBe("authentication_required")
    expect(missingBody.instance_id).toBeUndefined()
    expect(missingBody.epoch).toBeUndefined()
    expect(JSON.stringify(missingBody)).not.toContain(server.instanceId)
    expect(JSON.stringify(missingBody)).not.toContain(server.epoch)

    const invalid = await fetch(`${server.baseUrl}/prototype/v1/handshake`, {
      headers: { authorization: "Bearer not-the-token" }
    })
    expect(invalid.status).toBe(401)
    expect(((await invalid.json()) as Record<string, unknown>).code).toBe("authentication_required")
  })

  it("commits a conditional edit and reads it back with a full envelope", async () => {
    const server = await start()

    const result = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const handshake = yield* client.handshake()
        const edited = yield* client.editNote({
          params: { id: "note-1" },
          payload: {
            operation_id: randomUUID(),
            expected_revision: "0",
            text: "first",
            instance_id: handshake.instance_id,
            epoch: handshake.epoch
          }
        })
        const read = yield* client.getNote({ params: { id: "note-1" } })
        return { handshake, edited, read }
      })
    )

    expect(result.edited.instance_id).toBe(result.handshake.instance_id)
    expect(result.edited.epoch).toBe(result.handshake.epoch)
    expect(result.edited.request_id).toMatch(UUID_PATTERN)
    expect(result.edited.server_time).toBeGreaterThan(0)
    expect(result.edited.data).toEqual({ note_id: "note-1", text: "first", revision: "1" })
    expect(result.read.data).toEqual({ note_id: "note-1", text: "first", revision: "1" })
  })

  it("returns a tagged revision conflict and does not write", async () => {
    const server = await start()

    const result = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const handshake = yield* client.handshake()
        const base = {
          operation_id: randomUUID(),
          expected_revision: "0",
          instance_id: handshake.instance_id,
          epoch: handshake.epoch
        }
        yield* client.editNote({ params: { id: "note-1" }, payload: { ...base, text: "first" } })
        const conflict = yield* client
          .editNote({
            params: { id: "note-1" },
            payload: { ...base, operation_id: randomUUID(), text: "second" }
          })
          .pipe(Effect.flip)
        const read = yield* client.getNote({ params: { id: "note-1" } })
        return { conflict, read }
      })
    )

    expect(result.conflict._tag).toBe("RevisionConflict")
    if (result.conflict._tag === "RevisionConflict") {
      expect(result.conflict.details.current_revision).toBe("1")
      expect(result.conflict.retryable).toBe(false)
    }
    // The conflict must not have written the rejected text.
    expect(result.read.data).toEqual({ note_id: "note-1", text: "first", revision: "1" })
  })

  it("rejects a stale epoch before applying the write", async () => {
    const server = await start()

    const result = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const handshake = yield* client.handshake()
        const error = yield* client
          .editNote({
            params: { id: "note-1" },
            payload: {
              operation_id: randomUUID(),
              expected_revision: "0",
              text: "nope",
              instance_id: handshake.instance_id,
              epoch: randomUUID()
            }
          })
          .pipe(Effect.flip)
        const read = yield* client.getNote({ params: { id: "note-1" } })
        return { error, read }
      })
    )

    expect(result.error._tag).toBe("EpochChanged")
    expect(result.read.data).toEqual({ note_id: "note-1", text: "hello", revision: "0" })
  })

  it("replays an identical retry and conflicts on a changed payload under one operation id", async () => {
    const server = await start()

    const result = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const handshake = yield* client.handshake()
        const operationId = randomUUID()
        const base = {
          operation_id: operationId,
          expected_revision: "0",
          instance_id: handshake.instance_id,
          epoch: handshake.epoch
        }
        const first = yield* client.editNote({
          params: { id: "note-1" },
          payload: { ...base, text: "same" }
        })
        // Same operation id and identical payload, but a now-stale revision: the
        // stored result must be returned before preconditions are re-evaluated.
        const replay = yield* client.editNote({
          params: { id: "note-1" },
          payload: { ...base, text: "same" }
        })
        const conflict = yield* client
          .editNote({ params: { id: "note-1" }, payload: { ...base, text: "different" } })
          .pipe(Effect.flip)
        return { first, replay, conflict }
      })
    )

    expect(result.first.data).toEqual({ note_id: "note-1", text: "same", revision: "1" })
    expect(result.replay.data).toEqual({ note_id: "note-1", text: "same", revision: "1" })
    expect(result.conflict._tag).toBe("OperationConflict")
  })

  it("rejects a non-canonical or out-of-range revision and over-long text at the boundary", async () => {
    const server = await start()
    const url = `${server.baseUrl}/prototype/v1/note/note-1`
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${server.bearerToken}`
    }
    const base = {
      operation_id: randomUUID(),
      text: "x",
      instance_id: server.instanceId,
      epoch: server.epoch
    }

    const outOfRange = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...base, expected_revision: "9223372036854775808" })
    })
    expect(outOfRange.status).toBe(400)

    const nonCanonical = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...base, expected_revision: "01" })
    })
    expect(nonCanonical.status).toBe(400)

    const overLongText = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...base, expected_revision: "0", text: "a".repeat(1025) })
    })
    expect(overLongText.status).toBe(400)
  })

  it("enforces the 1 MiB JSON ceiling for declared and chunked bodies", async () => {
    const server = await start()
    const url = `${server.baseUrl}/prototype/v1/note/note-1`
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${server.bearerToken}`
    }
    const base = {
      operation_id: randomUUID(),
      expected_revision: "0",
      text: "x",
      instance_id: server.instanceId,
      epoch: server.epoch
    }
    // Excess fields are ignored by the schema, so without a parse-time ceiling
    // these requests would succeed.
    const overLimit = JSON.stringify({ ...base, padding: "a".repeat(1024 * 1024) })

    const declared = await fetch(url, { method: "PUT", headers, body: overLimit })
    expect(declared.status).toBe(413)

    const chunked = await chunkedPut(server, overLimit)
    expect(chunked.status).toBe(413)

    // A within-limit chunked body is still accepted, proving the ceiling is a
    // size bound rather than a blanket rejection of chunked encoding.
    const accepted = await chunkedPut(server, JSON.stringify({ ...base, text: "chunked-ok" }))
    expect(accepted.status).toBe(200)

    const read = await fetch(url, { headers: { authorization: `Bearer ${server.bearerToken}` } })
    expect(read.status).toBe(200)
    expect(((await read.json()) as { data: unknown }).data).toEqual({
      note_id: "note-1",
      text: "chunked-ok",
      revision: "1"
    })
  })

  it("accepts a maximum-length text of JSON-escaped control characters", async () => {
    const server = await start()
    const text = "\u0001".repeat(1024)

    const result = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const handshake = yield* client.handshake()
        const edited = yield* client.editNote({
          params: { id: "note-1" },
          payload: {
            operation_id: randomUUID(),
            expected_revision: "0",
            text,
            instance_id: handshake.instance_id,
            epoch: handshake.epoch
          }
        })
        const read = yield* client.getNote({ params: { id: "note-1" } })
        return { edited, read }
      })
    )

    expect(result.edited.data.revision).toBe("1")
    expect(result.read.data.text).toBe(text)
  })

  it("round-trips an embedded NUL on the pinned node:sqlite runtime", async () => {
    const server = await start()
    const text = "\u0000".repeat(1024)

    const result = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const handshake = yield* client.handshake()
        const edited = yield* client.editNote({
          params: { id: "note-1" },
          payload: {
            operation_id: randomUUID(),
            expected_revision: "0",
            text,
            instance_id: handshake.instance_id,
            epoch: handshake.epoch
          }
        })
        const read = yield* client.getNote({ params: { id: "note-1" } })
        return { edited, read }
      })
    )

    expect(result.edited.data.revision).toBe("1")
    expect(result.read.data.text).toBe(text)
  })

  it("rejects a malformed chunked JSON body with a 400 and no write", async () => {
    const server = await start()
    const response = await chunkedPut(server, "{not-json")
    expect(response.status).toBe(400)

    const read = await fetch(`${server.baseUrl}/prototype/v1/note/note-1`, {
      headers: { authorization: `Bearer ${server.bearerToken}` }
    })
    expect(((await read.json()) as { data: unknown }).data).toEqual({
      note_id: "note-1",
      text: "hello",
      revision: "0"
    })
  })

  it("increments, reads, and conflicts exactly above Number.MAX_SAFE_INTEGER", async () => {
    const dbPath = await makeTempDbPath()
    const seed = new DatabaseSync(dbPath)
    try {
      seed.exec("PRAGMA journal_mode = WAL")
      seed.exec(
        "CREATE TABLE IF NOT EXISTS prototype_note (note_id TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL)"
      )
      seed
        .prepare("INSERT OR REPLACE INTO prototype_note(note_id, text, revision) VALUES(?, ?, ?)")
        .run("note-1", "big", BigInt("9007199254740992"))
    } finally {
      seed.close()
    }

    const server = await start(dbPath)
    const result = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const handshake = yield* client.handshake()
        const before = yield* client.getNote({ params: { id: "note-1" } })
        const committed = yield* client.editNote({
          params: { id: "note-1" },
          payload: {
            operation_id: randomUUID(),
            expected_revision: "9007199254740992",
            text: "bigger",
            instance_id: handshake.instance_id,
            epoch: handshake.epoch
          }
        })
        const conflict = yield* client
          .editNote({
            params: { id: "note-1" },
            payload: {
              operation_id: randomUUID(),
              expected_revision: "9007199254740992",
              text: "stale",
              instance_id: handshake.instance_id,
              epoch: handshake.epoch
            }
          })
          .pipe(Effect.flip)
        const after = yield* client.getNote({ params: { id: "note-1" } })
        return { before, committed, conflict, after }
      })
    )

    expect(result.before.data.revision).toBe("9007199254740992")
    expect(result.committed.data.revision).toBe("9007199254740993")
    expect(result.after.data.revision).toBe("9007199254740993")
    expect(result.conflict._tag).toBe("RevisionConflict")
    if (result.conflict._tag === "RevisionConflict") {
      expect(result.conflict.details.current_revision).toBe("9007199254740993")
    }
  })

  it("persists committed state across restart and issues a fresh epoch for the same instance", async () => {
    const dbPath = await makeTempDbPath()

    const first = await start(dbPath)
    await withClient(
      first,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const handshake = yield* client.handshake()
        yield* client.editNote({
          params: { id: "note-1" },
          payload: {
            operation_id: randomUUID(),
            expected_revision: "0",
            text: "persisted",
            instance_id: handshake.instance_id,
            epoch: handshake.epoch
          }
        })
      })
    )
    await first.stop()

    const second = await start(dbPath)
    const result = await withClient(
      second,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const handshake = yield* client.handshake()
        const read = yield* client.getNote({ params: { id: "note-1" } })
        return { handshake, read }
      })
    )

    expect(result.read.data).toEqual({ note_id: "note-1", text: "persisted", revision: "1" })
    expect(result.handshake.instance_id).toBe(first.instanceId)
    expect(second.epoch).not.toBe(first.epoch)
  })
})

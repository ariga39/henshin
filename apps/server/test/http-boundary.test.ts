import { randomUUID } from "node:crypto"
import http from "node:http"
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { PrototypeHttpClient } from "@henshin/contracts"
import {
  cleanupTempDb,
  makeTempDbPath,
  startServer,
  type RunningServer
} from "./support/server-process"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const servers: RunningServer[] = []
const tempDbPaths = new Set<string>()

const start = async (dbPath?: string): Promise<RunningServer> => {
  const actualDbPath = dbPath ?? (await makeTempDbPath())
  tempDbPaths.add(actualDbPath)
  try {
    const server = await startServer(actualDbPath)
    servers.push(server)
    return server
  } catch (error) {
    await cleanupTempDb(actualDbPath)
    tempDbPaths.delete(actualDbPath)
    throw error
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of tempDbPaths) await cleanupTempDb(dbPath)
  tempDbPaths.clear()
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

/**
 * Drops the response stream as soon as the real server emits response
 * headers. Headers are emitted only after the worker transaction commits, so
 * this models a reply lost after upstream commit without a test-only server
 * branch.
 */
const dropPutResponse = (server: RunningServer, payload: string): Promise<void> =>
  new Promise((resolve, reject) => {
    let responseStarted = false
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
        responseStarted = true
        if ((response.statusCode ?? 0) !== 200) {
          response.resume()
          reject(new Error(`expected committed edit response, got HTTP ${response.statusCode ?? 0}`))
          return
        }
        response.destroy()
        resolve()
      }
    )
    request.on("error", (error) => {
      if (responseStarted) resolve()
      else reject(error)
    })
    request.end(payload)
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

    const status = await fetch(
      `${server.baseUrl}/prototype/v1/operations/${randomUUID()}?instance_id=${server.instanceId}&epoch=${server.epoch}`
    )
    expect(status.status).toBe(401)
    const statusBody = (await status.json()) as Record<string, unknown>
    expect(statusBody.instance_id).toBeUndefined()
    expect(statusBody.epoch).toBeUndefined()
    expect(JSON.stringify(statusBody)).not.toContain(server.instanceId)
    expect(JSON.stringify(statusBody)).not.toContain(server.epoch)

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
    expect(result.edited.data.note).toEqual({ note_id: "note-1", text: "first", revision: "1" })
    expect(result.edited.data.operation_id).toBeDefined()
    expect(result.edited.data.expires_at_ms).toBeGreaterThan(Date.now())
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

    expect(result.first.data).toEqual(result.replay.data)
    expect(result.first.data.note).toEqual({ note_id: "note-1", text: "same", revision: "1" })
    expect(result.conflict._tag).toBe("OperationConflict")
  })

  it("recovers an exactly committed result after the real reply transport is dropped", async () => {
    const server = await start()
    const operationId = randomUUID()
    const handshake = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        return yield* client.handshake()
      })
    )

    await dropPutResponse(
      server,
      JSON.stringify({
        operation_id: operationId,
        expected_revision: "0",
        text: "lost-reply",
        instance_id: handshake.instance_id,
        epoch: handshake.epoch
      })
    )

    const result = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const recovered = yield* client.getOperation({
          params: { id: operationId },
          query: { instance_id: handshake.instance_id, epoch: handshake.epoch }
        })
        const later = yield* client.editNote({
          params: { id: "note-1" },
          payload: {
            operation_id: randomUUID(),
            expected_revision: "1",
            text: "later",
            instance_id: handshake.instance_id,
            epoch: handshake.epoch
          }
        })
        const original = yield* client.getOperation({
          params: { id: operationId },
          query: { instance_id: handshake.instance_id, epoch: handshake.epoch }
        })
        return { recovered, later, original }
      })
    )

    expect(result.recovered.data).toEqual(result.original.data)
    expect(result.recovered.data.note).toEqual({
      note_id: "note-1",
      text: "lost-reply",
      revision: "1"
    })
    expect(result.recovered.data.expires_at_ms).toBeGreaterThan(Date.now())
    expect(result.later.data.note).toEqual({ note_id: "note-1", text: "later", revision: "2" })
  })

  it("requires the current namespace and epoch for operation status without mutating", async () => {
    const server = await start()
    const result = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const handshake = yield* client.handshake()
        const committed = yield* client.editNote({
          params: { id: "note-1" },
          payload: {
            operation_id: randomUUID(),
            expected_revision: "0",
            text: "status-check",
            instance_id: handshake.instance_id,
            epoch: handshake.epoch
          }
        })
        const unknown = yield* client
          .getOperation({
            params: { id: randomUUID() },
            query: { instance_id: handshake.instance_id, epoch: handshake.epoch }
          })
          .pipe(Effect.flip)
        const wrongEpoch = yield* client
          .getOperation({
            params: { id: committed.data.operation_id },
            query: { instance_id: handshake.instance_id, epoch: randomUUID() }
          })
          .pipe(Effect.flip)
        const wrongInstance = yield* client
          .getOperation({
            params: { id: committed.data.operation_id },
            query: { instance_id: randomUUID(), epoch: handshake.epoch }
          })
          .pipe(Effect.flip)
        const read = yield* client.getNote({ params: { id: "note-1" } })
        return { committed, unknown, wrongEpoch, wrongInstance, read }
      })
    )

    expect(result.unknown._tag).toBe("OperationExpired")
    expect(result.wrongEpoch._tag).toBe("EpochChanged")
    expect(result.wrongInstance._tag).toBe("InstanceMismatch")
    expect(result.read.data).toEqual({ note_id: "note-1", text: "status-check", revision: "1" })
  })

  it("returns operation_expired for an expired row without compacting during lookup", async () => {
    const server = await start()
    const committed = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const handshake = yield* client.handshake()
        const result = yield* client.editNote({
          params: { id: "note-1" },
          payload: {
            operation_id: randomUUID(),
            expected_revision: "0",
            text: "will-expire",
            instance_id: handshake.instance_id,
            epoch: handshake.epoch
          }
        })
        return { handshake, result }
      })
    )

    const database = new DatabaseSync(server.dbPath)
    try {
      database
        .prepare("UPDATE operation_results SET created_at_ms = 0 WHERE epoch = ? AND operation_id = ?")
        .run(committed.handshake.epoch, committed.result.data.operation_id)
    } finally {
      database.close()
    }

    const outcome = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const error = yield* client
          .getOperation({
            params: { id: committed.result.data.operation_id },
            query: {
              instance_id: committed.handshake.instance_id,
              epoch: committed.handshake.epoch
            }
          })
          .pipe(Effect.flip)
        const replay = yield* client
          .editNote({
            params: { id: "note-1" },
            payload: {
              operation_id: committed.result.data.operation_id,
              expected_revision: "0",
              text: "will-expire",
              instance_id: committed.handshake.instance_id,
              epoch: committed.handshake.epoch
            }
          })
          .pipe(Effect.flip)
        const read = yield* client.getNote({ params: { id: "note-1" } })
        return { error, replay, read }
      })
    )

    const check = new DatabaseSync(server.dbPath)
    try {
      const row = check
        .prepare("SELECT COUNT(*) AS count FROM operation_results WHERE operation_id = ?")
        .get(committed.result.data.operation_id) as { count: number }
      expect(row.count).toBe(1)
    } finally {
      check.close()
    }
    expect(outcome.error._tag).toBe("OperationExpired")
    expect(outcome.replay._tag).toBe("OperationExpired")
    expect(outcome.read.data).toEqual({ note_id: "note-1", text: "will-expire", revision: "1" })
  })

  it("fills the shipped 64-row cap, preserves replay at capacity, and compacts before admission", async () => {
    const server = await start()
    const result = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const handshake = yield* client.handshake()
        const firstOperationId = randomUUID()
        const first = yield* client.editNote({
          params: { id: "note-1" },
          payload: {
            operation_id: firstOperationId,
            expected_revision: "0",
            text: "row-1",
            instance_id: handshake.instance_id,
            epoch: handshake.epoch
          }
        })
        for (let revision = 1; revision < 64; revision += 1) {
          yield* client.editNote({
            params: { id: "note-1" },
            payload: {
              operation_id: randomUUID(),
              expected_revision: String(revision),
              text: `row-${revision + 1}`,
              instance_id: handshake.instance_id,
              epoch: handshake.epoch
            }
          })
        }
        const full = yield* client
          .editNote({
            params: { id: "note-1" },
            payload: {
              operation_id: randomUUID(),
              expected_revision: "64",
              text: "rejected",
              instance_id: handshake.instance_id,
              epoch: handshake.epoch
            }
          })
          .pipe(Effect.flip)
        const replay = yield* client.editNote({
          params: { id: "note-1" },
          payload: {
            operation_id: firstOperationId,
            expected_revision: "0",
            text: "row-1",
            instance_id: handshake.instance_id,
            epoch: handshake.epoch
          }
        })
        const beforeCompaction = yield* client.getNote({ params: { id: "note-1" } })

        const database = new DatabaseSync(server.dbPath)
        try {
          database
            .prepare(
              "UPDATE operation_results SET created_at_ms = 0 WHERE epoch = ? AND operation_id = ?"
            )
            .run(handshake.epoch, firstOperationId)
        } finally {
          database.close()
        }

        const compacted = yield* client.editNote({
          params: { id: "note-1" },
          payload: {
            operation_id: randomUUID(),
            expected_revision: "64",
            text: "row-65",
            instance_id: handshake.instance_id,
            epoch: handshake.epoch
          }
        })
        return { first, full, replay, beforeCompaction, compacted }
      })
    )

    expect(result.full._tag).toBe("StorageFull")
    expect(result.replay.data).toEqual(result.first.data)
    expect(result.beforeCompaction.data).toEqual({
      note_id: "note-1",
      text: "row-64",
      revision: "64"
    })
    expect(result.compacted.data.note).toEqual({
      note_id: "note-1",
      text: "row-65",
      revision: "65"
    })
  })

  it("makes bounded progress through 130 obsolete rows without evicting a live result", async () => {
    const server = await start()
    const result = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const handshake = yield* client.handshake()
        const live = yield* client.editNote({
          params: { id: "note-1" },
          payload: {
            operation_id: randomUUID(),
            expected_revision: "0",
            text: "live-result",
            instance_id: handshake.instance_id,
            epoch: handshake.epoch
          }
        })

        const database = new DatabaseSync(server.dbPath)
        const legacyEpoch = randomUUID()
        const insert = database.prepare(
          "INSERT INTO operation_results(epoch, operation_id, payload, result, created_at_ms) VALUES(?, ?, ?, ?, ?)"
        )
        try {
          for (let index = 0; index < 130; index += 1) {
            insert.run(
              legacyEpoch,
              randomUUID(),
              JSON.stringify({
                expected_revision: "0",
                note_id: "note-1",
                text: `legacy-${index}`
              }),
              JSON.stringify({
                note_id: "note-1",
                text: `legacy-${index}`,
                revision: "1"
              }),
              Date.now()
            )
          }
        } finally {
          database.close()
        }

        const admissionOperationId = randomUUID()
        const rejected = yield* client
          .editNote({
            params: { id: "note-1" },
            payload: {
              operation_id: admissionOperationId,
              expected_revision: "1",
              text: "admitted-after-cleanup",
              instance_id: handshake.instance_id,
              epoch: handshake.epoch
            }
          })
          .pipe(Effect.flip)

        const afterFirstCleanup = new DatabaseSync(server.dbPath)
        let remainingRows: number
        try {
          remainingRows = (
            afterFirstCleanup.prepare("SELECT COUNT(*) AS count FROM operation_results").get() as {
              count: number
            }
          ).count
        } finally {
          afterFirstCleanup.close()
        }

        const liveReplay = yield* client.editNote({
          params: { id: "note-1" },
          payload: {
            operation_id: live.data.operation_id,
            expected_revision: "0",
            text: "live-result",
            instance_id: handshake.instance_id,
            epoch: handshake.epoch
          }
        })
        const admitted = yield* client.editNote({
          params: { id: "note-1" },
          payload: {
            operation_id: admissionOperationId,
            expected_revision: "1",
            text: "admitted-after-cleanup",
            instance_id: handshake.instance_id,
            epoch: handshake.epoch
          }
        })
        const liveStatus = yield* client.getOperation({
          params: { id: live.data.operation_id },
          query: { instance_id: handshake.instance_id, epoch: handshake.epoch }
        })
        return { live, rejected, remainingRows, liveReplay, admitted, liveStatus }
      })
    )

    expect(result.rejected._tag).toBe("StorageFull")
    expect(result.remainingRows).toBe(67)
    expect(result.liveReplay.data).toEqual(result.live.data)
    expect(result.liveStatus.data).toEqual(result.live.data)
    expect(result.admitted.data.note).toEqual({
      note_id: "note-1",
      text: "admitted-after-cleanup",
      revision: "2"
    })
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

    expect(result.edited.data.note.revision).toBe("1")
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

    expect(result.edited.data.note.revision).toBe("1")
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
    expect(result.committed.data.note.revision).toBe("9007199254740993")
    expect(result.after.data.revision).toBe("9007199254740993")
    expect(result.conflict._tag).toBe("RevisionConflict")
    if (result.conflict._tag === "RevisionConflict") {
      expect(result.conflict.details.current_revision).toBe("9007199254740993")
    }
  })

  it("persists committed state across restart and issues a fresh epoch for the same instance", async () => {
    const dbPath = await makeTempDbPath()
    const operationId = randomUUID()

    const first = await start(dbPath)
    const firstResult = await withClient(
      first,
      Effect.gen(function*() {
        const client = yield* PrototypeHttpClient
        const handshake = yield* client.handshake()
        yield* client.editNote({
          params: { id: "note-1" },
          payload: {
            operation_id: operationId,
            expected_revision: "0",
            text: "persisted",
            instance_id: handshake.instance_id,
            epoch: handshake.epoch
          }
        })
        return handshake
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
        const oldEpoch = yield* client
          .getOperation({
            params: { id: operationId },
            query: { instance_id: firstResult.instance_id, epoch: firstResult.epoch }
          })
          .pipe(Effect.flip)
        return { handshake, read, oldEpoch }
      })
    )

    expect(result.read.data).toEqual({ note_id: "note-1", text: "persisted", revision: "1" })
    expect(result.handshake.instance_id).toBe(first.instanceId)
    expect(second.epoch).not.toBe(first.epoch)
    expect(result.oldEpoch._tag).toBe("EpochChanged")
  })
})

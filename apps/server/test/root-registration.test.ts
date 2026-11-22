import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { ServerHttpClient } from "@henshin/contracts"
import { cleanupTempDb, makeTempDbPath, startServer, type RunningServer } from "./support/server-process"

const servers: RunningServer[] = []
const dbPaths = new Set<string>()
const fixturePaths = new Set<string>()

const start = async (): Promise<RunningServer> => {
  const dbPath = await makeTempDbPath()
  dbPaths.add(dbPath)
  const server = await startServer(dbPath)
  servers.push(server)
  return server
}

const withClient = <A, E>(server: RunningServer, program: Effect.Effect<A, E, ServerHttpClient>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(program, ServerHttpClient.layer({ baseUrl: server.baseUrl, bearerToken: server.bearerToken }))
  )

const preview = async (server: RunningServer, selectedPath: string) =>
  withClient(
    server,
    Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.preview({ payload: { path: selectedPath } })
    })
  )

const postRoot = (server: RunningServer, payload: unknown): Promise<Response> =>
  fetch(`${server.baseUrl}/api/v1/roots`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${server.bearerToken}`
    },
    body: JSON.stringify(payload)
  })

const listRoots = async (server: RunningServer) =>
  withClient(
    server,
    Effect.gen(function*() {
      const client = yield* ServerHttpClient
      return yield* client.list()
    })
  )

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dbPath of dbPaths) await cleanupTempDb(dbPath)
  dbPaths.clear()
  for (const fixturePath of fixturePaths) await rm(fixturePath, { recursive: true, force: true })
  fixturePaths.clear()
})

describe("server root registration", () => {
  it("durably registers a labeled root, lists it after restart, and safely replays it", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-root-registration-"))
    fixturePaths.add(fixture)
    const observed = await preview(server, fixture)
    const payload = {
      operation_id: randomUUID(),
      instance_id: observed.data.instance_id,
      epoch: observed.data.epoch,
      label: "Books",
      path: fixture,
      preview_identity: observed.data.preview_identity
    }

    const saved = await withClient(
      server,
      Effect.gen(function*() {
        const client = yield* ServerHttpClient
        return yield* client.save({ payload })
      })
    )
    expect(saved.data.label).toBe("Books")
    expect(saved.data.library_id).toMatch(/[0-9a-f-]{36}/i)

    await rm(fixture, { recursive: true, force: true })
    const replay = await postRoot(server, payload)
    expect(replay.status).toBe(200)
    expect((await replay.json() as { data: typeof saved.data }).data).toEqual(saved.data)

    await server.stop()
    const restarted = await startServer(server.dbPath)
    servers.push(restarted)
    expect(restarted.instanceId).toBe(server.instanceId)
    expect(restarted.epoch).not.toBe(server.epoch)
    const listed = await listRoots(restarted)
    expect(listed.data).toEqual([saved.data])
  })

  it("rejects stale preview identity and leaves no active root", async () => {
    const server = await start()
    const parent = await mkdtemp(path.join(os.tmpdir(), "henshin-root-stale-"))
    fixturePaths.add(parent)
    const fixture = path.join(parent, "collection")
    await mkdir(fixture)
    const observed = await preview(server, fixture)
    await rm(fixture, { recursive: true, force: true })
    await mkdir(fixture)

    const response = await postRoot(server, {
      operation_id: randomUUID(),
      instance_id: observed.data.instance_id,
      epoch: observed.data.epoch,
      label: "Stale",
      path: fixture,
      preview_identity: observed.data.preview_identity
    })
    expect(response.status).toBe(409)
    expect((await response.json() as { code: string }).code).toBe("root_verification_failed")
    expect((await listRoots(server)).data).toEqual([])
  })

  it("rejects source/output overlap and a new unavailable registration", async () => {
    const server = await start()
    const outputDirectory = path.dirname(server.dbPath)
    const outputPreview = await preview(server, outputDirectory)
    const outputResponse = await postRoot(server, {
      operation_id: randomUUID(),
      instance_id: outputPreview.data.instance_id,
      epoch: outputPreview.data.epoch,
      label: "Application data",
      path: outputDirectory,
      preview_identity: outputPreview.data.preview_identity
    })
    expect(outputResponse.status).toBe(409)
    expect((await outputResponse.json() as { code: string }).code).toBe("root_verification_failed")

    const unavailable = path.join(outputDirectory, "missing-collection")
    const failedPreview = await postRoot(server, {
      operation_id: randomUUID(),
      instance_id: server.instanceId,
      epoch: server.epoch,
      label: "Missing",
      path: unavailable,
      preview_identity: {
        canonical_server_path: unavailable,
        device: "0",
        inode: "0"
      }
    })
    expect(failedPreview.status).toBe(409)
    expect((await failedPreview.json() as { code: string }).code).toBe("root_verification_failed")
    expect((await listRoots(server)).data).toEqual([])
  })

  it("rejects a preview captured under an old authority epoch before replay lookup", async () => {
    const server = await start()
    const fixture = await mkdtemp(path.join(os.tmpdir(), "henshin-root-epoch-"))
    fixturePaths.add(fixture)
    const observed = await preview(server, fixture)
    await server.stop()
    const restarted = await startServer(server.dbPath)
    servers.push(restarted)

    const response = await postRoot(restarted, {
      operation_id: randomUUID(),
      instance_id: observed.data.instance_id,
      epoch: observed.data.epoch,
      label: "Old authority",
      path: fixture,
      preview_identity: observed.data.preview_identity
    })
    expect(response.status).toBe(409)
    expect((await response.json() as { code: string }).code).toBe("epoch_changed")
    expect((await listRoots(restarted)).data).toEqual([])
  })
})

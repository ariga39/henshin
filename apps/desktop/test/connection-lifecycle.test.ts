import { createServer, type Server } from "node:http"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { ConnectionInstanceMismatchError, ConnectionLifecycle } from "../src/main/ConnectionLifecycle"

const liveServers: Server[] = []

afterEach(async () => {
  await Promise.all(liveServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe("ConnectionLifecycle namespace fencing", () => {
  it("blocks a reconnect after the handshake changes instance", async () => {
    const firstInstance = randomUUID()
    const secondInstance = randomUUID()
    let instanceId = firstInstance
    const epoch = randomUUID()
    const server = createServer((request, response) => {
      if (request.url !== "/prototype/v1/handshake") {
        response.writeHead(404).end()
        return
      }
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({
        instance_id: instanceId,
        epoch,
        request_id: randomUUID(),
        server_time: Date.now(),
        data: { api_version: "prototype/1", capabilities: ["prototype-note-edit"] }
      }))
    })
    liveServers.push(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("test server did not bind a port")

    const lifecycle = new ConnectionLifecycle({
      baseUrl: `http://127.0.0.1:${address.port}`,
      bearerToken: "test-token"
    })
    await expect(lifecycle.connect()).resolves.toMatchObject({ state: "connected", instance_id: firstInstance })
    await lifecycle.disconnect()
    instanceId = secondInstance

    await expect(lifecycle.connect()).rejects.toBeInstanceOf(ConnectionInstanceMismatchError)
    expect(lifecycle.getStatus()).toMatchObject({
      state: "blocked",
      instance_id: firstInstance,
      reason: "instance_mismatch"
    })
    await lifecycle.close()
  })
})

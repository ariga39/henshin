import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { createServer, request as httpRequest } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import electronPath from "electron"

const APP_DIR = fileURLToPath(new URL("..", import.meta.url))
const SERVER_PATH = process.env.HENSHIN_INDEPENDENT_SERVER_PATH ?? path.join(APP_DIR, "..", "server", "dist", "server.mjs")
const launchedApps: ElectronApplication[] = []
const children: ChildProcess[] = []
const temporaryRoots: string[] = []
const execFileAsync = promisify(execFile)

test.skip(!existsSync(SERVER_PATH), `requires the built independent service at ${SERVER_PATH}`)

interface RunningServer {
  readonly child: ChildProcessWithoutNullStreams
  readonly baseUrl: string
  readonly token: string
  readonly instanceId: string
  readonly epoch: string
}

const freePort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("fixture did not bind a port")
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  return port
}

const waitForExit = (child: ChildProcess, timeoutMs = 5_000): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture process did not exit")), timeoutMs)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

const launchServer = (args: ReadonlyArray<string>) => {
  const child = spawn(process.execPath, [SERVER_PATH!, ...args], {
    stdio: ["pipe", "pipe", "pipe"]
  })
  children.push(child)
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8") })
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8") })
  return { child, stdout: () => stdout, stderr: () => stderr }
}

const initializeOwner = async (selection: ReadonlyArray<string>): Promise<string> => {
  const attempt = launchServer([...selection, "--initialize-owner"])
  await waitForExit(attempt.child)
  const token = /^owner_token=([^\n]+)$/mu.exec(attempt.stdout())?.[1]
  if (token === undefined) throw new Error(`fixture owner initialization failed: ${attempt.stderr()}`)
  return token
}

const startServer = async (selection: ReadonlyArray<string>, token: string): Promise<RunningServer> => {
  const port = await freePort()
  const attempt = launchServer([...selection, "--port", String(port)])
  const ready = await new Promise<{ readonly instance_id: string; readonly epoch: string }>((resolve, reject) => {
    let buffer = ""
    const timer = setTimeout(() => reject(new Error(`fixture readiness timed out: ${attempt.stderr()}`)), 5_000)
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        try {
          const value = JSON.parse(line) as { event?: string; instance_id?: string; epoch?: string }
          if (value.event === "ready" && value.instance_id !== undefined && value.epoch !== undefined) {
            clearTimeout(timer)
            attempt.child.stdout.off("data", onData)
            resolve({ instance_id: value.instance_id, epoch: value.epoch })
            return
          }
        } catch {
          // Ignore non-JSON diagnostics.
        }
        newline = buffer.indexOf("\n")
      }
    }
    attempt.child.stdout.on("data", onData)
    attempt.child.once("exit", () => reject(new Error(`fixture exited: ${attempt.stderr()}`)))
  })
  return {
    child: attempt.child,
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    instanceId: ready.instance_id,
    epoch: ready.epoch
  }
}

const api = async <T>(baseUrl: string, token: string, pathname: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) }
  })
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}: ${await response.text()}`)
  const body = await response.json() as { data: T }
  return body.data
}

interface FixtureScanTask {
  readonly status: string
  readonly error: { readonly code: string; readonly message: string } | null
  readonly readiness_error: { readonly code: string; readonly message: string } | null
}

const seedLibrary = async (server: RunningServer, fixturePath: string): Promise<void> => {
  const preview = await api<{
    readonly selected_server_path: string
    readonly instance_id: string
    readonly epoch: string
    readonly preview_identity: { readonly canonical_server_path: string; readonly device: string; readonly inode: string }
  }>(server.baseUrl, server.token, "/api/v1/roots/preview", {
    method: "POST",
    body: JSON.stringify({ path: fixturePath })
  })
  const root = await api<{ readonly root_id: string; readonly mapping_revision: string; readonly policy_revision: string }>(
    server.baseUrl,
    server.token,
    "/api/v1/roots",
    {
      method: "POST",
      body: JSON.stringify({
        operation_id: crypto.randomUUID(),
        instance_id: server.instanceId,
        epoch: server.epoch,
        label: "Remote fixture library",
        path: preview.selected_server_path,
        preview_identity: preview.preview_identity
      })
    }
  )
  const task = await api<{ readonly task: { readonly task_id: string } }>(server.baseUrl, server.token, `/api/v1/roots/${root.root_id}/commands`, {
    method: "POST",
    body: JSON.stringify({
      operation_id: crypto.randomUUID(),
      instance_id: server.instanceId,
      epoch: server.epoch,
      expected_mapping_revision: root.mapping_revision,
      expected_policy_revision: root.policy_revision,
      command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
    })
  })
  let last: FixtureScanTask | null = null
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const current = await api<FixtureScanTask>(server.baseUrl, server.token, `/api/v1/tasks/${task.task.task_id}`)
    last = current
    if (current.status === "queued" || current.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 100))
      continue
    }
    if (current.status === "succeeded" || current.status === "completed_with_errors") return
    throw new Error(`fixture scan reached terminal state ${current.status}: ${JSON.stringify(current.error ?? current.readiness_error)}`)
  }
  throw new Error(`fixture scan did not reach a terminal state: ${JSON.stringify(last)}`)
}

const createTlsProxy = async (certificate: string, key: string, upstream: string, redirectTo?: string) => {
  let requests = 0
  const server = createHttpsServer({ cert: await readFile(certificate), key: await readFile(key) }, (request, response) => {
    requests += 1
    if (redirectTo !== undefined) {
      response.writeHead(302, { location: `${redirectTo}${request.url ?? "/"}` })
      response.end()
      return
    }
    const target = new URL(request.url ?? "/", upstream)
    const headers = { ...request.headers }
    delete headers.host
    const forward = httpRequest({
      hostname: target.hostname,
      port: Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    forward.on("error", () => response.destroy())
    request.pipe(forward)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("TLS proxy did not bind a port")
  return {
    baseUrl: `https://localhost:${address.port}`,
    get requests() { return requests },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }
}

const createHandshakeStub = async (
  certificate: string,
  key: string,
  instanceId: string,
  epoch: string,
  apiVersion: string,
  capabilities: ReadonlyArray<string>
) => {
  let requests = 0
  const server = createHttpsServer({ cert: await readFile(certificate), key: await readFile(key) }, (request, response) => {
    requests += 1
    if (request.url !== "/prototype/v1/handshake") {
      response.writeHead(404)
      response.end()
      return
    }
    const body = JSON.stringify({
      instance_id: instanceId,
      epoch,
      request_id: crypto.randomUUID(),
      server_time: Date.now(),
      data: { api_version: apiVersion, capabilities }
    })
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
    response.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("handshake stub did not bind a port")
  return {
    baseUrl: `https://localhost:${address.port}`,
    get requests() { return requests },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }
}

const createHandshakeFailureStub = async (
  certificate: string,
  key: string,
  status: number,
  body: string
) => {
  const server = createHttpsServer({ cert: await readFile(certificate), key: await readFile(key) }, (request, response) => {
    if (request.url !== "/prototype/v1/handshake") {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
    response.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("failure stub did not bind a port")
  return {
    baseUrl: `https://localhost:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  }
}

const launchDesktop = async (dbPath: string, userDataPath: string, caPath: string | null): Promise<{ app: ElectronApplication; window: Page }> => {
  const environment = { ...process.env }
  delete environment.NODE_EXTRA_CA_CERTS
  if (caPath !== null) environment.NODE_EXTRA_CA_CERTS = caPath
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [".", `--user-data-dir=${userDataPath}`],
    cwd: APP_DIR,
    env: {
      ...environment,
      HENSHIN_PROTOTYPE_DB: dbPath,
      HENSHIN_PROTOTYPE_CLIENT_DB: `${dbPath}.client`
    }
  })
  launchedApps.push(app)
  return { app, window: await app.firstWindow() }
}

test.afterEach(async () => {
  for (const app of launchedApps.splice(0)) await app.close().catch(() => undefined)
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await waitForExit(child).catch(() => undefined)
  }
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

test("connects a normal desktop for one session, requires re-entry, and rejects redirects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "henshin-remote-connection-"))
  const serviceData = path.join(root, "service")
  const localData = path.join(root, "local")
  const userData = path.join(root, "desktop")
  const collection = path.join(root, "collection")
  const tls = path.join(root, "tls")
  temporaryRoots.push(root)
  await Promise.all([mkdir(serviceData), mkdir(localData), mkdir(userData), mkdir(collection), mkdir(tls)])
  await mkdir(path.join(collection, "remote-book"))
  await writeFile(path.join(collection, "remote-book", "001.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"))
  const keyPath = path.join(tls, "key.pem")
  const certificatePath = path.join(tls, "cert.pem")
  await execFileAsync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certificatePath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"])

  const remoteToken = await initializeOwner(["--data-dir", serviceData])
  const remote = await startServer(["--data-dir", serviceData], remoteToken)
  const proxy = await createTlsProxy(certificatePath, keyPath, remote.baseUrl)
  const redirectTarget = await createTlsProxy(certificatePath, keyPath, remote.baseUrl)
  const redirect = await createTlsProxy(certificatePath, keyPath, remote.baseUrl, redirectTarget.baseUrl)
  const incompatible = await createHandshakeStub(certificatePath, keyPath, remote.instanceId, remote.epoch, "prototype/2", ["prototype-note-edit"])
  await seedLibrary(remote, collection)

  try {
    const untrusted = await launchDesktop(path.join(localData, "untrusted.sqlite"), path.join(userData, "untrusted"), null)
    await expect(untrusted.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await untrusted.window.getByTestId("remote-base-url").fill(proxy.baseUrl)
    await untrusted.window.getByTestId("remote-bearer-token").fill(remoteToken)
    await untrusted.window.getByTestId("remote-connect").click()
    await expect(untrusted.window.getByTestId("connection-outcome")).toContainText("certificate is not trusted")
    await expect(untrusted.window.getByTestId("remote-confirmation")).toHaveCount(0)
    await untrusted.app.close()
    launchedApps.splice(launchedApps.indexOf(untrusted.app), 1)

    const first = await launchDesktop(path.join(localData, "managed.sqlite"), userData, certificatePath)
    await expect(first.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await first.window.getByTestId("remote-base-url").fill(proxy.baseUrl)
    await first.window.getByTestId("remote-bearer-token").fill("wrong-token")
    await first.window.getByTestId("remote-connect").click()
    await expect(first.window.getByTestId("connection-outcome")).toContainText("rejected the owner credential")
    await expect(first.window.getByTestId("remote-confirmation")).toHaveCount(0)
    await expect(first.window.getByTestId("connection-target")).toContainText("managed local service")

    await first.window.getByTestId("remote-base-url").fill(incompatible.baseUrl)
    await first.window.getByTestId("remote-bearer-token").fill(remoteToken)
    await first.window.getByTestId("remote-connect").click()
    await expect(first.window.getByTestId("connection-outcome")).toContainText("does not support the desktop Library API")
    await expect(first.window.getByTestId("remote-confirmation")).toHaveCount(0)
    await expect(first.window.getByTestId("connection-target")).toContainText("managed local service")

    await first.window.getByTestId("remote-base-url").fill(proxy.baseUrl)
    await first.window.getByTestId("remote-bearer-token").fill(remoteToken)
    await first.window.getByTestId("remote-connect").click()
    await expect(first.window.getByTestId("remote-confirmation")).toBeVisible()
    await expect(first.window.getByTestId("connection-target")).toContainText("managed local service")
    await expect(first.window.getByTestId("remote-confirmation")).toContainText(remote.instanceId)
    await expect(first.window.getByTestId("remote-session-only-warning")).toBeVisible()
    await first.window.getByTestId("remote-confirm").click()
    await expect(first.window.getByTestId("library-screen")).toBeVisible({ timeout: 30_000 })
    await expect(first.window.getByTestId("library-entry")).toContainText("remote-book")
    await expect(first.window.getByTestId("library-setup")).toBeVisible()

    await first.app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("new-library-window")
      if (item == null) throw new Error("New Window menu item was not installed")
      item.click?.(item, BrowserWindow.getFocusedWindow())
    })
    await expect.poll(() => first.app.windows().length).toBe(2)
    const follower = first.app.windows().find((candidate) => candidate !== first.window)
    if (follower === undefined) throw new Error("second Library window was not created")
    await expect(follower.getByRole("heading", { name: "Library" })).toBeVisible()
    await follower.getByTestId("library-setup").click()
    await expect(follower.getByTestId("connection-target")).toContainText("session only")
    await follower.getByTestId("open-library").click()
    await expect(follower.getByTestId("library-entry")).toContainText("remote-book")

    await first.window.getByTestId("library-setup").click()
    await first.window.getByTestId("connection-use-managed").click()
    await expect(first.window.getByTestId("connection-target")).toContainText("managed local service")
    await follower.getByTestId("library-setup").click()
    await expect(follower.getByTestId("connection-target")).toContainText("managed local service")
    await follower.getByTestId("open-library").click()
    await expect(follower.getByTestId("library-empty")).toBeVisible({ timeout: 30_000 })
    await expect(follower.getByText("remote-book", { exact: true })).toHaveCount(0)

    await first.window.getByTestId("remote-base-url").fill(proxy.baseUrl)
    await first.window.getByTestId("remote-bearer-token").fill(remoteToken)
    await first.window.getByTestId("remote-connect").click()
    await expect(first.window.getByTestId("remote-confirmation")).toBeVisible()
    await first.window.getByTestId("remote-confirm").click()
    await expect(first.window.getByTestId("library-entry")).toContainText("remote-book", { timeout: 30_000 })
    await follower.getByTestId("library-setup").click()
    await expect(follower.getByTestId("connection-target")).toContainText("session only")
    await follower.getByTestId("open-library").click()
    await expect(follower.getByTestId("library-entry")).toContainText("remote-book", { timeout: 30_000 })

    await first.window.getByTestId("library-setup").click()
    await follower.getByTestId("library-setup").click()
    await first.window.getByTestId("connection-disconnect").click()
    await expect(first.window.getByTestId("connection-status")).toContainText("disconnected")
    await expect(follower.getByTestId("connection-status")).toContainText("disconnected")
    await expect(first.window.getByTestId("connection-outcome")).toHaveCount(0)
    const remoteHealth = await fetch(`${remote.baseUrl}/prototype/v1/handshake`, { headers: { authorization: `Bearer ${remoteToken}` } })
    expect(remoteHealth.status).toBe(200)
    await first.window.getByTestId("connection-reconnect").click()
    await expect(first.window.getByTestId("library-screen")).toBeVisible({ timeout: 30_000 })
    await expect(follower.getByTestId("connection-status")).toContainText("connected")
    await expect(first.window.getByTestId("connection-outcome")).toHaveCount(0)
    await first.window.getByTestId("library-setup").click()
    await expect(first.window.getByTestId("connection-target")).toContainText("session only")
    await first.app.close()
    launchedApps.splice(launchedApps.indexOf(first.app), 1)

    const second = await launchDesktop(path.join(localData, "managed.sqlite"), userData, certificatePath)
    await expect(second.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()
    await expect(second.window.getByTestId("connection-target")).toContainText("managed local service")
    await second.window.getByTestId("remote-base-url").fill(proxy.baseUrl)
    await second.window.getByTestId("remote-bearer-token").fill(remoteToken)
    await second.window.getByTestId("remote-connect").click()
    await expect(second.window.getByTestId("remote-session-only-warning")).toBeVisible()
    await expect(second.window.getByTestId("remote-confirmation")).toContainText(remote.instanceId)
    await second.window.getByTestId("remote-confirm").click()
    await expect(second.window.getByTestId("library-screen")).toBeVisible({ timeout: 30_000 })
    await expect(second.window.getByTestId("library-entry")).toContainText("remote-book")

    await second.window.getByTestId("library-setup").click()
    await second.window.getByTestId("remote-base-url").fill(redirect.baseUrl)
    await second.window.getByTestId("remote-bearer-token").fill(remoteToken)
    await second.window.getByTestId("remote-connect").click()
    await expect(second.window.getByRole("alert")).toContainText("Connection issue")
    expect(redirectTarget.requests).toBe(0)
    await expect(second.window.getByTestId("connection-target")).toContainText(proxy.baseUrl)
    expect(remote.child.exitCode).toBeNull()
  } finally {
    await proxy.close().catch(() => undefined)
    await redirect.close().catch(() => undefined)
    await redirectTarget.close().catch(() => undefined)
    await incompatible.close().catch(() => undefined)
  }
})

test("shows actionable HTTP and handshake response diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "henshin-remote-diagnostics-"))
  const localData = path.join(root, "local")
  const userData = path.join(root, "desktop")
  const tls = path.join(root, "tls")
  temporaryRoots.push(root)
  await Promise.all([mkdir(localData), mkdir(userData), mkdir(tls)])
  const keyPath = path.join(tls, "key.pem")
  const certificatePath = path.join(tls, "cert.pem")
  await execFileAsync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certificatePath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"])

  const notFound = await createHandshakeFailureStub(certificatePath, keyPath, 404, "not found")
  const serverError = await createHandshakeFailureStub(certificatePath, keyPath, 503, "server unavailable")
  const malformed = await createHandshakeFailureStub(certificatePath, keyPath, 200, JSON.stringify({ data: { not_a_handshake: true } }))

  try {
    const desktop = await launchDesktop(path.join(localData, "diagnostics.sqlite"), userData, certificatePath)
    await expect(desktop.window.getByRole("heading", { name: "Collection setup" })).toBeVisible()

    await desktop.window.getByTestId("remote-base-url").fill(notFound.baseUrl)
    await desktop.window.getByTestId("remote-bearer-token").fill("fixture-token")
    await desktop.window.getByTestId("remote-connect").click()
    await expect(desktop.window.getByTestId("connection-outcome")).toContainText("HTTP 404")
    await expect(desktop.window.getByTestId("connection-outcome")).toContainText("Henshin HTTPS endpoint")

    await desktop.window.getByTestId("remote-base-url").fill(serverError.baseUrl)
    await desktop.window.getByTestId("remote-bearer-token").fill("fixture-token")
    await desktop.window.getByTestId("remote-connect").click()
    await expect(desktop.window.getByTestId("connection-outcome")).toContainText("HTTP 503")
    await expect(desktop.window.getByTestId("connection-outcome")).toContainText("server health and logs")

    await desktop.window.getByTestId("remote-base-url").fill(malformed.baseUrl)
    await desktop.window.getByTestId("remote-bearer-token").fill("fixture-token")
    await desktop.window.getByTestId("remote-connect").click()
    await expect(desktop.window.getByTestId("connection-outcome")).toContainText("invalid or incomplete handshake")
    await expect(desktop.window.getByTestId("connection-outcome")).toContainText("compatible Henshin server")
  } finally {
    await notFound.close().catch(() => undefined)
    await serverError.close().catch(() => undefined)
    await malformed.close().catch(() => undefined)
  }
})

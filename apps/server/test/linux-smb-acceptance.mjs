import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const serverPath = process.env.HENSHIN_SERVER_ENTRYPOINT
const serverCwd = process.env.HENSHIN_SERVER_CWD
const mountPath = process.env.HENSHIN_SMB_MOUNT_PATH
const objectRelativePath = process.env.HENSHIN_SMB_OBJECT ?? "fixture-book"
const expectedSourceSha256 = process.env.HENSHIN_SMB_SOURCE_SHA256

if (serverPath === undefined || serverCwd === undefined || mountPath === undefined || expectedSourceSha256 === undefined) {
  throw new Error("Linux SMB acceptance requires the shipped server, mounted root, and source digest environment")
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

const waitForExit = (child, timeoutMs) => new Promise((resolve, reject) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve({ code: child.exitCode, signal: child.signalCode })
    return
  }
  const timer = setTimeout(() => reject(new Error("server did not stop before the deadline")), timeoutMs)
  child.once("exit", () => {
    clearTimeout(timer)
    resolve({ code: child.exitCode, signal: child.signalCode })
  })
})

const waitForReady = (child) => new Promise((resolve, reject) => {
  let buffer = ""
  let stderr = ""
  const timer = setTimeout(() => {
    cleanup()
    reject(new Error(`server readiness timed out; stderr=${stderr}`))
  }, 20_000)
  const onStdout = (chunk) => {
    buffer += chunk.toString("utf8")
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      try {
        const value = JSON.parse(line)
        if (value.event === "ready" && typeof value.port === "number") {
          cleanup()
          resolve(value)
          return
        }
      } catch {
        // Ignore non-JSON stdout until the readiness line.
      }
      newline = buffer.indexOf("\n")
    }
  }
  const onStderr = (chunk) => {
    stderr += chunk.toString("utf8")
  }
  const onExit = () => {
    cleanup()
    reject(new Error(`server exited before readiness; stderr=${stderr}`))
  }
  const cleanup = () => {
    clearTimeout(timer)
    child.stdout.off("data", onStdout)
    child.stderr.off("data", onStderr)
    child.off("exit", onExit)
  }
  child.stdout.on("data", onStdout)
  child.stderr.on("data", onStderr)
  child.once("exit", onExit)
})

const request = async (baseUrl, token, pathname, init = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`
    }
  })
  const contentType = response.headers.get("content-type") ?? ""
  const body = contentType.includes("application/json") ? await response.json() : await response.arrayBuffer()
  return { response, body }
}

const requestJson = async (baseUrl, token, pathname, method, payload) => {
  const result = await request(baseUrl, token, pathname, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  })
  assert(result.response.ok, `${method} ${pathname} returned HTTP ${result.response.status}`)
  return result.body
}

const waitForTask = async (baseUrl, token, taskId) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await request(baseUrl, token, `/api/v1/tasks/${taskId}`)
    assert(result.response.ok, `task lookup returned HTTP ${result.response.status}`)
    const task = result.body.data
    if (task.status !== "queued" && task.status !== "running") return task
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("SMB scan did not reach a terminal state")
}

const startServer = async (dbPath, token) => {
  const child = spawn(process.execPath, [serverPath], {
    cwd: serverCwd,
    stdio: ["pipe", "pipe", "pipe"]
  })
  child.stdin.write(`${JSON.stringify({ bearerToken: token, dbPath })}\n`)
  try {
    const ready = await waitForReady(child)
    return { child, baseUrl: `http://127.0.0.1:${ready.port}` }
  } catch (error) {
    child.kill("SIGKILL")
    await waitForExit(child, 5_000).catch(() => undefined)
    throw error
  }
}

const stopServer = async (server) => {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return
  server.child.stdin.end()
  try {
    await waitForExit(server.child, 5_000)
  } catch {
    server.child.kill("SIGKILL")
    await waitForExit(server.child, 5_000)
  }
}

const main = async () => {
  const resolvedMount = path.resolve(mountPath)
  const resolvedServer = path.resolve(serverCwd)
  assert(!resolvedServer.startsWith(`${resolvedMount}${path.sep}`), "server runtime must be outside the SMB mount")

  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-linux-smb-data-"))
  const dbPath = path.join(dataDirectory, "server.sqlite")
  const token = randomBytes(32).toString("base64url")
  let server
  try {
    server = await startServer(dbPath, token)

    const unauthenticated = await fetch(`${server.baseUrl}/api/v1/roots/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: resolvedMount })
    })
    assert(unauthenticated.status === 401, `unauthenticated root preview returned HTTP ${unauthenticated.status}`)

    const preview = await requestJson(server.baseUrl, token, "/api/v1/roots/preview", "POST", { path: resolvedMount })
    assert(preview.data.children.some((child) => child.name === objectRelativePath), "root preview did not see the SMB book")

    const saved = await requestJson(server.baseUrl, token, "/api/v1/roots", "POST", {
      operation_id: randomUUID(),
      instance_id: preview.data.instance_id,
      epoch: preview.data.epoch,
      label: "Linux SMB fixture",
      path: resolvedMount,
      preview_identity: preview.data.preview_identity
    })
    const root = saved.data

    const submitted = await requestJson(server.baseUrl, token, `/api/v1/roots/${root.root_id}/commands`, "POST", {
      operation_id: randomUUID(),
      instance_id: preview.data.instance_id,
      epoch: preview.data.epoch,
      expected_mapping_revision: root.mapping_revision,
      expected_policy_revision: root.policy_revision,
      command: { type: "start-scan", mode: "manual", hold_new_discoveries: false }
    })
    assert(submitted.data.task !== undefined, "root scan did not return a task")
    const task = await waitForTask(server.baseUrl, token, submitted.data.task.task_id)
    assert(task.status === "succeeded", `SMB scan ended with ${task.status}`)

    const libraryView = await request(server.baseUrl, token, "/api/v1/library")
    assert(libraryView.response.ok, `library view returned HTTP ${libraryView.response.status}`)
    assert(libraryView.body.data.roots.some((candidate) => candidate.root_id === root.root_id), "library view omitted the SMB root")

    const library = await requestJson(server.baseUrl, token, "/api/v1/entries/search", "POST", { page_size: 20 })
    assert(library.data.entries.length === 1, `expected one SMB library entry, got ${library.data.entries.length}`)
    const entry = library.data.entries[0]
    assert(entry.relative_path === objectRelativePath, `unexpected library path: ${entry.relative_path}`)
    assert(entry.kind === "image-directory", `unexpected library kind: ${entry.kind}`)
    assert(entry.page_count === 1, `unexpected SMB page count: ${entry.page_count}`)
    assert(entry.cover !== null, "SMB library entry did not return a cover reference")

    let thumbnail
    for (let attempt = 0; attempt < 60; attempt += 1) {
      thumbnail = await request(server.baseUrl, token, `/api/v1/thumbnails/${encodeURIComponent(entry.cover.key)}`)
      if (thumbnail.response.status === 200) break
      assert(thumbnail.response.status === 503, `thumbnail returned HTTP ${thumbnail.response.status}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert(thumbnail?.response.status === 200, "SMB cover was not ready before the deadline")
    assert(thumbnail.response.headers.get("content-type")?.includes("image/webp") === true, "SMB cover was not WebP")
    const coverBytes = Buffer.from(thumbnail.body)
    assert(coverBytes.length > 0, "SMB cover response was empty")

    const sourceBytes = await readFile(path.join(resolvedMount, objectRelativePath, "001.png"))
    const observedSourceSha256 = sha256(sourceBytes)
    assert(observedSourceSha256 === expectedSourceSha256, "SMB source bytes changed during the application flow")

    console.log(JSON.stringify({
      event: "linux_smb_acceptance",
      client_os: `${process.platform}-${process.arch}`,
      node: process.version,
      service: "shipped standalone server",
      share_mount: resolvedMount,
      object: objectRelativePath,
      source_sha256: observedSourceSha256,
      cover_sha256: sha256(coverBytes),
      cover_content_type: thumbnail.response.headers.get("content-type"),
      library_entries: library.data.entries.length,
      scan_status: task.status
    }))
  } finally {
    if (server !== undefined) await stopServer(server)
    await rm(dataDirectory, { recursive: true, force: true })
  }
}

await main()

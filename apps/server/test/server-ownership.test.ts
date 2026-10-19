import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { cleanupTempDb, makeTempDbPath } from "./support/server-process"

const SERVER_PATH = fileURLToPath(new URL("../dist/server.mjs", import.meta.url))
const READY_TIMEOUT_MS = 5_000
const EXIT_TIMEOUT_MS = 2_000

interface ReadyLine {
  readonly event: "ready"
  readonly port: number
  readonly instance_id: string
  readonly epoch: string
}

interface ServerAttempt {
  readonly child: ChildProcessWithoutNullStreams
  readonly bearerToken: string
  readonly stdout: () => string
  readonly stderr: () => string
}

interface RunningServer extends ServerAttempt {
  readonly baseUrl: string
  readonly instanceId: string
  readonly epoch: string
  readonly stop: () => Promise<void>
}

const launchedAttempts = new Set<ServerAttempt>()

const waitForExit = (
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      reject(new Error("server did not exit before the test deadline"))
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve({ code: child.exitCode, signal: child.signalCode })
    }
    child.once("exit", onExit)
  })
}

const launch = (dbPath: string): ServerAttempt => {
  const bearerToken = randomBytes(32).toString("base64url")
  const child = spawn(process.execPath, [SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8")
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8")
  })
  child.stdin.write(JSON.stringify({ bearerToken, dbPath }) + "\n")
  const attempt = { child, bearerToken, stdout: () => stdout, stderr: () => stderr }
  launchedAttempts.add(attempt)
  return attempt
}

const waitForReady = async (attempt: ServerAttempt): Promise<ReadyLine> => {
  const ready = new Promise<ReadyLine>((resolve, reject) => {
    let buffer = ""
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`server readiness timed out; stderr=${attempt.stderr()}`))
    }, READY_TIMEOUT_MS)
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        try {
          const parsed = JSON.parse(line) as Partial<ReadyLine>
          if (parsed.event === "ready" && typeof parsed.port === "number") {
            cleanup()
            resolve(parsed as ReadyLine)
            return
          }
        } catch {
          // Ignore non-JSON stdout from the startup boundary.
        }
        newline = buffer.indexOf("\n")
      }
    }
    const onExit = () => {
      cleanup()
      reject(
        new Error(
          `server exited before readiness; stdout=${attempt.stdout()}; stderr=${attempt.stderr()}`
        )
      )
    }
    const cleanup = () => {
      clearTimeout(timer)
      attempt.child.stdout.off("data", onData)
      attempt.child.off("exit", onExit)
    }
    attempt.child.stdout.on("data", onData)
    attempt.child.on("exit", onExit)
  })
  return ready
}

const stop = async (attempt: ServerAttempt): Promise<void> => {
  if (attempt.child.exitCode !== null || attempt.child.signalCode !== null) return
  attempt.child.stdin.end()
  await waitForExit(attempt.child, EXIT_TIMEOUT_MS)
}

const start = async (dbPath: string): Promise<RunningServer> => {
  const attempt = launch(dbPath)
  try {
    const ready = await waitForReady(attempt)
    return {
      ...attempt,
      baseUrl: `http://127.0.0.1:${ready.port}`,
      instanceId: ready.instance_id,
      epoch: ready.epoch,
      stop: () => stop(attempt)
    }
  } catch (error) {
    attempt.child.kill("SIGKILL")
    await waitForExit(attempt.child, EXIT_TIMEOUT_MS).catch(() => undefined)
    throw error
  }
}

const readNote = async (server: RunningServer): Promise<unknown> => {
  const response = await fetch(`${server.baseUrl}/prototype/v1/note/note-1`, {
    headers: { authorization: `Bearer ${server.bearerToken}` }
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: unknown }).data
}

const writeNote = async (server: RunningServer, text: string): Promise<void> => {
  const response = await fetch(`${server.baseUrl}/prototype/v1/note/note-1`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${server.bearerToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      operation_id: randomUUID(),
      expected_revision: "0",
      text,
      instance_id: server.instanceId,
      epoch: server.epoch
    })
  })
  expect(response.status).toBe(200)
}

const tempDirectories = new Set<string>()
const forceCleanup = async (attempt: ServerAttempt): Promise<void> => {
  if (attempt.child.exitCode !== null || attempt.child.signalCode !== null) return
  attempt.child.stdin.destroy()
  attempt.child.kill("SIGKILL")
  await waitForExit(attempt.child, EXIT_TIMEOUT_MS).catch(() => undefined)
}

afterEach(async () => {
  for (const attempt of launchedAttempts) await forceCleanup(attempt)
  launchedAttempts.clear()
  for (const directory of tempDirectories) await rm(directory, { recursive: true, force: true })
  tempDirectories.clear()
})

describe("server data-directory ownership", () => {
  it("rejects a concurrent owner before readiness and preserves the first server", async () => {
    const dbPath = await makeTempDbPath()
    const first = await start(dbPath)
    try {
      await writeNote(first, "first-owner")
      const second = launch(dbPath)
      const result = await waitForExit(second.child, EXIT_TIMEOUT_MS)

      expect(result.code).toBe(1)
      expect(second.stdout()).not.toContain('"event":"ready"')
      expect(second.stderr()).toContain("server startup failed at ownership: data directory is already owned")
      expect(second.stderr()).not.toContain(second.bearerToken)
      expect(second.stderr()).not.toContain(dbPath)
      await expect(readNote(first)).resolves.toEqual({ note_id: "note-1", text: "first-owner", revision: "1" })
    } finally {
      await first.stop()
      await cleanupTempDb(dbPath)
    }
  })

  it("releases ownership on normal exit and preserves the instance with a fresh epoch", async () => {
    const dbPath = await makeTempDbPath()
    const first = await start(dbPath)
    await writeNote(first, "persisted")
    await first.stop()

    const second = await start(dbPath)
    try {
      expect(second.instanceId).toBe(first.instanceId)
      expect(second.epoch).not.toBe(first.epoch)
      await expect(readNote(second)).resolves.toEqual({ note_id: "note-1", text: "persisted", revision: "1" })
    } finally {
      await second.stop()
      await cleanupTempDb(dbPath)
    }
  })

  it("releases ownership after SIGKILL and preserves the instance with a fresh epoch", async () => {
    const dbPath = await makeTempDbPath()
    const first = await start(dbPath)
    await writeNote(first, "persisted-after-kill")
    first.child.kill("SIGKILL")
    await waitForExit(first.child, EXIT_TIMEOUT_MS)

    const second = await start(dbPath)
    try {
      expect(second.instanceId).toBe(first.instanceId)
      expect(second.epoch).not.toBe(first.epoch)
      await expect(readNote(second)).resolves.toEqual({
        note_id: "note-1",
        text: "persisted-after-kill",
        revision: "1"
      })
    } finally {
      await second.stop()
      await cleanupTempDb(dbPath)
    }
  })

  it("serializes repeated simultaneous first starts on fresh data directories", async () => {
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const dbPath = await makeTempDbPath()
      try {
        const first = launch(dbPath)
        const second = launch(dbPath)
        const observe = async (attempt: ServerAttempt) => {
          try {
            return { attempt, ready: await waitForReady(attempt) }
          } catch (error) {
            return { attempt, error, result: await waitForExit(attempt.child, EXIT_TIMEOUT_MS) }
          }
        }

        const outcomes = await Promise.all([observe(first), observe(second)])
        const ready = outcomes.filter(
          (outcome): outcome is typeof outcome & { readonly ready: ReadyLine } => "ready" in outcome
        )
        const failed = outcomes.filter(
          (outcome): outcome is typeof outcome & {
            readonly result: { readonly code: number | null; readonly signal: NodeJS.Signals | null }
          } => "result" in outcome
        )
        const diagnostics = outcomes
          .map((outcome, contender) => {
            const detail =
              outcome.ready !== undefined
                ? `ready port=${outcome.ready.port}`
                : `exit=${outcome.result.code} signal=${outcome.result.signal ?? "none"} ` +
                  `error=${String(outcome.error)} stdout=${outcome.attempt.stdout()} stderr=${outcome.attempt.stderr()}`
            return `iteration=${iteration} contender=${contender} ${detail}`
              .replaceAll(outcome.attempt.bearerToken, "<redacted-token>")
              .replaceAll(dbPath, "<redacted-db-path>")
          })
          .join("\n")
        expect(ready, diagnostics).toHaveLength(1)
        expect(failed).toHaveLength(1)
        expect(failed[0].result.code).toBe(1)
        expect(failed[0].attempt.stderr()).toContain(
          "server startup failed at ownership: data directory is already owned"
        )

        const survivor = ready[0]
        const running: RunningServer = {
          ...survivor.attempt,
          baseUrl: `http://127.0.0.1:${survivor.ready.port}`,
          instanceId: survivor.ready.instance_id,
          epoch: survivor.ready.epoch,
          stop: () => stop(survivor.attempt)
        }
        try {
          await expect(readNote(running)).resolves.toEqual({ note_id: "note-1", text: "hello", revision: "0" })
        } finally {
          await running.stop()
        }
      } finally {
        await cleanupTempDb(dbPath)
      }
    }
  })

  it("canonicalizes relative and symlinked directory aliases", async () => {
    const dbPath = await makeTempDbPath()
    const dataDirectory = path.dirname(dbPath)
    const aliasDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-ownership-alias-"))
    const directoryAlias = path.join(aliasDirectory, "directory")
    const directoryAliasDbPath = path.join(directoryAlias, path.basename(dbPath))
    const fileAliasDbPath = path.join(aliasDirectory, "prototype-alias.db")
    await symlink(dataDirectory, directoryAlias, "dir")
    await symlink(dbPath, fileAliasDbPath, "file")
    try {
      const first = await start(path.relative(process.cwd(), dbPath))
      for (const aliasDbPath of [directoryAliasDbPath, fileAliasDbPath]) {
        const second = launch(aliasDbPath)
        const result = await waitForExit(second.child, EXIT_TIMEOUT_MS)
        expect(result.code).toBe(1)
        expect(second.stderr()).toContain("server startup failed at ownership: data directory is already owned")
      }
      await first.stop()

      const reacquired = await start(fileAliasDbPath)
      try {
        expect(reacquired.instanceId).toBe(first.instanceId)
        expect(reacquired.epoch).not.toBe(first.epoch)
      } finally {
        await reacquired.stop()
      }
    } finally {
      await rm(aliasDirectory, { recursive: true, force: true })
      await cleanupTempDb(dbPath)
    }
  })

  it("releases ownership when database initialization fails after acquisition", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-ownership-failure-"))
    tempDirectories.add(dataDirectory)
    const dbPath = path.join(dataDirectory, "prototype.db")
    await mkdir(dbPath)

    const first = launch(dbPath)
    const firstResult = await waitForExit(first.child, EXIT_TIMEOUT_MS)
    expect(firstResult.code).toBe(1)
    expect(first.stderr()).toContain("server startup failed at database: database initialization failed")
    expect(first.stderr()).not.toContain("data directory is already owned")

    const second = launch(dbPath)
    const secondResult = await waitForExit(second.child, EXIT_TIMEOUT_MS)
    expect(secondResult.code).toBe(1)
    expect(second.stderr()).toContain("server startup failed at database: database initialization failed")
    expect(second.stderr()).not.toContain("data directory is already owned")

    await rm(dbPath, { recursive: true, force: true })
    const recovered = await start(dbPath)
    try {
      await expect(readNote(recovered)).resolves.toEqual({ note_id: "note-1", text: "hello", revision: "0" })
    } finally {
      await recovered.stop()
    }
  })

  it("rejects a dangling database-file symlink before selecting a guard directory", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-ownership-dangling-data-"))
    const aliasDirectory = await mkdtemp(path.join(os.tmpdir(), "henshin-ownership-dangling-alias-"))
    tempDirectories.add(dataDirectory)
    tempDirectories.add(aliasDirectory)
    const target = path.join(dataDirectory, "not-created.db")
    const danglingPath = path.join(aliasDirectory, "dangling.db")
    await symlink(target, danglingPath, "file")

    const attempt = launch(danglingPath)
    const result = await waitForExit(attempt.child, EXIT_TIMEOUT_MS)
    expect(result.code).toBe(1)
    expect(attempt.stderr()).toContain("server startup failed at data-directory: database path is unavailable")
    expect(attempt.stderr()).not.toContain(danglingPath)
  })

  it("allows independent owners for separate data directories", async () => {
    const firstDbPath = await makeTempDbPath()
    const secondDbPath = await makeTempDbPath()
    const [first, second] = await Promise.all([start(firstDbPath), start(secondDbPath)])
    try {
      expect(first.instanceId).not.toBe(second.instanceId)
      await expect(readNote(first)).resolves.toEqual({ note_id: "note-1", text: "hello", revision: "0" })
      await expect(readNote(second)).resolves.toEqual({ note_id: "note-1", text: "hello", revision: "0" })
    } finally {
      await Promise.all([first.stop(), second.stop()])
      await Promise.all([cleanupTempDb(firstDbPath), cleanupTempDb(secondDbPath)])
    }
  })
})

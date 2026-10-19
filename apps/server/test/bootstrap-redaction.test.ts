import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SERVER_PATH = fileURLToPath(new URL("../dist/server.mjs", import.meta.url))
const EXIT_DEADLINE_MS = 2_000
const SAFE_DIAGNOSTIC = "server bootstrap failed: invalid or unavailable bootstrap channel"

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
      reject(new Error("server did not exit before the bootstrap deadline"))
    }, timeoutMs)
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer)
      resolve({ code, signal })
    }
    child.once("exit", onExit)
  })
}

const forceCleanup = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGKILL")
  await waitForExit(child, EXIT_DEADLINE_MS).catch(() => undefined)
}

describe("server bootstrap diagnostics", () => {
  it("redacts malformed bootstrap input and exits within its deadline", async () => {
    const sentinel = `bootstrap-secret-${randomBytes(24).toString("hex")}`
    const child = spawn(process.execPath, [SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    try {
      child.stdin.write(`not-json-${sentinel}\n`)
      const result = await waitForExit(child, EXIT_DEADLINE_MS)
      expect(result.code).not.toBe(0)
      expect(stderr).toContain(SAFE_DIAGNOSTIC)
      expect(stderr).not.toContain(sentinel)
      expect(stderr).not.toContain("SyntaxError")
    } finally {
      await forceCleanup(child)
    }
  })
})

import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { makeAppLayer } from "./app"

interface Bootstrap {
  readonly bearerToken: string
  readonly dbPath: string
}

/**
 * Reads the private bootstrap payload (bearer token + database path) from
 * stdin. The token never appears in argv, the environment, or logs.
 */
const readBootstrap = (): Promise<Bootstrap> =>
  new Promise((resolve, reject) => {
    let buffer = ""
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      process.stdin.off("data", onData)
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as Bootstrap)
      } catch (error) {
        reject(error)
      }
    }
    process.stdin.on("data", onData)
    process.stdin.once("error", reject)
  })

const main = async () => {
  const bootstrap = await readBootstrap()

  // Closing the private parent channel is a shutdown request, so a crashed
  // desktop never leaves an unmanaged server behind.
  process.stdin.resume()
  const requestShutdown = () => process.kill(process.pid, "SIGTERM")
  process.stdin.on("end", requestShutdown)
  process.stdin.on("close", requestShutdown)

  const appLayer = makeAppLayer({ dbPath: bootstrap.dbPath, bearerToken: bootstrap.bearerToken })
  NodeRuntime.runMain(Layer.launch(appLayer), { disableErrorReporting: true })
}

void main()

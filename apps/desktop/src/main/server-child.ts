import path from "node:path"
import { app } from "electron"
import { startServerChildProcess, type ServerChild } from "./server-child-supervisor"

export type { ServerChild } from "./server-child-supervisor"

/**
 * Starts the independent server as a child of this Electron process.
 *
 * The supervisor generates the bearer token and sends it over the child's stdin
 * (the private control channel), never through argv, the environment, or logs.
 * The bundled Electron Node runtime runs the server via ELECTRON_RUN_AS_NODE so
 * the packaged desktop does not depend on a system Node installation.
 *
 * If startup fails or times out, this function stops only the child it created
 * before rejecting; it never leaves an owned process behind.
 */
export const startServerChild = async (dbPath: string): Promise<ServerChild> => {
  const serverPath = path.join(app.getAppPath(), "dist", "server", "server.mjs")
  return startServerChildProcess(dbPath, {
    serverPath,
    executablePath: process.execPath,
    environment: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  })
}

import { parentPort, workerData } from "node:worker_threads"
import { appendFileSync } from "node:fs"

const mode = workerData.mode ?? "respond"
const delayMs = workerData.delayMs ?? 0
const exitAfter = workerData.exitAfter ?? 1
const arrivalPath = workerData.arrivalPath
let requests = 0

parentPort.on("message", ({ id, request }) => {
  requests += 1
  if (arrivalPath !== undefined) appendFileSync(arrivalPath, `${requests}\n`)
  if (mode === "exit-on-request" || (mode === "exit-after-count" && requests >= exitAfter)) {
    process.exit(17)
  }
  if (mode === "hold") return
  if (request.op === "close") {
    if (mode !== "ignore-close") parentPort.postMessage({ id, ok: true, value: null })
    return
  }

  setTimeout(() => {
    parentPort.postMessage({ id, ok: true, value: null })
  }, delayMs)
})

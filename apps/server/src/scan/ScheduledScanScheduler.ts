import { Cause, Duration, Effect } from "effect"
import { randomUUID } from "node:crypto"
import { RootStore } from "../persistence/RootStore"
import { ScanStore } from "../persistence/ScanStore"
import { ServerState } from "../identity"
import { runManualHeldScan } from "./ManualScanCoordinator"

const DEFAULT_POLL_INTERVAL_MS = 1000

const configuredMilliseconds = (name: string, fallback: number): number => {
  const value = Number(process.env[name])
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

const pollIntervalMs = (): number => configuredMilliseconds(
  "HENSHIN_SCHEDULE_POLL_INTERVAL_MS",
  DEFAULT_POLL_INTERVAL_MS
)

/**
 * Polls persisted owner settings and submits the ordinary normal scan for each
 * due root. The due map is intentionally process-local: an enabled root is due
 * after a restart, while the durable setting remains the source of truth. The
 * worker's active-generation gate makes the start attempt safe without
 * reading the durable task history on every poll.
 */
export const runScheduledScanLoop = Effect.fn("runScheduledScanLoop")(function*() {
  const roots = yield* RootStore
  const scans = yield* ScanStore
  const server = yield* ServerState
  const dueAt = new Map<string, number>()
  const cadenceAt = new Map<string, number>()

  const poll = Effect.gen(function*() {
    const listedRoots = yield* roots.list()
    const now = Date.now()
    const activeRoots = new Set<string>()

    for (const root of listedRoots) {
      if (!root.scheduleEnabled) {
        dueAt.delete(root.rootId)
        cadenceAt.delete(root.rootId)
        continue
      }

      activeRoots.add(root.rootId)
      const priorCadence = cadenceAt.get(root.rootId)
      const due = priorCadence === undefined || priorCadence !== root.scheduleIntervalMs
        ? now
        : dueAt.get(root.rootId) ?? now
      if (due > now) continue

      const started = yield* scans.startScheduled({
        taskId: randomUUID(),
        operationId: randomUUID(),
        epoch: server.epoch,
        rootId: root.rootId,
        expectedMappingRevision: root.mappingRevision,
        expectedPolicyRevision: root.policyRevision,
        holdNewDiscoveries: false
      })

      if (started.kind === "created") {
        yield* runManualHeldScan(started.task, root).pipe(Effect.forkScoped)
      }
      if (started.kind === "created" || started.kind === "active") {
        dueAt.set(root.rootId, now + root.scheduleIntervalMs)
        cadenceAt.set(root.rootId, root.scheduleIntervalMs)
      } else {
        yield* Effect.logWarning(`scheduled scan start deferred for ${root.rootId}: ${started.kind}`)
      }
    }

    for (const rootId of dueAt.keys()) {
      if (!activeRoots.has(rootId)) {
        dueAt.delete(rootId)
        cadenceAt.delete(rootId)
      }
    }
  })

  yield* Effect.forever(
    poll.pipe(
      Effect.catchCause((cause) => Effect.logError(`scheduled scan poll failed: ${Cause.pretty(cause)}`)),
      Effect.andThen(Effect.sleep(Duration.millis(pollIntervalMs())))
    )
  )
})

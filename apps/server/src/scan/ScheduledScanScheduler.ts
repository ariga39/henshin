import { Cause, Duration, Effect } from "effect"
import { randomUUID } from "node:crypto"
import { RootStore } from "../persistence/RootStore"
import { ScanStore } from "../persistence/ScanStore"
import { ServerState } from "../identity"
import { runManualHeldScan } from "./ManualScanCoordinator"

const DEFAULT_SCHEDULE_INTERVAL_MS = 24 * 60 * 60 * 1000
const DEFAULT_POLL_INTERVAL_MS = 1000

const configuredMilliseconds = (name: string, fallback: number): number => {
  const value = Number(process.env[name])
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

const scheduleIntervalMs = (): number => configuredMilliseconds(
  "HENSHIN_SCHEDULE_INTERVAL_MS",
  DEFAULT_SCHEDULE_INTERVAL_MS
)

const pollIntervalMs = (): number => configuredMilliseconds(
  "HENSHIN_SCHEDULE_POLL_INTERVAL_MS",
  DEFAULT_POLL_INTERVAL_MS
)

/**
 * Polls persisted owner settings and submits the ordinary normal scan for each
 * due root. The due map is intentionally process-local: an enabled root is due
 * after a restart, while the durable setting remains the source of truth.
 */
export const runScheduledScanLoop = Effect.fn("runScheduledScanLoop")(function*() {
  const roots = yield* RootStore
  const scans = yield* ScanStore
  const server = yield* ServerState
  const dueAt = new Map<string, number>()

  const poll = Effect.gen(function*() {
    const listedRoots = yield* roots.list()
    const tasks = yield* scans.listTasks()
    const now = Date.now()
    const activeRoots = new Set<string>()

    for (const root of listedRoots) {
      if (!root.scheduleEnabled) {
        dueAt.delete(root.rootId)
        continue
      }

      activeRoots.add(root.rootId)
      const due = dueAt.get(root.rootId) ?? now
      if (due > now || tasks.some((task) =>
        task.root_id === root.rootId && (task.status === "queued" || task.status === "running")
      )) continue

      const started = yield* scans.start({
        taskId: randomUUID(),
        operationId: randomUUID(),
        epoch: server.epoch,
        rootId: root.rootId,
        expectedMappingRevision: root.mappingRevision,
        expectedPolicyRevision: root.policyRevision,
        mode: "scheduled",
        holdNewDiscoveries: false
      })

      switch (started.kind) {
        case "created":
          yield* runManualHeldScan(started.task, root).pipe(Effect.forkScoped)
          break
        case "active":
        case "replayed":
          break
        case "active_scan_conflict":
        case "mapping_revision_conflict":
        case "policy_revision_conflict":
        case "operation_conflict":
        case "root_not_found":
          break
      }
      dueAt.set(root.rootId, now + scheduleIntervalMs())
    }

    for (const rootId of dueAt.keys()) {
      if (!activeRoots.has(rootId)) dueAt.delete(rootId)
    }
  })

  yield* Effect.forever(
    poll.pipe(
      Effect.catchCause((cause) => Effect.logError(`scheduled scan poll failed: ${Cause.pretty(cause)}`)),
      Effect.andThen(Effect.sleep(Duration.millis(pollIntervalMs())))
    )
  )
})

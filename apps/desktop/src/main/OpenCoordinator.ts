import type { EntryResolution, OpenBookIpcResult } from "@henshin/contracts"
import type { OpenEvent } from "@henshin/contracts/event"
import type { OpenJournalRow } from "./persistence/draft-worker-protocol"
import type { LocalMapping } from "./persistence/LocalMappingStore"
import type { StoredReaderProfile } from "./persistence/ReaderProfileStore"
import {
  OpenJournalConflictError,
  OpenJournalStoreFullError
} from "./persistence/OpenJournalStore"
import { LocalDatabaseWorkerError } from "./persistence/LocalDatabaseWorker"
import { ConnectionPausedError } from "./ConnectionLifecycle"
import { OpenTargetError, resolveAcceptedTarget } from "./open-target"
import { ReaderTestLaunchError } from "./reader-profile-validation"

export interface OpenJournalPort {
  get(instanceId: string, actionId: string): Promise<OpenJournalRow | undefined>
  findLatestByEntry(instanceId: string, entryId: string): Promise<OpenJournalRow | undefined>
  findUnresolvedByEntry(instanceId: string, entryId: string): Promise<OpenJournalRow | undefined>
  prepare(input: {
    readonly instanceId: string
    readonly actionId: string
    readonly entryId: string
    readonly profileId?: string | null
    readonly deviceId: string
    readonly observedLocationRevision: string
    readonly observedContentVersion: string
  }): Promise<{ readonly admitted: boolean; readonly entry: OpenJournalRow }>
  recordAccepted(key: { readonly instanceId: string; readonly actionId: string }, event: OpenEvent): Promise<OpenJournalRow>
  recordUnknown(key: { readonly instanceId: string; readonly actionId: string }): Promise<OpenJournalRow>
  recordFailed(key: { readonly instanceId: string; readonly actionId: string }, failure: { readonly failureCode: string; readonly failureMessage: string }): Promise<OpenJournalRow>
}

export interface OpenCoordinatorPorts {
  readonly journal: OpenJournalPort
  readonly loadMapping: (instanceId: string, rootId: string) => Promise<LocalMapping | undefined>
  readonly loadProfile: (profileId: string) => Promise<StoredReaderProfile | undefined>
  readonly resolve: (entryId: string, query?: {
    readonly siblingCursor?: string
    readonly siblingClaimsRevision?: string
  }) => Promise<EntryResolution>
  readonly loadCachedResolution?: (instanceId: string, entryId: string) => Promise<{
    readonly epoch: string
    readonly resolution: EntryResolution
  } | undefined>
  readonly saveCachedResolution?: (input: {
    readonly instanceId: string
    readonly entryId: string
    readonly epoch: string
    readonly resolution: EntryResolution
  }) => Promise<void>
  readonly dispatch: (profile: StoredReaderProfile, target: string) => Promise<void>
  readonly assertCurrent: (instanceId: string, epoch: string) => void
  readonly deviceId: string
  readonly onAcceptedEventDurable?: () => void
  readonly onActiveChanged?: () => void
}

type ActiveAction = {
  readonly actionId: string
  readonly entryId: string
  readonly profileId: string
  readonly promise: Promise<OpenBookIpcResult>
}
type PendingAcceptedEvent = {
  readonly instanceId: string
  readonly actionId: string
  readonly entryId: string
  readonly profileId: string
  readonly event: OpenEvent
}
type OpenInput = {
  readonly instanceId: string
  readonly epoch: string
  readonly entryId: string
  readonly profileId: string
  readonly actionId: string
  readonly offline?: boolean
}
type OpenStatusInput =
  | { readonly entryId: string }
  | { readonly actionId: string }

const ACCEPTED_PERSIST_ATTEMPTS = 3
const ACCEPTED_PERSIST_RETRY_DELAY_MS = 25
const LIVE_RETRY_BASE_DELAY_MS = 100
const LIVE_RETRY_MAX_DELAY_MS = 5_000
const OPEN_TARGET_DEADLINE_MS = 4_000
const OPEN_DISPATCH_DEADLINE_MS = 4_000

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const resultFromJournal = (row: OpenJournalRow): OpenBookIpcResult => ({
  action_id: row.actionId,
  entry_id: row.entryId,
  profile_id: row.profileId ?? null,
  status: row.status === "prepared" ? "unknown" : row.status,
  message: row.status === "accepted"
    ? "The operating system accepted the reader handoff."
    : row.status === "failed"
      ? row.failureMessage ?? "The operating system rejected the reader handoff."
      : "The previous reader handoff outcome is unknown; open again deliberately.",
  event_durable: row.status === "accepted" && row.event !== null
})

const offlineAcceptedMessage = "The operating system accepted the reader handoff using stale cached server evidence; local mapping and target checks passed."

const failedResult = (actionId: string, entryId: string, profileId: string | null, message: string): OpenBookIpcResult => ({
  action_id: actionId,
  entry_id: entryId,
  profile_id: profileId,
  status: "failed",
  message,
  event_durable: false
})

const inFlightResult = (active: ActiveAction): OpenBookIpcResult => ({
  action_id: active.actionId,
  entry_id: active.entryId,
  profile_id: active.profileId,
  status: "in-flight",
  message: "another reader handoff is already opening this entry; follow the active action",
  event_durable: false
})

const profileConflictResult = (actionId: string, entryId: string, profileId: string): OpenBookIpcResult => failedResult(
  actionId,
  entryId,
  profileId,
  "this action ID is already attributed to another reader profile"
)

const unknownAcceptedResult = (actionId: string, entryId: string, profileId: string): OpenBookIpcResult => ({
  action_id: actionId,
  entry_id: entryId,
  profile_id: profileId,
  status: "unknown",
  message: "The operating system accepted the reader handoff, but local history is not durable yet. Do not relaunch; persistence will be retried.",
  event_durable: false
})

const unknownOfflineAcceptedResult = (actionId: string, entryId: string, profileId: string): OpenBookIpcResult => ({
  ...unknownAcceptedResult(actionId, entryId, profileId),
  message: "The operating system accepted the reader handoff using stale cached server evidence, but local history is not durable yet. Do not relaunch; persistence will be retried."
})

const unknownDispatchResult = (actionId: string, entryId: string, profileId: string): OpenBookIpcResult => ({
  action_id: actionId,
  entry_id: entryId,
  profile_id: profileId,
  status: "unknown",
  message: "The reader handoff outcome is unknown; the operating system may have opened the target. Do not retry this action automatically; review local history before opening again.",
  event_durable: false
})

const legacyIntentResult = (row: OpenJournalRow): OpenBookIpcResult => row.status === "accepted" || row.status === "failed"
  ? { ...resultFromJournal(row), profile_id: null }
  : {
      action_id: row.actionId,
      entry_id: row.entryId,
      profile_id: null,
      status: "unknown",
      message: "The retained reader handoff has no recorded reader profile; it was not redispatched.",
      event_durable: false
    }

const retainedResult = (row: OpenJournalRow, input: OpenInput): OpenBookIpcResult => {
  if (row.entryId !== input.entryId) return failedResult(
    input.actionId,
    input.entryId,
    input.profileId,
    "this action ID is already attributed to another entry"
  )
  const profileId = row.profileId ?? null
  if (profileId === null) return legacyIntentResult(row)
  return profileId === input.profileId
    ? resultFromJournal(row)
    : profileConflictResult(input.actionId, input.entryId, input.profileId)
}

const safeFailureMessage = (error: unknown): string => {
  if (error instanceof OpenJournalStoreFullError) {
    return "local Open history is full; no reader was launched. Use Open recovery to dismiss an unknown intent or discard a held event, or wait for acknowledged/failed history to become eligible for compaction; pending, unknown, and held history is retained."
  }
  if (error instanceof ConnectionPausedError) {
    return "the server connection is paused; reconnect before opening"
  }
  if (error instanceof OpenResolutionEvidenceError) return error.message
  if (error instanceof OpenTargetDeadlineError) return error.message
  if (error instanceof OpenShutdownError) return error.message
  if (error instanceof OfflineOpenUnavailableError) return error.message
  if (error instanceof OpenConfigurationError || error instanceof OpenAuthorityError) return error.message
  if (error instanceof OpenTargetError || error instanceof ReaderTestLaunchError) return error.message
  if (error instanceof OpenJournalConflictError) {
    return "local Open history changed during preparation; retry with a new action"
  }
  if (error instanceof LocalDatabaseWorkerError) {
    return "local Open history could not be saved; no reader was launched. Check local storage and retry."
  }
  return "the reader handoff could not be completed; check the reader profile and local mapping, then retry"
}

const sameResolutionMetadata = (left: EntryResolution, right: EntryResolution): boolean =>
  left.entry_id === right.entry_id &&
  left.root_id === right.root_id &&
  left.relative_path === right.relative_path &&
  left.kind === right.kind &&
  left.decision_version === right.decision_version &&
  left.location_revision === right.location_revision &&
  left.content_version === right.content_version &&
  left.status === right.status &&
  left.reason === right.reason &&
  JSON.stringify(left.accepted_observation) === JSON.stringify(right.accepted_observation) &&
  JSON.stringify(left.first_page) === JSON.stringify(right.first_page)

const sameResolution = (left: EntryResolution, right: EntryResolution): boolean =>
  sameResolutionMetadata(left, right) &&
  left.sibling_claims_truncated === right.sibling_claims_truncated &&
  left.sibling_claims_next_cursor === right.sibling_claims_next_cursor &&
  left.sibling_claims_revision === right.sibling_claims_revision &&
  JSON.stringify(left.sibling_claims) === JSON.stringify(right.sibling_claims)

class OpenResolutionEvidenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OpenResolutionEvidenceError"
  }
}

class OpenTargetDeadlineError extends Error {
  constructor() {
    super("the local target check timed out; verify the mount or permissions before retrying")
    this.name = "OpenTargetDeadlineError"
  }
}

class OpenDispatchDeadlineError extends Error {
  constructor() {
    super("the operating system did not report whether the reader handoff was accepted")
    this.name = "OpenDispatchDeadlineError"
  }
}

class OpenShutdownError extends Error {
  constructor() {
    super("the application is shutting down; this Open request was not dispatched")
    this.name = "OpenShutdownError"
  }
}

class OfflineOpenUnavailableError extends Error {
  constructor() {
    super("offline Open is unavailable because this entry has no cached accepted server resolution")
    this.name = "OfflineOpenUnavailableError"
  }
}

class OpenConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OpenConfigurationError"
  }
}

class OpenAuthorityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OpenAuthorityError"
  }
}

export class LocalAccessPreparationError extends Error {
  readonly code = "local_access_unavailable"

  constructor(message: string) {
    super(message)
    this.name = "LocalAccessPreparationError"
  }
}

const withDeadline = async <A>(
  promise: Promise<A>,
  milliseconds: number,
  error: Error,
  onDeadline?: () => void
): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<A>((_, reject) => {
        timer = setTimeout(() => {
          onDeadline?.()
          reject(error)
        }, milliseconds)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const resolveTargetWithDeadline = (
  mapping: Parameters<typeof resolveAcceptedTarget>[0],
  resolution: Parameters<typeof resolveAcceptedTarget>[1],
  profile: Parameters<typeof resolveAcceptedTarget>[2]
): Promise<string> => {
  const controller = new AbortController()
  return withDeadline(
    resolveAcceptedTarget(mapping, resolution, profile, { signal: controller.signal }),
    OPEN_TARGET_DEADLINE_MS,
    new OpenTargetDeadlineError(),
    () => controller.abort()
  )
}

const resolveComplete = async (
  ports: OpenCoordinatorPorts,
  entryId: string
): Promise<EntryResolution> => {
  const first = await ports.resolve(entryId)
  const claims = [...first.sibling_claims]
  const revision = first.sibling_claims_revision
  const seenCursors = new Set<string>()
  let cursor = first.sibling_claims_next_cursor
  while (cursor !== null) {
    if (seenCursors.has(cursor)) {
      throw new OpenResolutionEvidenceError("sibling identity evidence could not be completed; refresh the entry before opening")
    }
    seenCursors.add(cursor)
    const next = await ports.resolve(entryId, {
      siblingCursor: cursor,
      siblingClaimsRevision: revision
    })
    if (!sameResolutionMetadata(first, next) || next.sibling_claims_revision !== revision) {
      throw new OpenResolutionEvidenceError("sibling identity evidence changed during resolution; refresh the entry before opening")
    }
    claims.push(...next.sibling_claims)
    cursor = next.sibling_claims_next_cursor
  }
  return {
    ...first,
    sibling_claims: claims,
    sibling_claims_truncated: first.sibling_claims_truncated && first.sibling_claims_next_cursor === null,
    sibling_claims_next_cursor: null
  }
}

export class OpenCoordinator {
  private readonly activeByEntry = new Map<string, ActiveAction>()
  private readonly activeByAction = new Map<string, ActiveAction>()
  private readonly pendingAcceptedEvents = new Map<string, PendingAcceptedEvent>()
  private readonly pendingAcceptedByEntry = new Map<string, PendingAcceptedEvent>()
  private readonly acceptedReplayByAction = new Map<string, Promise<OpenBookIpcResult>>()
  private readonly inFlight = new Set<Promise<OpenBookIpcResult>>()
  private readonly liveRetryTasks = new Map<string, Promise<void>>()
  private readonly retryWaiters = new Set<() => void>()
  private accepting = true

  constructor(private readonly ports: OpenCoordinatorPorts) {}

  async prepareLocal(input: {
    readonly instanceId: string
    readonly epoch: string
    readonly entryId: string
    readonly profileId: string
  }): Promise<import("@henshin/contracts").PrepareLocalAccessIpcResult> {
    try {
      this.ports.assertCurrent(input.instanceId, input.epoch)
      const resolution = await resolveComplete(this.ports, input.entryId)
      if (resolution.entry_id !== input.entryId || resolution.status !== "usable") {
        throw new OpenResolutionEvidenceError("the selected entry is not currently eligible for local Open")
      }
      const mapping = await this.ports.loadMapping(input.instanceId, resolution.root_id)
      if (mapping === undefined) throw new OpenTargetError("configure a compatible local mapping before checking local access")
      const profile = await this.ports.loadProfile(input.profileId)
      if (profile === undefined) throw new OpenTargetError("the selected reader profile is no longer configured")
      const target = await withDeadline(
        resolveAcceptedTarget(mapping, resolution, profile),
        OPEN_TARGET_DEADLINE_MS,
        new OpenTargetDeadlineError()
      )
      this.ports.assertCurrent(input.instanceId, input.epoch)
      const currentResolution = await resolveComplete(this.ports, input.entryId)
      const currentMapping = await this.ports.loadMapping(input.instanceId, currentResolution.root_id)
      const currentProfile = await this.ports.loadProfile(input.profileId)
      if (
        currentMapping === undefined ||
        currentMapping.mappingRevision !== mapping.mappingRevision ||
        currentMapping.selectedPath !== mapping.selectedPath ||
        currentMapping.canonicalPath !== mapping.canonicalPath ||
        currentMapping.admittedRootIdentity !== mapping.admittedRootIdentity ||
        currentProfile === undefined ||
        currentProfile.revision !== profile.revision ||
        !sameResolution(resolution, currentResolution)
      ) {
        throw new OpenResolutionEvidenceError("the selected entry, mapping, or reader profile changed during local access checking")
      }
      const currentTarget = await withDeadline(
        resolveAcceptedTarget(currentMapping, currentResolution, currentProfile),
        OPEN_TARGET_DEADLINE_MS,
        new OpenTargetDeadlineError()
      )
      if (currentTarget !== target) throw new OpenTargetError("the verified local target changed during local access checking")
      this.ports.assertCurrent(input.instanceId, input.epoch)
      await this.ports.saveCachedResolution?.({
        instanceId: input.instanceId,
        entryId: input.entryId,
        epoch: input.epoch,
        resolution
      })
      return {
        entry_id: input.entryId,
        profile_id: input.profileId,
        status: "eligible",
        message: "Eligible local copy verified. Open remains a separate explicit action."
      }
    } catch (error) {
      throw new LocalAccessPreparationError(safeFailureMessage(error))
    }
  }

  private notifyActiveChanged(): void {
    try {
      this.ports.onActiveChanged?.()
    } catch {
      // State notification is advisory; the status query remains authoritative.
    }
  }

  private assertAccepting(): void {
    if (!this.accepting) throw new OpenShutdownError()
  }

  private rememberPendingAccepted(pending: PendingAcceptedEvent): void {
    this.pendingAcceptedEvents.set(`${pending.instanceId}:${pending.actionId}`, pending)
    this.pendingAcceptedByEntry.set(`${pending.instanceId}:${pending.entryId}`, pending)
  }

  private forgetPendingAccepted(pending: PendingAcceptedEvent): void {
    const actionKey = `${pending.instanceId}:${pending.actionId}`
    const entryKey = `${pending.instanceId}:${pending.entryId}`
    if (this.pendingAcceptedEvents.get(actionKey) === pending) this.pendingAcceptedEvents.delete(actionKey)
    if (this.pendingAcceptedByEntry.get(entryKey) === pending) this.pendingAcceptedByEntry.delete(entryKey)
  }

  private replayPendingAccepted(input: OpenInput, pending: PendingAcceptedEvent): Promise<OpenBookIpcResult> {
    const key = `${input.instanceId}:${input.actionId}`
    const existing = this.acceptedReplayByAction.get(key)
    if (existing !== undefined) return existing
    const replay = (async () => {
      try {
        return resultFromJournal(await this.persistAcceptedWithRetry(pending, true))
      } catch {
        return unknownAcceptedResult(input.actionId, input.entryId, input.profileId)
      }
    })()
    this.acceptedReplayByAction.set(key, replay)
    void replay.finally(() => {
      if (this.acceptedReplayByAction.get(key) === replay) this.acceptedReplayByAction.delete(key)
    }).catch(() => undefined)
    return replay
  }

  open(input: OpenInput): Promise<OpenBookIpcResult> {
    if (!this.accepting) {
      return Promise.resolve(failedResult(input.actionId, input.entryId, input.profileId, "the application is shutting down; this Open request was not started"))
    }
    const actionKey = `${input.instanceId}:${input.actionId}`
    const entryKey = `${input.instanceId}:${input.entryId}`
    const activeAction = this.activeByAction.get(actionKey)
    if (activeAction !== undefined) {
      if (activeAction.entryId !== input.entryId) {
        return Promise.resolve(failedResult(input.actionId, input.entryId, input.profileId, "this action ID is already attributed to another entry"))
      }
      return activeAction.profileId === input.profileId
        ? activeAction.promise
        : Promise.resolve(profileConflictResult(input.actionId, input.entryId, input.profileId))
    }
    const pendingAccepted = this.pendingAcceptedEvents.get(actionKey)
    if (pendingAccepted !== undefined) {
      if (pendingAccepted.entryId !== input.entryId) {
        return Promise.resolve(failedResult(input.actionId, input.entryId, input.profileId, "this action ID is already attributed to another entry"))
      }
      return pendingAccepted.profileId === input.profileId
        ? this.replayPendingAccepted(input, pendingAccepted)
        : Promise.resolve(profileConflictResult(input.actionId, input.entryId, input.profileId))
    }
    const active = this.activeByEntry.get(entryKey)
    if (active !== undefined) return Promise.resolve(inFlightResult(active))
    const pendingForEntry = this.pendingAcceptedByEntry.get(entryKey)
    if (pendingForEntry !== undefined) {
      return Promise.resolve(unknownAcceptedResult(pendingForEntry.actionId, pendingForEntry.entryId, pendingForEntry.profileId))
    }
    const promise = this.run(input)
    this.inFlight.add(promise)
    const ownedAction: ActiveAction = {
      actionId: input.actionId,
      entryId: input.entryId,
      profileId: input.profileId,
      promise
    }
    this.activeByEntry.set(entryKey, ownedAction)
    this.activeByAction.set(actionKey, ownedAction)
    this.notifyActiveChanged()
    void promise.finally(() => {
      if (this.activeByEntry.get(entryKey) === ownedAction) this.activeByEntry.delete(entryKey)
      if (this.activeByAction.get(actionKey) === ownedAction) this.activeByAction.delete(actionKey)
      this.inFlight.delete(promise)
      this.notifyActiveChanged()
    }).catch(() => undefined)
    return promise
  }

  async status(instanceId: string, input: OpenStatusInput): Promise<OpenBookIpcResult | null> {
    if ("entryId" in input) {
      const active = this.activeByEntry.get(`${instanceId}:${input.entryId}`)
      if (active !== undefined) return inFlightResult(active)
      const pending = this.pendingAcceptedByEntry.get(`${instanceId}:${input.entryId}`)
      if (pending !== undefined) return unknownAcceptedResult(pending.actionId, pending.entryId, pending.profileId)
      const latest = await this.ports.journal.findLatestByEntry(instanceId, input.entryId)
      return latest === undefined ? null : resultFromJournal(latest)
    }
    const actionKey = `${instanceId}:${input.actionId}`
    const active = this.activeByAction.get(actionKey)
    if (active !== undefined) return inFlightResult(active)
    const pending = this.pendingAcceptedEvents.get(actionKey)
    if (pending !== undefined) return unknownAcceptedResult(pending.actionId, pending.entryId, pending.profileId)
    const retained = await this.ports.journal.get(instanceId, input.actionId)
    if (retained === undefined) return null
    return retained.profileId == null ? legacyIntentResult(retained) : resultFromJournal(retained)
  }

  /** Synchronously prevent new Open admissions before shutdown awaits existing work. */
  closeAdmissions(): void {
    if (!this.accepting) return
    this.accepting = false
    for (const wake of Array.from(this.retryWaiters)) wake()
  }

  /** Wait for admitted opens to finish their handoff and local result recording. */
  async waitForInFlight(deadlineMs = 5_000): Promise<void> {
    const deadline = Date.now() + deadlineMs
    while (this.inFlight.size > 0 || this.liveRetryTasks.size > 0) {
      const waiting = Promise.allSettled([
        ...this.inFlight,
        ...this.liveRetryTasks.values()
      ])
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      await Promise.race([waiting, delay(remaining)])
    }
  }

  /** Retry only accepted-event persistence; never redispatch a reader. */
  async drainPendingAccepted(deadlineMs = 5_000): Promise<void> {
    const deadline = Date.now() + deadlineMs
    for (const pending of Array.from(this.pendingAcceptedEvents.values())) {
      let retry = 0
      while (this.pendingAcceptedEvents.get(`${pending.instanceId}:${pending.actionId}`) === pending) {
        try {
          await this.persistAcceptedWithRetry(pending, true)
          break
        } catch {
          // Keep the immutable event in memory if the bounded shutdown
          // deadline expires before the local journal recovers.
          const remaining = deadline - Date.now()
          if (remaining <= 0) break
          const wait = Math.min(100, ACCEPTED_PERSIST_RETRY_DELAY_MS * (2 ** Math.min(retry, 4)))
          retry += 1
          await delay(Math.min(wait, remaining))
        }
      }
    }
  }

  private async persistAccepted(pending: PendingAcceptedEvent): Promise<OpenJournalRow> {
    const recorded = await this.ports.journal.recordAccepted(
      { instanceId: pending.instanceId, actionId: pending.actionId },
      pending.event
    )
    if (recorded.event === null) throw new Error("accepted event was not returned by the local journal")
    this.forgetPendingAccepted(pending)
    return recorded
  }

  private async persistAcceptedWithRetry(
    pending: PendingAcceptedEvent,
    notifyDelivery = false
  ): Promise<OpenJournalRow> {
    let lastError: unknown
    for (let attempt = 0; attempt < ACCEPTED_PERSIST_ATTEMPTS; attempt += 1) {
      try {
        const recorded = await this.persistAccepted(pending)
        if (notifyDelivery) {
          try {
            this.ports.onAcceptedEventDurable?.()
          } catch {
            // The local event is already durable; delivery resumes on the
            // existing connection/reconnect hook if this notification fails.
          }
        }
        return recorded
      } catch (error) {
        lastError = error
        if (attempt + 1 < ACCEPTED_PERSIST_ATTEMPTS) {
          await delay(ACCEPTED_PERSIST_RETRY_DELAY_MS)
        }
      }
    }
    throw lastError
  }

  private async recordUnknownWithRetry(input: OpenInput): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < ACCEPTED_PERSIST_ATTEMPTS; attempt += 1) {
      try {
        await this.ports.journal.recordUnknown({ instanceId: input.instanceId, actionId: input.actionId })
        return
      } catch (error) {
        lastError = error
        if (attempt + 1 < ACCEPTED_PERSIST_ATTEMPTS) await delay(ACCEPTED_PERSIST_RETRY_DELAY_MS)
      }
    }
    throw lastError
  }

  private async recordFailedWithRetry(
    input: OpenInput,
    failure: { readonly failureCode: string; readonly failureMessage: string }
  ): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < ACCEPTED_PERSIST_ATTEMPTS; attempt += 1) {
      try {
        await this.ports.journal.recordFailed(
          { instanceId: input.instanceId, actionId: input.actionId },
          failure
        )
        return
      } catch (error) {
        lastError = error
        if (attempt + 1 < ACCEPTED_PERSIST_ATTEMPTS) await delay(ACCEPTED_PERSIST_RETRY_DELAY_MS)
      }
    }
    throw lastError
  }

  private async waitForRetryDelay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.retryWaiters.delete(finish)
        resolve()
      }
      const timer = setTimeout(finish, milliseconds)
      this.retryWaiters.add(finish)
    })
  }

  private scheduleLiveRetry(pending: PendingAcceptedEvent): void {
    const key = `${pending.instanceId}:${pending.actionId}`
    if (!this.accepting || this.liveRetryTasks.has(key)) return
    const task = (async (): Promise<void> => {
      let retry = 0
      while (this.accepting && this.pendingAcceptedEvents.get(key) === pending) {
        const milliseconds = Math.min(LIVE_RETRY_MAX_DELAY_MS, LIVE_RETRY_BASE_DELAY_MS * (2 ** Math.min(retry, 6)))
        await this.waitForRetryDelay(milliseconds)
        if (!this.accepting || this.pendingAcceptedEvents.get(key) !== pending) return
        try {
          await this.persistAcceptedWithRetry(pending, true)
          return
        } catch {
          retry += 1
        }
      }
    })()
    this.liveRetryTasks.set(key, task)
    void task.finally(() => {
      if (this.liveRetryTasks.get(key) === task) this.liveRetryTasks.delete(key)
    }).catch(() => undefined)
  }

  private async run(input: OpenInput): Promise<OpenBookIpcResult> {
    let prepared: OpenJournalRow | undefined
    let acceptedHandoff = false
    let acceptedEvent: OpenEvent | undefined
    let ambiguousDispatch = false
    const offline = input.offline === true
    try {
      const actionKey = `${input.instanceId}:${input.actionId}`
      const pending = this.pendingAcceptedEvents.get(actionKey)
      if (pending !== undefined) {
        if (pending.entryId !== input.entryId) return failedResult(input.actionId, input.entryId, input.profileId, "this action ID is already attributed to another entry")
        if (pending.profileId !== input.profileId) return profileConflictResult(input.actionId, input.entryId, input.profileId)
        return this.replayPendingAccepted(input, pending)
      }
      const previous = await this.ports.journal.get(input.instanceId, input.actionId)
      if (previous !== undefined) return retainedResult(previous, input)
      const unresolved = await this.ports.journal.findUnresolvedByEntry(input.instanceId, input.entryId)
      // A durable unknown is a retained diagnostic, not a permanent entry
      // lock. A new deliberate action may proceed while the old action remains
      // available by its original ID. Prepared intent, however, still means
      // that dispatch may be unresolved and must never be replayed.
      if (unresolved?.status === "prepared") return resultFromJournal(unresolved)
      let resolution: EntryResolution
      if (offline) {
        let cached: Awaited<ReturnType<NonNullable<OpenCoordinatorPorts["loadCachedResolution"]>>> | undefined
        try {
          cached = await this.ports.loadCachedResolution?.(input.instanceId, input.entryId)
        } catch {
          throw new OfflineOpenUnavailableError()
        }
        if (cached === undefined) throw new OfflineOpenUnavailableError()
        resolution = cached.resolution
      } else {
        this.ports.assertCurrent(input.instanceId, input.epoch)
        resolution = await resolveComplete(this.ports, input.entryId)
        if (this.ports.saveCachedResolution !== undefined) {
          try {
            await this.ports.saveCachedResolution({
              instanceId: input.instanceId,
              entryId: input.entryId,
              epoch: input.epoch,
              resolution
            })
          } catch {
            // A current connected Open remains valid when its best-effort
            // offline cache write fails; the journal still records it durably.
          }
        }
      }
      if (resolution.entry_id !== input.entryId) throw new Error("the selected entry resolution did not match")
      const mapping = await this.ports.loadMapping(input.instanceId, resolution.root_id)
      if (mapping === undefined) throw new OpenConfigurationError("configure a compatible local mapping before opening")
      const profile = await this.ports.loadProfile(input.profileId)
      if (profile === undefined) throw new OpenConfigurationError("the selected reader profile is no longer configured")
      const target = await resolveTargetWithDeadline(mapping, resolution, profile)
      if (!offline) this.ports.assertCurrent(input.instanceId, input.epoch)
      const admission = await this.ports.journal.prepare({
        instanceId: input.instanceId,
        actionId: input.actionId,
        entryId: input.entryId,
        profileId: input.profileId,
        deviceId: this.ports.deviceId,
        observedLocationRevision: resolution.location_revision,
        observedContentVersion: resolution.content_version
      })
      prepared = admission.entry
      if (!admission.admitted) return retainedResult(admission.entry, input)
      if ((prepared.profileId ?? null) !== input.profileId) {
        return (prepared.profileId ?? null) === null
          ? legacyIntentResult(prepared)
          : profileConflictResult(input.actionId, input.entryId, input.profileId)
      }
      if (!offline) this.ports.assertCurrent(input.instanceId, input.epoch)
      const currentResolution = offline ? resolution : await resolveComplete(this.ports, input.entryId)
      const currentMapping = await this.ports.loadMapping(input.instanceId, currentResolution.root_id)
      const currentProfile = await this.ports.loadProfile(input.profileId)
      if (
        currentMapping === undefined ||
        currentMapping.mappingRevision !== mapping.mappingRevision ||
        currentMapping.selectedPath !== mapping.selectedPath ||
        currentMapping.canonicalPath !== mapping.canonicalPath ||
        currentMapping.admittedRootIdentity !== mapping.admittedRootIdentity ||
        currentProfile === undefined ||
        currentProfile.revision !== profile.revision ||
        !sameResolution(resolution, currentResolution)
      ) {
        throw new OpenAuthorityError("the selected entry, mapping, or reader profile changed during preparation; refresh before opening")
      }
      const currentTarget = await resolveTargetWithDeadline(currentMapping, currentResolution, currentProfile)
      if (currentTarget !== target) throw new OpenAuthorityError("the verified local target changed during preparation; refresh before opening")
      if (!offline) this.ports.assertCurrent(input.instanceId, input.epoch)
      this.assertAccepting()
      try {
        await withDeadline(
          this.ports.dispatch(currentProfile, currentTarget),
          OPEN_DISPATCH_DEADLINE_MS,
          new OpenDispatchDeadlineError()
        )
      } catch (error) {
        if (error instanceof OpenDispatchDeadlineError) ambiguousDispatch = true
        throw error
      }
      acceptedHandoff = true
      acceptedEvent = {
        event_id: input.actionId,
        instance_id: input.instanceId,
        entry_id: input.entryId,
        device_id: this.ports.deviceId,
        observed_location_revision: resolution.location_revision,
        observed_content_version: resolution.content_version,
        occurred_at_ms: Date.now()
      }
      const pendingAccepted: PendingAcceptedEvent = {
        instanceId: input.instanceId,
        actionId: input.actionId,
        entryId: input.entryId,
        profileId: input.profileId,
        event: acceptedEvent
      }
      this.rememberPendingAccepted(pendingAccepted)
      const recorded = await this.persistAcceptedWithRetry(pendingAccepted, true)
      return {
        action_id: input.actionId,
        entry_id: input.entryId,
        profile_id: input.profileId,
        status: "accepted",
        message: offline ? offlineAcceptedMessage : "The operating system accepted the reader handoff.",
        event_durable: recorded.event !== null
      }
    } catch (error) {
      const message = safeFailureMessage(error)
      if (ambiguousDispatch) {
        try {
          await this.recordUnknownWithRetry(input)
        } catch {
          // Keep the result unknown and never dispatch again; the prepared row
          // remains an unresolved recovery item if local persistence is down.
        }
        return unknownDispatchResult(input.actionId, input.entryId, input.profileId)
      }
      if (acceptedHandoff && acceptedEvent !== undefined) {
        const pendingAccepted: PendingAcceptedEvent = {
          instanceId: input.instanceId,
          actionId: input.actionId,
          entryId: input.entryId,
          profileId: input.profileId,
          event: acceptedEvent
        }
        this.rememberPendingAccepted(pendingAccepted)
        this.scheduleLiveRetry(pendingAccepted)
        return offline
          ? unknownOfflineAcceptedResult(input.actionId, input.entryId, input.profileId)
          : unknownAcceptedResult(input.actionId, input.entryId, input.profileId)
      }
      if (prepared !== undefined) {
        try {
          await this.recordFailedWithRetry(input, { failureCode: "open_failed", failureMessage: message })
        } catch {
          try {
            // A failed terminal write must not strand a prepared row as an
            // entry lock. Preserve the conservative unresolved outcome when
            // the journal can record that recovery state.
            await this.recordUnknownWithRetry(input)
          } catch {
            // The prepared row remains recoverable on the next journal start;
            // no reader was dispatched and no event was created.
          }
          return {
            action_id: input.actionId,
            entry_id: input.entryId,
            profile_id: input.profileId,
            status: "unknown",
            message: "The reader handoff outcome is unknown; open again only after reviewing local diagnostics.",
            event_durable: false
          }
        }
      }
      return failedResult(input.actionId, input.entryId, input.profileId, message)
    }
  }
}

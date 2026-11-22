import type { EntryResolution, OpenBookIpcResult } from "@henshin/contracts"
import type { OpenEvent } from "@henshin/contracts/event"
import type { OpenJournalRow } from "./persistence/draft-worker-protocol"
import type { LocalMapping } from "./persistence/LocalMappingStore"
import type { StoredReaderProfile } from "./persistence/ReaderProfileStore"
import { resolveAcceptedTarget } from "./open-target"

export interface OpenJournalPort {
  get(instanceId: string, actionId: string): Promise<OpenJournalRow | undefined>
  prepare(input: {
    readonly instanceId: string
    readonly actionId: string
    readonly entryId: string
    readonly deviceId: string
    readonly observedLocationRevision: string
    readonly observedContentVersion: string
  }): Promise<{ readonly admitted: boolean; readonly entry: OpenJournalRow }>
  recordAccepted(key: { readonly instanceId: string; readonly actionId: string }, event: OpenEvent): Promise<OpenJournalRow>
  recordFailed(key: { readonly instanceId: string; readonly actionId: string }, failure: { readonly failureCode: string; readonly failureMessage: string }): Promise<OpenJournalRow>
}

export interface OpenCoordinatorPorts {
  readonly journal: OpenJournalPort
  readonly loadMapping: (instanceId: string, rootId: string) => Promise<LocalMapping | undefined>
  readonly loadProfile: (profileId: string) => Promise<StoredReaderProfile | undefined>
  readonly resolve: (entryId: string) => Promise<EntryResolution>
  readonly dispatch: (profile: StoredReaderProfile, target: string) => Promise<void>
  readonly assertCurrent: (instanceId: string, epoch: string) => void
  readonly deviceId: string
}

type ActiveAction = Promise<OpenBookIpcResult>
type OpenInput = {
  readonly instanceId: string
  readonly epoch: string
  readonly entryId: string
  readonly profileId: string
  readonly actionId: string
}

const resultFromJournal = (row: OpenJournalRow): OpenBookIpcResult => ({
  action_id: row.actionId,
  entry_id: row.entryId,
  status: row.status === "prepared" ? "unknown" : row.status,
  message: row.status === "accepted"
    ? "The operating system accepted the reader handoff."
    : row.status === "failed"
      ? row.failureMessage ?? "The operating system rejected the reader handoff."
      : "The previous reader handoff outcome is unknown; open again deliberately.",
  event_durable: row.status === "accepted" && row.event !== null
})

const failedResult = (actionId: string, entryId: string, message: string): OpenBookIpcResult => ({
  action_id: actionId,
  entry_id: entryId,
  status: "failed",
  message,
  event_durable: false
})

const sameResolution = (left: EntryResolution, right: EntryResolution): boolean =>
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

export class OpenCoordinator {
  private readonly active = new Map<string, ActiveAction>()

  constructor(private readonly ports: OpenCoordinatorPorts) {}

  open(input: OpenInput): Promise<OpenBookIpcResult> {
    const entryKey = `${input.instanceId}:${input.entryId}`
    const active = this.active.get(entryKey)
    if (active !== undefined) return active
    const action = this.run(input)
    this.active.set(entryKey, action)
    void action.finally(() => {
      if (this.active.get(entryKey) === action) this.active.delete(entryKey)
    }).catch(() => undefined)
    return action
  }

  private async run(input: OpenInput): Promise<OpenBookIpcResult> {
    const previous = await this.ports.journal.get(input.instanceId, input.actionId)
    if (previous !== undefined) {
      return previous.entryId === input.entryId
        ? resultFromJournal(previous)
        : failedResult(input.actionId, input.entryId, "this action ID is already attributed to another entry")
    }

    let prepared: OpenJournalRow | undefined
    let acceptedHandoff = false
    try {
      this.ports.assertCurrent(input.instanceId, input.epoch)
      const resolution = await this.ports.resolve(input.entryId)
      if (resolution.entry_id !== input.entryId) throw new Error("the selected entry resolution did not match")
      const mapping = await this.ports.loadMapping(input.instanceId, resolution.root_id)
      if (mapping === undefined) throw new Error("configure a compatible local mapping before opening")
      const profile = await this.ports.loadProfile(input.profileId)
      if (profile === undefined) throw new Error("the selected reader profile is no longer configured")
      const target = await resolveAcceptedTarget(mapping.canonicalPath, resolution, profile)
      this.ports.assertCurrent(input.instanceId, input.epoch)
      const admission = await this.ports.journal.prepare({
        instanceId: input.instanceId,
        actionId: input.actionId,
        entryId: input.entryId,
        deviceId: this.ports.deviceId,
        observedLocationRevision: resolution.location_revision,
        observedContentVersion: resolution.content_version
      })
      prepared = admission.entry
      if (!admission.admitted) return resultFromJournal(admission.entry)
      this.ports.assertCurrent(input.instanceId, input.epoch)
      const currentResolution = await this.ports.resolve(input.entryId)
      const currentMapping = await this.ports.loadMapping(input.instanceId, currentResolution.root_id)
      const currentProfile = await this.ports.loadProfile(input.profileId)
      if (
        currentMapping === undefined ||
        currentMapping.mappingRevision !== mapping.mappingRevision ||
        currentMapping.canonicalPath !== mapping.canonicalPath ||
        currentProfile === undefined ||
        currentProfile.revision !== profile.revision ||
        !sameResolution(resolution, currentResolution)
      ) {
        throw new Error("the selected entry, mapping, or reader profile changed during preparation")
      }
      const currentTarget = await resolveAcceptedTarget(currentMapping.canonicalPath, currentResolution, currentProfile)
      if (currentTarget !== target) throw new Error("the verified local target changed during preparation")
      this.ports.assertCurrent(input.instanceId, input.epoch)
      await this.ports.dispatch(currentProfile, currentTarget)
      acceptedHandoff = true
      const event: OpenEvent = {
        event_id: input.actionId,
        instance_id: input.instanceId,
        entry_id: input.entryId,
        device_id: this.ports.deviceId,
        observed_location_revision: resolution.location_revision,
        observed_content_version: resolution.content_version,
        occurred_at_ms: Date.now()
      }
      const recorded = await this.ports.journal.recordAccepted(
        { instanceId: input.instanceId, actionId: input.actionId },
        event
      )
      return {
        action_id: input.actionId,
        entry_id: input.entryId,
        status: "accepted",
        message: "The operating system accepted the reader handoff.",
        event_durable: recorded.event !== null
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The reader handoff could not be completed."
      if (acceptedHandoff) {
        return {
          action_id: input.actionId,
          entry_id: input.entryId,
          status: "unknown",
          message: "The operating system accepted the reader handoff, but its local history is unresolved. Do not relaunch automatically.",
          event_durable: false
        }
      }
      if (prepared !== undefined) {
        try {
          await this.ports.journal.recordFailed(
            { instanceId: input.instanceId, actionId: input.actionId },
            { failureCode: "open_failed", failureMessage: message }
          )
        } catch {
          return {
            action_id: input.actionId,
            entry_id: input.entryId,
            status: "unknown",
            message: "The reader handoff outcome is unknown; open again only after reviewing local diagnostics.",
            event_durable: false
          }
        }
      }
      return failedResult(input.actionId, input.entryId, message)
    }
  }
}

# Cross-device Consistency and Instance Lifecycle

This topic owns shared-server consistency, concurrent edits, disconnected behavior, event delivery, and migration/clone/restore boundaries. Defaults assume one user and one authoritative server with several desktops. Independent local and remote servers are separate authorities, not synchronized replicas. File access remains independent through [device mappings](path-mapping.md).

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Identity, Connections, and Authority Epoch

The persisted server instance ID identifies a data namespace. It is not authentication. A connection profile holds a URL, expected instance ID once enrolled, and credentials in protected client storage. Authenticate the endpoint and verify its instance ID before displaying live library data or submitting commands. An unexpected ID at the same URL requires explicit enrollment as a separate connection; do not silently retarget mappings, cached entry IDs, or pending events.

One desktop installation has one random device ID, persisted locally and shared by its windows and server connections. A device label is diagnostic provenance, not an account or access credential. Registration with a server may record that ID and a user-editable label after authentication; historical event payloads retain their original ID. A renamed label changes presentation only. Reinstall or an explicit independent-profile clone creates a new device ID. There is no hardware fingerprinting or claim of detecting arbitrary filesystem copies of a desktop profile.

Every server process start creates a new unpredictable authority epoch, returned by handshake and API responses. Unlike instance ID, the epoch changes on ordinary restart, migration, and restore. It prevents stale client revisions from being mistaken for current state after rollback. Clients bind commands, page cursors, and refresh responses to both instance ID and epoch. Mutations carry the expected epoch; the server rejects a stale epoch before applying them. A late response from an old connection/epoch cannot update the current UI. [Contracts](api-and-tasks.md) owns exact fields and errors.

An epoch is not a distributed lock or proof that no copied server is running elsewhere. Running two copies with the same instance ID is unsupported. Local startup must exclude a second process using the same data directory; operators must stop the old authority before migrating it. [Deployment](architecture.md) owns process locks and authenticated endpoint setup. A client observing overlapping live epochs for one namespace stops automatic writes and asks for endpoint reconciliation rather than electing an authority.

## Shared Views and Refresh

The server commits shared mutations transactionally and returns current record revisions. Relevant commits advance the per-library change revision described by [search](search.md). Standardize that field's name as library change revision; it is a coarse change signal for search membership/order/projections, not a substitute for entry/root edit revisions. Compare it only within an epoch. A restart invalidates old cursors and signals even if the database contents were preserved.

Notifications are invalidation hints. They identify the current instance/epoch and affected scope; they do not carry authoritative edits for blind application. Use current HTTP reads to refresh entries, task state, and visible queries. Missing, duplicated, or reordered hints must not affect correctness. Reconnect and window focus trigger refresh, and a bounded periodic revision check covers lost notifications while the connection appears healthy. Exact transport, intervals, and coalescing are API/runtime tuning choices, not requirements for a durable event bus.

A server change that arrives while a search page is loading does not mutate row positions silently. Follow search's live-pagination behavior: reject superseded request responses, deduplicate IDs, indicate changed results, and offer refresh. Same-epoch entry refreshes must not overwrite a newer known record revision with an older response. Source-gallery revisions and entry edits are distinct; use the response's coherent effective projection rather than combining unrelated cached fragments.

## Concurrent Commands and Ambiguous Results

Metadata, binding, and lifecycle commands carry the revisions specified by their owning topics. Binding/override/lifecycle edits share an entry decision revision; root mapping/policy changes use their own revisions; gallery refreshes have independent source generations. Validate preconditions and write the complete operation atomically. A stale precondition returns a conflict with the current relevant state and submitted intent context; it does not auto-merge or overwrite another device's edit.

The client keeps the user's unsaved form values for comparison. Refresh shows what changed; reapply is a new deliberate command against fresh revisions. Do not automatically resubmit stale text, suppressions, or a replacement decision. Disconnected metadata editing is unavailable; an unsent local form draft is neither a queued command nor a promise to merge later.

Side-effecting commands that can be retransmitted use an operation ID, payload identity, and a stored result, including identity-resolution operations already specified by entry lifecycle. Within the accepted epoch, an identical retry retrieves its result before reevaluating old preconditions; different payload under the same ID is a conflict. Persist result and effects atomically. API/persistence must define retention and expose expiration; no automatic retry may outlive its known deduplication window. A client with an ambiguous expired result refreshes state and requires deliberate reapplication instead of issuing a fresh ID automatically.

On an epoch change, do not automatically replay ambiguous metadata/configuration/lifecycle commands: their deduplication result may have been lost by restore. First refresh current state and show the unresolved intent for user reconciliation. Open events are the exception: their immutable instance-wide IDs and append-only ownership allow controlled resubmission after the refreshed handshake, as below. Reader launch is never retried by this protocol.

## Disconnected Cache and Reconnection

The desktop stores a bounded display cache of previously fetched entry summaries/details, accepted local observations, requested page manifests, root/collision information needed for resolution, and permitted thumbnails. Cache eviction cannot remove pending events, local mappings, reader profiles, or installation identity. This is not a content cache, full-library replica, or guarantee of disconnected search completeness. Cached browsing is explicitly labeled and limited to loaded records; never present a partial cache as a complete server search.

While disconnected, [external reading](external-reading.md) may use cached accepted identities and local mappings if all required checks/data suffice. Known pending/detached states remain blocked. NAS accessibility and server connectivity are independent. An expired authorization or unexpected server identity blocks live submission and does not silently switch identities; a deliberate offline view can still use previously stored local data according to local device access.

On successful authenticated reconnect:

1. Verify expected instance ID, API compatibility, and current epoch before requests can mutate shared state.
2. If the epoch changed, invalidate cursors, change signals, cached revisions, in-flight commands, and accepted-state freshness for launch. Retain cached data as explicitly stale display only, plus local configuration and the separate event queue. Fetch current root/entry state before online Open; while connected, do not fall back to old accepted state if the refreshed entry is missing/pending/detached.
3. Refresh visible views, details used for Open, root configuration, and task status. Revalidate device mappings if their root identity or expected evidence changed; server-native prefix changes alone do not rewrite client mappings.
4. Reconcile and resume immutable event delivery for this instance. Request per-event results and keep unresolved items visible. Refresh authoritative count/history after acknowledgment; do not add local pending totals to server counts without labeling them separately.

Concurrent windows share main-process connection/event coordination, rather than running independent launch journals or competing queue drainers. Switching active servers cancels/invalidates old view requests but leaves accepted events and diagnostics in their original namespace. Delivery may continue only to an authenticated connection for that namespace; otherwise it waits. No queued event migrates to another server profile merely because that profile becomes active.

## Durable Event Delivery

Only accepted-handoff events from the local journal enter the delivery queue. Intents and unknown launch outcomes never do. Payloads are immutable and contain their originating instance/entry/device identifiers and occurrence/observation fields. A batch is bounded and may be partly accepted; each event's insertion, aggregate update, library change revision, and result are transactional. Invalid request envelopes fail without processing; valid envelopes receive an independently attributable result per event. Persist no accepted result before its transaction commits.

| Per-event result | Client action |
| --- | --- |
| Accepted | Persist acknowledgment locally, then remove from pending delivery |
| Already accepted with identical payload | Same acknowledgment behavior; never increment count again |
| Same ID with different payload | Stop automatic retries for that event; preserve conflict details and payload for inspection |
| Entry missing (for example after restore) | Hold unresolved in its original namespace; never retarget or create an entry automatically |
| Invalid payload or unsupported event version | Hold with actionable permanent error; do not silently drop or rewrite |
| Temporary service/storage failure | Keep pending; retry identical event with bounded exponential backoff and jitter |
| Missing result, lost response, or timeout | Keep that event pending; retry its original ID/payload |

Wrong instance, incompatible protocol, or authentication failure pauses the connection's queue and prompts recovery. A stale epoch requires handshake/refetch before retrying the same immutable events; it never authorizes another launch. Honor server retry delays. Backoff caps delay and concurrency rather than discarding after an arbitrary attempt count. Manual retry bypasses a waiting delay only when its blocking condition has been addressed. Permanent failures do not block independent valid events from delivery.

Server deduplication records are the retained open events themselves; no TTL drops event identity while history remains. Entries are retained under [entry lifecycle](entry-identity.md), so delayed events for detached or relocated entries remain valid and do not fail merely because observed versions differ. Those versions annotate the historical observation and cannot mutate current identity. Aggregate count is derived only from committed unique events; receipt time comes from the accepting server transaction and does not replace occurrence time.

A client removes an event from pending only after durable acknowledgment. If it crashes between server acceptance and local acknowledgment, replay returns Already accepted. Local journal write/space failures follow the reader topic's rules. Delivery policy retains all unacknowledged events, including held permanent failures, across restart; they are not aged out silently. Users can inspect and explicitly export/discard held events after a consequence notice (discarding loses the pending count, never launches a reader). Acknowledged/failed launch-journal diagnostics may be compacted under persistence policy. Discarding a still-ambiguous upload may not remove an event already accepted by the server; it is not history deletion.

## Migration, Clone, and Restore

| Operation | Namespace and client behavior |
| --- | --- |
| Move the sole authority | Stop original, copy a consistent database/configuration, preserve instance/entry/event IDs, configure new server mappings, start successor with new epoch, explicitly reconnect and authenticate |
| Start an independent clone | Allocate new instance ID and credentials before accepting connections; copied entries/history form that independent baseline, but no client mappings or pending events transfer automatically |
| Restore older backup as sole authority | Stop writers, restore consistently, preserve instance ID, start with new epoch; all clients refresh and reconcile as for epoch change |

A changed URL alone does not change namespace; equal IDs alone do not prove authentication. Migration preserves mappings and queue namespace but requires clients to verify the successor's endpoint. Clone history may retain provenance IDs in its copied baseline; new events use the clone's namespace. Existing queued events belong to the original and are not imported into the clone. Desktop profile export/clone excludes the live journal and credentials by default and generates a new installation ID; do not duplicate live pending queues as a way to move reading history.

Restore rolls back data to the backup point. Previously acknowledged events or metadata edits after that point may disappear; clients may already have compacted acknowledgments, so automatic reconstruction is not promised. Display a recovery notice and refresh all affected views. Pending events still present locally may be resubmitted: those in the backup deduplicate, those absent but targeting retained entries can be inserted, and those targeting missing entries are held. Never recreate a missing entry from cached filenames or resurrect post-backup metadata commands automatically.

Because revisions can roll backward, instance ID plus numeric revision alone is insufficient. The fresh startup epoch fences pre-restore cursors and command preconditions without changing entry ownership or the event deduplication namespace. Old background-task checkpoints must also be recovered against restored state; task orchestration owns that restart protocol. [Persistence](data-model.md) and [delivery](delivery-and-validation.md) must implement consistent backup/restore and verify these failure cases before offering maintenance operations. Restoring a copied database into an already running process is unsupported.

## Acceptance Scenarios

| Scenario | Required result |
| --- | --- |
| Two devices edit one entry from the same revision | One commit; second sees conflict with preserved local intent |
| Reply lost after a command commits | Same-epoch idempotent retry returns stored result; expired/changed-epoch ambiguity requires reconciliation |
| Notification lost/reordered or renderer unmounted | Periodic/focus/reconnect reads converge; obsolete responses cannot overwrite current views |
| NAS available but server offline | Cached local Open may work; no offline metadata mutations or full-library search claim |
| Batch has accepted, duplicate, invalid, and missing-entry events | Each receives its own result; only unique valid events affect count |
| Server accepts event, acknowledgment is lost | Retry same event; one authoritative count |
| Event arrives after entry detached/replaced | Old entry retains event; new path occupant unaffected |
| Client switches servers while uploading | Result remains scoped to original namespace and cannot change the new server view |
| Same URL now exposes another instance | Enrollment decision required; no automatic queue/mapping transfer |
| Ordinary restart or old backup restore | New epoch invalidates cursors/preconditions and forces refresh; event IDs remain deduplicated within the instance |
| Restore removes an event's entry | Hold event; no path-based reassignment or automatic identity recreation |
| Two copied authorities share an instance ID | Unsupported setup; observed overlap stops automatic writes; no claim of global split-brain prevention |
| Independent server or desktop-profile clone | New required identity/credentials; no copied live queue silently replayed |
| Queue storage pressure or permanent event failure | Preserve pending payloads; explicit recovery/discard, no silent eviction |

These scenarios specify behavior, not executed integration results. Before implementation, fix operation-result retention, queue/storage limits, public conflict schemas, API epoch checks, notification/polling cadence, cache invalidation tests, and restore/crash fixtures in their owning persistence/contracts/runtime/delivery topics.

# External Readers and Open History

This topic owns local reader configuration, launch semantics, and creation of usage events. Readers access NAS content through the client's mapping; the server never launches a desktop application or forwards collection content. The following first-release defaults refine [entry identity](entry-identity.md) and [path resolution](path-mapping.md).

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Local Reader Profiles

Reader profiles belong to the desktop installation, not shared library metadata. A profile specifies a display name, launch mode, supported entry formats, target mode, and (for an executable) a locally selected absolute executable path plus an ordered argument array. Defaults may be selected separately for archives and image directories. A missing compatible profile opens local setup; never guess a remote-supplied command.

| Mode | Target and behavior |
| --- | --- |
| Explicit executable | Launch a user-selected native executable directly with separate arguments; no shell command construction |
| System association | Ask the OS to open the checked native target with its associated application; directory association may open a file manager rather than a reader |
| Archive target | Pass the accepted archive itself; the reader must support that format |
| Directory target | Pass the accepted image-directory root |
| First-image target | Image-directory entries only; reject this mode for archives without extracting them. Pass the first supported page from the accepted complete manifest, following indexing's deterministic page order; validate its local path and accessibility again |

The initial argument editor stores tokens separately, not a command-line string. Exactly one token is the whole `{target}` placeholder; other tokens are literal locally configured reader options. Do not interpolate titles, tags, environment variables, URL values, or arbitrary templates. Paths containing spaces or metacharacters remain one argument. Use absolute targets so a basename beginning with a hyphen is not emitted as an option. A reader requiring an option terminator can have a literal `--` before `{target}` when its CLI supports it.

First-image selection follows the manifest, not the cover choice: indexing may skip an undecodable page when choosing a cover, but Henshin does not silently skip it for reader launch or guarantee that a reader can decode it.

No automatic archive extraction, mount creation, application installation, or content download is provided. Shell scripts, batch files, interpreter/shell wrappers, and remote executable configuration are outside the initial profile model. macOS app-bundle selection needs a tested native application adapter before that selection mode is offered; an internal executable path is not assumed equivalent to opening its app bundle. Named-reader presets are added only after validating their argument and target behavior. No particular third-party reader has yet been certified.

Profiles are edited through trusted local settings. Executable selection uses a main-owned native picker; main issues a selection handle and resolves it when saving the profile. For an existing profile, a save may explicitly retain the main-stored target using its profile ID and expected revision without a new picker selection; replacing the target requires a new selection handle. Save never treats a renderer-supplied path as an executable selection. Main validates the selected target against the native executable/wrapper restrictions above. The renderer's Open request carries entry/profile identifiers and an action ID, never arbitrary executable paths or arguments. Electron main resolves profiles and the current server namespace, validates the IPC request, and owns native access. Server responses and imported metadata cannot create profiles or execute commands. [API/IPC contracts](api-and-tasks.md) defines the precise bridge and sender validation.

## Open Workflow and Identity Checks

1. A deliberate user action creates a cryptographically random UUID action/event ID, unique across devices and entries within the server instance. The server-instance/entry pair is its immutable validation and attribution context, not its uniqueness scope. The main process coalesces duplicate delivery of that action while it remains in its bounded recent-action journal. Reusing an ID with different inputs is an error. Before any asynchronous refresh or resolution, main atomically reserves the active Open slot keyed by `(instance_id, entry_id)`, shared across all local windows and connection profiles for that instance. A concurrent Open with a different action ID for that entry returns the existing in-flight action ID/status without creating a second intent or dispatch; it does not change the first action's captured reader/profile/context. The caller follows the returned action rather than automatically resubmitting its proposal.
2. If connected, refresh accepted identity state, current location, location revision, content version, and accepted local observation. If disconnected, use the last cached accepted state with a stale indicator; no cached entry means no offline Open. Authentication/identity failures are not silently treated as network outages: use an explicit disconnected mode only with the previously verified namespace.
3. Resolve the location through the effective client mapping. Apply containment, collision, revision, and availability checks from path mapping. Known pending or detached entries cannot launch. Server-side missing/inaccessible status alone does not block a working client mapping. A known local size/mtime or manifest mismatch requires server reconciliation; unchanged hints do not prove byte identity.
4. Resolve the target mode and reader profile, rejecting incompatible format/mode combinations (including first-image mode for archives). First-image mode requires cached accepted manifest data offline; do not enumerate and silently choose a different first page. Check the chosen target, and fail explicitly when it is missing, unreadable, unsupported, or unsafe.
5. Before dispatch, recheck the selected server namespace, mapping revision (including its non-reused generation), locally known decision/location/content versions, and profile revision against the captured operation. A changed decision aborts this action; refreshing or retrying requires a new explicit action. The server and external NAS cannot be atomically locked through launch, so later unseen changes remain an observational limit.
6. Record a durable launch intent locally before invoking the OS, then dispatch at most once for that live action. If intent persistence fails, do not launch. Disable the entry's Open control while this action is unresolved; duplicate shortcuts/double-clicks share the in-flight action. After main records and publishes its terminal result, a new deliberate Open receives a new ID even for the same entry.
7. On OS acceptance, capture occurrence time and persist one immutable open event locally using the action ID as its event ID. Event delivery runs independently of the screen or renderer. On definite launch failure, record failure and create no countable event. On uncertainty, show the unknown result and never automatically dispatch again.

Main exposes active status by instance/entry and publishes launch-state hints to all subscribed windows; stale UI state cannot bypass the main admission check. The active slot lasts through preparation and dispatch until main records and publishes a terminal accepted, failed, cancelled, or unknown result. Release does not wait for reader exit, server upload/acknowledgment, or a renderer acknowledgment. An accepted result whose event could not be persisted is published with its explicit durability warning and independent persistence retry. Window teardown cannot release a still-running slot. On restart, old intents become diagnostic unknown outcomes, never active locks or replayable launches; show that uncertainty before offering a new explicit Open. The active slot is transient coordination, not a uniqueness constraint on retained journal diagnostics or pending events. Separate devices/installations may Open independently.

Mapping changes, navigation, server switching, and cancellation can prevent dispatch before it happens. After dispatch, cancellation cannot undo an accepted launch; the main process finishes result recording in the captured namespace even if the renderer unmounts or the client switches servers. Do not kill the reader to cancel event delivery or close Henshin. [Effect composition](application-logic.md) must place this work in a main-process lifetime rather than a React component's scope.

The application does not recursively hash content on every Open or sandbox the reader. Containment protects Henshin's reads and supplied target, not the reader's later enumeration, link traversal, or navigation. Reader setup explains this boundary. External filesystem changes between checking and use can still cause a launch based on stale evidence.

## What Counts as Accepted

| Adapter result | Count/event behavior |
| --- | --- |
| Direct native process emits successful spawn | Accepted handoff; record one event |
| Direct process fails before spawn | Failed handoff; no event |
| OS association reports successful open submission | Accepted handoff; record one event |
| OS association reports an error | Failed handoff; no event |
| Adapter times out, crashes, or cannot establish a result | Unknown; no inferred success and no automatic launch retry |
| Spawned reader exits immediately or reports a later error | Retain the accepted-handoff event; do not infer reading success or undo based on exit status |

A successful handoff does not establish that a window appeared, the file decoded, or any page was read. Single-instance readers may forward the request to an existing process and exit; waiting for process exit is not the acceptance criterion. Opening a directory through its system association may open a file manager, which still counts as that requested handoff and must be described accurately in setup. Previewing a cover, showing details, revealing a location in a file manager, and testing profile configuration are distinct actions that create no entry open event.

[Node's child-process documentation](https://nodejs.org/api/child_process.html#event-spawn) defines the successful `spawn` event and distinguishes it from errors within the spawned process. [Electron shell documentation](https://www.electronjs.org/docs/latest/api/shell#shellopenpathpath) defines `openPath` as resolving to an empty string on success or an error message on failure. These documents were inspected on 2026-10-18; no reader integration was executed. Prefer direct `spawn` with `shell: false`, default argument escaping, and ignored/bounded output; do not enable verbatim Windows argument handling or invoke a shell to repair quoting. Exact adapters remain gated by platform tests.

## Local Durability and Crash Recovery

The local journal distinguishes prepared/dispatch-unresolved intent, accepted event awaiting upload, acknowledged event, and definite failure. A durable intent is not a countable event. A restart must not replay a launch intent: a crash can occur immediately before or after dispatch, and neither journal presence nor process discovery proves whether the OS accepted it. Retain unresolved intents as diagnostic unknown outcomes until the user dismisses them; do not convert them to events automatically. A user can explicitly Open again with a new action ID after seeing that the earlier result is unknown.

Reader launch and event persistence cannot form an atomic transaction. The intent journal prevents blind replay, but a crash after acceptance and before recording the event can still lose a count. If the event write fails while the main process remains alive, retain the immutable event in memory, show that it is not yet durable, and retry only the persistence operation. Do not report it as safely queued or relaunch the reader. If saving never succeeds before a crash, the count may be lost. Counts are personal usage records, not audit-grade completeness guarantees.

Before dispatch, verify the journal can accept a new intent within its finite storage budget. Never silently evict unacknowledged events to make room. Storage exhaustion blocks new counted Open with an actionable error; there is no implicit untracked launch mode. This proposed first-release default keeps one Open contract and avoids silently losing requested history; it is not a security restriction on opening files outside Henshin. A separate explicit untracked action would need its own product semantics and is not included in this release. Retention/compaction may remove acknowledged/failed records, but IPC action replay after their retention window is unsupported: renderer recovery queries status and requires a new deliberate action rather than resending an old Open. [Synchronization](synchronization.md) owns queue retention, acknowledgments, partial batches, backoff, and permanent failures; [persistence](data-model.md) owns the journal's transactions and migration.

## Event Ownership and Time

Device ID is a random installation identifier generated and persisted by Electron main, shared by its windows, retained across normal upgrades, and renewed on reinstall or independent desktop-profile cloning. It labels event provenance, not authentication, user identity, or deduplication. Synchronization owns registration/display and clone handling; deleting or renaming a device label cannot change historical event ownership.

An event contains event/action ID, server instance ID, entry ID, device ID, observed location revision, observed content version, and occurrence time as a UTC instant with millisecond precision. Its payload becomes immutable after acceptance. The server supplies receipt time and deduplicates by event ID within the instance; a duplicate ID with different payload is a conflict, never an additional count. No native path, reader executable, or argument list is needed in the shared event.

Delayed events remain attributed to their selected entry even after relocation, detachment, or replacement. Observed versions are diagnostic, not an instruction to resurrect a claim or reject every historically valid event. Missing entries after restore require an explicit unresolved delivery result; never retarget by path, title, or gallery. [Synchronization](synchronization.md) owns this reconciliation.

Display occurrence instants in the user's current display time zone with a way to inspect the UTC instant. Preserve receipt time separately. As defined by [search](search.md), last opened is the maximum occurrence time among server-accepted unique events, while open count counts those events. Device clock skew can make last opened appear in the future; show a clock-difference diagnostic when materially different from receipt time, without rewriting the event. The exact diagnostic threshold belongs to UI/settings and is not an acceptance cutoff.

Pending local events appear separately as pending history/count information for their namespace. They do not change server search order or authoritative totals. First release provides read-only history and delivery diagnostics; manual count adjustment, editing timestamps, deletion of accepted history, and session-duration tracking are outside scope. No external-reader telemetry or observation of opens made outside Henshin is implied.

## Acceptance and Handoffs

| Scenario | Required result |
| --- | --- |
| First-image target chosen for an archive | Reject without extraction; directory entries use their accepted manifest |
| Profile target created, retained during argument-only editing, or replaced | Accept a valid main-picker selection, or retain the stored target under profile ID/revision; reject stale revisions, fabricated handles and renderer-supplied executable paths |
| Server mapping A and client mapping B access the same NAS | Reader receives the checked client-native target directly |
| Spaces, quotes, percent signs, non-Latin names, and shell metacharacters | Target remains one literal argument; no shell expansion |
| Pending replacement, detached entry, changed manifest, or local size/mtime mismatch | No launch/event; explain reconciliation need |
| Server outage with accepted cached identity/mapping/manifest | Explicit stale local Open may proceed if all required cached data and local checks suffice |
| Profile, mapping, or namespace changes during preparation | Abort before dispatch; no automatic retry |
| Two devices open different entries | Independently generated event IDs share the instance-wide deduplication domain; no per-entry counter IDs |
| IPC duplicate or double-click while pending | One dispatch and at most one event for the action |
| Two local windows/profiles submit different action IDs for the same instance/entry while the first is preparing or dispatch-unresolved | Main returns the first in-flight action to both; one intent/dispatch and at most one event despite delayed UI hints |
| Origin window closes while its Open is active | Main retains admission ownership until terminal result publication; another window can query by entry |
| Terminal result published but event upload remains pending, or restart leaves a diagnostic unknown intent | No permanent entry lock; a new deliberate Open is allowed after the result/uncertainty is shown, without replaying the old action |
| Second deliberate action after the first result | New dispatch and new event ID |
| Reader already running or exits immediately after successful spawn | One accepted-handoff event, no claim of actual reading |
| Failure before acceptance, unknown adapter result, or cancellation | No fabricated success; no automatic relaunch |
| Crash before dispatch or after dispatch but before event commit | Unresolved intent is never replayed or automatically counted |
| Event commit succeeds but upload/ack fails | Retry the same event; server count increases once |
| Queue is full or write fails | Do not evict pending history; pre-dispatch failure blocks launch, post-acceptance failure reports durability risk |
| Renderer closes or server switches after acceptance | Main process completes local recording in the original namespace |
| Delayed event targets an entry now detached | Retain original ownership; never assign it to the new path occupant |
| Device clock is wrong | Preserve occurrence/receipt distinction and visible diagnostics |

Before implementation, exercise direct and associated launch on Windows, macOS, and Linux with actual NAS mounts and representative archive/directory readers. Record platform/version, path encoding, already-running behavior, failure classification, and app-shutdown survival. Test crash injection at intent/dispatch/event/ack boundaries and effect cancellation before/after dispatch. These are required implementation gates, not completed tests. [UI](user-interface.md) owns settings, stale-state messages, unknown-outcome recovery, and accessible interaction; [delivery](delivery-and-validation.md) owns recorded platform coverage.

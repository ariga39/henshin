# HTTP, Electron IPC, and Background-task Contracts

This topic owns the public operation surface, request/result shapes, validation, idempotency, cancellation, and task transitions. [Persistence](data-model.md) owns atomic writes; [consistency](synchronization.md) owns authority/queue semantics. These are first-release protocol defaults to implement with shared Effect schemas and typed HTTP declarations, subject to the integration gate in [application logic](application-logic.md).

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Transport and Common Envelope

Use authenticated JSON HTTP under `/api/v1`, HTTPS for remote endpoints, and authenticated loopback HTTP for the managed local service. Binary responses are limited to derived thumbnails and explicitly requested maintenance artifacts, never collection archives/pages. Authentication also protects those artifacts, task status, and settings. [Deployment](architecture.md) owns credentials, TLS, and startup. Unsupported API major versions fail negotiation before mutations; feature capabilities can disable optional formats without making a malformed request succeed.

Successful JSON replies carry `instance_id`, `epoch`, `request_id`, `server_time`, and `data`. Entry/list replies also carry the library change revision from the same read view. IDs are opaque strings; revisions are canonical decimal strings; instants are UTC integer milliseconds within the schema's supported range. Optional/missing fields use documented nullable/absent forms rather than localized sentinel strings. Unknown enum values are protocol errors, not implicit defaults. Expected errors use `{ code, message, retryable, details, request_id }` with current instance/epoch when authenticated; no raw stacks, SQL, cookies, tokens, or native-path dumps in generic errors.

Mutations require expected instance/epoch plus a random operation ID and the command's base revisions, except open-event batches whose immutable per-event IDs are the deduplication keys. Instance/epoch validation precedes mutation or lookup of an unrelated namespace. Store canonical command identity (operation kind, resource IDs, validated payload, preconditions) with its result. An identical same-epoch retry returns the recorded result before rechecking old revisions; changed payload under one ID returns `operation_conflict`. Search and candidate discovery never mutate bindings or identities. A preview may persist only its own read-only job/result state; starting a durable preview uses an operation ID and returns a task ID.

Initial bounded defaults: 1 MiB JSON request body, 100 events per batch, 200 explicit IDs per bulk command, page size 50/default and 200/max, 8 KiB decoded cursor, and 1,024 Unicode scalars for search text. Schema-specific arrays/strings/nesting also have finite limits; large manifests use pagination. Publish actual limits in capabilities, reject excess explicitly, and never truncate source IDs or silently ignore filter IDs. These are configurable implementation defaults within a versioned contract, not performance claims.

## Read and Command Surface

| HTTP operation | Request/result contract |
| --- | --- |
| `GET /handshake` | Authenticated instance/epoch, API major/minor, supported capabilities/limits, schema compatibility status; no library data before authentication |
| `GET /library` | Single library ID/name/change revision and current root summaries |
| `POST /entries/search` | Validated literal query, canonical filter IDs, sort/direction, optional cursor/page size; entries, field-match labels, change revision, `has_more`, next cursor |
| `GET /entries/{id}` | Coherent effective/source/local metadata, identity, last server observation, logical location, decision/location/content versions, cover reference, statistics; no default server-native prefix |
| `GET /entries/{id}/resolution` | Current identity/location/evidence versions, accepted lightweight observation, sibling claims/collision context and manifest handle needed for local resolution; insufficient cache never implies safe fallback |
| `GET /entries/{id}/manifest` | Version-bound page/member identities and order, paginated; reject a changed content version instead of mixing pages from different manifests |
| `GET /entries/{id}/history` | Paginated accepted immutable events with device labels and occurrence/receipt times; pending local events are supplied separately by IPC |
| `GET /roots` and `GET /roots/{id}` | Root logical identity, server configuration in privileged settings response, mapping/policy revisions and status; ordinary entry response remains logical |
| `POST /roots` | Operation ID, label/mapping proposal and verification evidence; server allocates root ID, activation serializes overlap checks |
| `GET /settings/eh` and `POST /settings/eh` | Read redacted configured status/generation, or conditionally activate protected credentials/settings; secrets never returned by GET |
| `POST /roots/preview` | Read-only server-native mapping/discovery proposal or current-root scan preview, bounded/paginated results, profile/evidence/revisions and partial-coverage errors; never allocate identities |
| `POST /roots/{id}/commands` | Tagged configure/activate/suspend/remove mapping, enable/disable scans, exclusions, schedule, or start-scan/analysis/verification command; apply owning revision checks |
| `POST /entries/{id}/commands` | Tagged title/tags/notes edit, bind/unbind, confirm same/new edition, stop scanning, detach missing claim, relocate, choose cover, or acquire fingerprint; typed per-command preconditions |
| `GET /review/candidates` | Staged/replacement candidates with analysis/completeness/hold state and decision fences; separate from ordinary search |
| `POST /review/candidates/{id}/commands` | Reserve/release hold, explicit import-new, or relocate selected entry; candidate/hold/root/mapping/entry fences as applicable, with incomplete-scan acknowledgment flag |
| `POST /eh/candidates` | Read-only candidate search from selected entry/query under EH policy; statuses distinguish empty, blocked, failed and ambiguous results; no automatic binding |
| `POST /eh/refresh` | Explicit entry IDs or gallery target; per-item eligibility/job association, coalesced gallery tasks, no selection expansion |
| `GET /tags` | Canonical IDs, namespace/original labels, active translated aliases; normalized picker query and pagination |
| `GET /devices` and `POST /devices/{id}/commands` | Register-if-absent (existing ID returns existing label/revision without overwriting), explicit revision-checked label update, and lookup; provenance only, no account/authentication role |
| `POST /open-events/batch` | Immutable events with per-item accepted/already-accepted/held-invalid/missing-entry/conflict/transient results; request epoch is transport context, not immutable event payload; no cached whole-batch result blocks retry of transient items |
| `GET /operations/{id}` | Same-epoch stored result and expiry when known; unknown/expired means reconcile ambiguous command, not permission for automatic re-execution |
| `GET /tasks`, `GET /tasks/{id}`, `POST /tasks/{id}/commands` | Query status/result or request cancel/retry with task revision and operation ID |
| `GET /changes` | Authenticated SSE invalidation hints bound to instance/epoch; no guaranteed replay |
| `GET /thumbnails/{key}` | Derived image or explicit missing/updating status; immutable versioned key and bounded image type/size; never a generic path endpoint |
| `POST /maintenance/backups` and `/maintenance/exports` | Operation ID, explicit export scope/options or configured backup destination ID with rotating/archive retention class and optional label; return task/artifact ID, never accept arbitrary server output paths |
| `GET /maintenance/artifacts` | Authenticated bounded listing of artifact IDs, store kind, snapshot/verification times, retention class, completion state and destination ID; opaque cursor, no directory browser |
| `POST /maintenance/artifacts/{id}/verify` | Operation ID and artifact ID; bounded integrity-verification task under registered destination, no restore or source write |
| `GET /maintenance/artifacts/{id}` | Authenticated bounded/streamed completed artifact with content type, size and digest; expire regenerable exports under stated retention, not a backup without operator policy |

Root creation uses `POST /roots` with an operation ID, proposed label/mapping, and verification evidence; root IDs are server-assigned and overlap checks serialize at activation. Removal means disabling configuration/clearing effective mapping while retaining the root and entries. EH credential configuration uses a separate privileged `POST /settings/eh` command with expected credential/settings revision; GET returns configured status and generation, never secrets. Restore/clone require the stopped-service maintenance tool, not a live HTTP endpoint that replaces its own open database. [Backup and archival recovery](backup-and-archive.md) governs bundle kinds, snapshot publication, retention-class protection and desktop maintenance. Backup policy changes use an authenticated `POST /settings/backups` with operation ID, expected settings revision, registered destination ID, schedule enablement and retention count; registration of native destination paths remains local administrator configuration. Restored policies cannot authorize pruning until explicit reconciliation/reactivation. Archive creation is a backup mode, not source archiving or a new deletion endpoint.

Revision sets are command-specific discriminated schemas, not an optional bag. Replacement acceptance checks decision/location/candidate/mapping/policy evidence; Stop scanning additionally writes against root policy revision without requiring successful analysis; detach checks current confirmed-missing state; relocation checks source entry and target candidate/hold/claim context. A stale proof yields conflict with a refresh target. Cover choice checks content version and page identity. Binding/override edits share decision revision; source refresh targets its own generation. Follow [identity](entry-identity.md), [indexing](file-indexing.md), and [EH](eh-metadata.md) exactly.

Search cursors encode a bounded versioned structure with query/filter/sort identity, direction, namespace/epoch, normalization profile, last typed key/nullness, and entry ID. Decode/validate before parameterized SQL. A cursor never supplies a SQL fragment; wrong context returns `cursor_stale` or `invalid_cursor`. Null-last ordering and live-page limits follow [search](search.md). Manifest/collision pagination must preserve a coherent observation version; clients require all necessary collision information or block ambiguous Open.

## Errors, Retries, and Cancellation

| Status / code family | Meaning and required handling |
| --- | --- |
| 400 `invalid_request`, `invalid_cursor`, `invalid_filter` | Malformed schema/query; preserve user input and show field errors, no automatic mutation retry |
| 401/403 `authentication_required`, `access_denied` | Pause shared operations/event delivery and recover credentials; no offline/alternate-server write fallback |
| 404 `not_found` | Requested retained record absent in this namespace; never search another namespace/path automatically |
| 409 `revision_conflict`, `epoch_changed`, `instance_mismatch`, `claim_conflict`, `operation_conflict`, `cursor_stale` | Refresh/reconcile under owning rules; stale state cannot authorize a write; `cursor_stale` restarts the page sequence with visible refresh state, never retries the same cursor |
| 410 `operation_expired` | Stored retry guarantee unavailable; reconcile rather than creating a new automatic command |
| 413/422 `limit_exceeded`, `unsupported_value` | Explicit finite limits or unsupported capability; no truncation or success with dropped items |
| 429 `rate_limited` | Honor retry-after; UI shows wait/recovery; EH upstream rate state is also a task result, not necessarily HTTP API rate limiting |
| 503 `temporarily_unavailable`, `storage_busy`, `storage_full` | Bounded safe retry only; accepted/ambiguous mutations keep their operation IDs |
| 500 `internal_error` | Opaque diagnostic ID; do not expose private causes or pretend an empty result |

Single committed commands return 200/201 with versions/result; durable background submissions return 202 with task ID only after persistence. Per-item event/bulk responses use a successful envelope with explicit outcome for every supplied ID; malformed envelopes reject before processing. A disconnect after any commit can lose its reply. Network failures mean unknown outcome, never automatic rollback. The client may retry an identical mutation only within its same-epoch advertised result window; use a conservative local elapsed-time budget and query operation status after restart/clock uncertainty using the main-owned durable command-attempt record. Pre-restart mutations are not automatically resent. Unknown/expired status requires user reconciliation. Immutable open events can always be retried under their retained instance-wide identity after handshake.

Aborting HTTP/IPC reads stops interest and best-effort work. Aborting a mutation before acceptance may prevent it, but once committed it remains committed; clients query its operation/task result. Server task cancellation is an explicit command, not a disconnected browser request. [External reading](external-reading.md) exclusively defines local launch cancellation: never replay launch as an HTTP retry.

## Narrow Electron Bridge

Electron main owns credentials, authenticated HTTP clients, local filesystem/process access, and durable journals. Renderer Effect operations call a typed preload operation surface. Main dispatches only enumerated operations to the selected authenticated connection; the renderer cannot supply arbitrary URLs, headers, secrets, executable paths, SQL, or shell commands. Shared schemas describe the data on both sides without exposing service/runtime objects.

| IPC capability | Input and boundary |
| --- | --- |
| `connections.list/connect/disconnect/select` | Saved profile ID or explicit settings proposal; main handles credentials through trusted settings/native prompts and returns redacted connection status |
| `server.query/command` | Discriminated allowed API operation plus validated serializable payload/profile context; main constructs endpoint/auth/epoch and enforces command preconditions; no generic fetch proxy |
| `mapping.preview/save/remove` | Logical instance/root ID, native selection from a trusted chooser/settings proposal, mapping revision; main performs containment/comparison/overlap checks |
| `reader.profile.list/selectExecutable/save/test` | Local settings data/profile revision; selectExecutable invokes a main-owned native picker and returns a main-issued handle. Save explicitly retains the main-stored target of an existing profile by ID/expected revision, or replaces it using a new selection handle resolved and validated in main; it never accepts a renderer-supplied executable path; test requires explicit user action and is not a counted entry Open |
| `entry.checkAccess/open` | Instance/entry/profile/action IDs and expected view context; checkAccess is non-launching; Open atomically reserves the shared instance/entry active slot before asynchronous work, or returns its existing action ID/status without another dispatch. Main refreshes trusted server/cache state, resolves target, journals/dispatches once, and publishes its typed result |
| `drafts.list/load/save/discard` | Namespace/entry/form key, metadata-only values, base server context and expected local draft revision; main RecoveryStore owns persistence; reapply first refreshes server state and creates a deliberate new command |
| `commands.unresolved/list/reconcile/dismiss` | Namespace and recorded operation ID; main returns redacted attempt state, queries captured authority/current state after authentication, or explicitly dismisses diagnostics without replay/cancellation |
| `openAction.status` | Namespace plus exactly one selector: action ID for retained outcome/recovery, or entry ID for the active action ID/status (or none). Main validates namespace context; reads never launch or reserve a slot |
| `events.list/retry/export/discard` | Original namespace and event IDs; explicit discard acknowledgment, durable queue ownership stays in main |
| `thumbnail.load` | Validated instance and server-issued versioned cover/candidate-preview key; main fetches the authenticated derived-image route or permitted local cache and returns bounded image bytes/media type/key or explicit missing/updating status; no arbitrary URL input |
| `artifact.save` | Validated server artifact ID plus user-selected local destination; main validates destination separation from known collection roots under [source safety](source-safety.md), streams to an owned temporary file, verifies completeness/digest, then publishes; no renderer-controlled server path |
| `changes.subscribe/unsubscribe` | Subscription ID and allowed scope; delivery is serializable hints/status, including main-owned per-entry launch-state changes for windows in that namespace; refresh via openAction.status on subscribe/reconnect. Hints do not replace atomic Open admission; disposal does not discard durable work |

Thumbnail IPC uses bounded structured-clone byte arrays, not filesystem paths or credential-bearing URLs. The renderer creates a local Blob URL with an allowlisted image media type and revokes it on cache eviction/unmount; bounded concurrency/cache capacity prevents unbounded image buffers. Local replacement-candidate covers use indexing evidence/version policy. Remote EH candidate previews additionally require the EH preview policy; both use server-issued keys and the same derived-image size/type limits. Cross-namespace or obsolete keys cannot populate the current view. Offline cache use remains explicitly stale and policy-bound.

Validate sender frame/window and packaged app origin, not merely method names; expose individual wrapper functions rather than raw `ipcRenderer`. Keep context isolation and sandbox enabled, Node integration disabled, and deny untrusted navigation/new windows. Validate IPC at entry, then use typed values internally. Untrusted server text is never interpreted as an IPC method or path permission. Credential entry is an explicit settings workflow and values are not retained in renderer state/caches beyond the unavoidable transient input; prefer native/main-owned secret capture where supported. [Deployment](architecture.md) fixes CSP and OS credential storage details.

This refines the earlier renderer-side HTTP direction: renderer application logic still uses Effect, while the derived authenticated HTTP client runs in main. The integration prototype must exercise renderer operation -> preload -> main typed client -> independent server -> SQLite, with public errors round-tripping through both boundaries.

## Durable Task State Machine

Task records have stable ID/type/target, revision, request operation ID, captured root/gallery/config fences, status, attempt, next-attempt time, checkpoint, progress/error/result, and cancellation request. Initial statuses and transitions:

| State | Permitted next state / meaning |
| --- | --- |
| `queued` | `running` when dependencies/capacity are ready; `cancelled` before start |
| `running` | `succeeded`, `completed_with_errors`, `retry_wait`, `blocked`, `failed`, or `cancelling` |
| `retry_wait` | `queued` after delay or explicit valid retry; `cancelled` |
| `blocked` | `queued` after required configuration/auth recovery with fresh fences; `cancelled`; does not spin on permanent failures |
| `cancelling` | `cancelled` after workers stop and commits are fenced; a commit completed before cancellation remains in the recorded partial result |
| `succeeded`, `completed_with_errors`, `failed`, `cancelled` | Terminal for this attempt/task; explicit Retry creates a linked new task with fresh validation, never rewrites terminal history |

If work finished before a cancellation request acquires its fence, return Already terminal with the committed result. Otherwise record cancellation/retire work authority before signaling workers, so late results cannot commit. Completed batches/scopes remain committed and visible. A scan can finish with staged review items and a review-needed count; user decisions do not leave a worker running indefinitely. No generic pause/resume is offered initially; checkpoints support controlled retry/restart, not a promise to suspend arbitrary decoder processes.

On server start, recover nonterminal records before scheduling: prior running/cancelling jobs become interrupted diagnostics and are either queued for fresh validation, left blocked, or terminally cancelled according to the stored cancel request. Old process epochs, root scan generations, and decoder result tokens cannot commit. Interrupted scans never imply complete enumeration; keep staging/holds and start a fresh generation. Resume EH retry only with current credentials/locator and gallery fence. Reconcile temp artifacts against active tasks before cleanup.

Serialize scans per root. Coalesce only compatible intent: scans must have the same root/mode/hold flag, effective mapping revision and non-reused mapping generation, and root-policy revision; any started scan generation must still be current and not retired or cancelling. EH work must have the same gallery/credential generation. A scan requested after a mapping/policy change cannot join work captured under the old context: persist fresh work with a new scan generation when eligible, or return a visible conflict. Never return the invalidated task as successful admission of the new request; a force/hold-mode request cannot silently join an incompatible normal job. A forced-reanalysis request while a scan is active must create or coalesce a compatible durable follow-up task, return its ID, and run it after the active scan; it cannot be rejected merely because that scan is running. For other incompatible requests, persist later work or return a visible conflict, never claim the stronger request was fulfilled. Bound file I/O, decoders, SQLite writes, and EH requests separately. Temporary errors have capped exponential backoff/jitter and retry budgets that lead to visible failure/blocked state; event delivery retention/retry is separately governed by consistency and never drops pending history on task-budget exhaustion.

SSE emits scope/instance/epoch/revision hints after commit and bounded heartbeat/status. Reconnect starts a fresh handshake and current reads; `Last-Event-ID` does not promise missed-event replay. Slow subscribers receive a coalesced invalidation or reconnect instruction rather than unbounded memory growth. Periodic/focus revision checks remain required for convergence.

## Acceptance and Implementation Gates

Test schema limits, malformed cursor/filter rejection and stale-cursor restart, auth on every route/artifact and thumbnail fetch, bounded thumbnail IPC and Blob URL cleanup, instance/epoch conflicts, duplicate commands before/after expiry, partial event batches/lost replies, revision races, Stop-scanning fences, conflicting scan modes (including durable forced-reanalysis follow-up during an active normal scan), same-root/mode/hold requests after mapping or policy changes (fresh work or explicit conflict, never absorption by an invalidated task), cancellation versus commit, restart during enumeration/decoder/backup, bounded SSE subscribers, and obsolete IPC/window contexts. Verify that renderer-provided arbitrary URL/path/executable/SQL cannot bypass the allowlist and that worker termination does not publish stale results.

Before implementation, encode these discriminated shapes and routes in the selected compatible Effect API/Schema version, generate typed clients, publish an API schema snapshot, and add protocol/IPC failure fixtures. Exact error-field limits, task scheduling capacities, and artifact retention numbers require the integration/runtime measurements. No endpoints, IPC implementation, or task tests have been executed yet. [Delivery](delivery-and-validation.md) owns the acceptance record.

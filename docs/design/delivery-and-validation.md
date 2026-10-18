# Delivery Gates and Validation Plan

This topic owns implementation sequence, evidence, acceptance coverage, and release claims. The [product scope](product-scope.md) defines the required first release; the other topics own behavior. Their acceptance scenarios remain mandatory: the grouped cases below are a traceability map, not permission to omit an owning topic's cases.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Current Evidence and Meaning of Completion

This repository currently contains design documents only. No application, compiled Effect prototype, executable schema, endpoint, reader adapter, installer, or runtime test exists. Document review and checks of links, English prose, fences, headings, indexing, and whitespace establish documentation quality only. All runtime gates below are **Not run**.

Distinguish four stages:

1. **Design baseline:** coherent behavioral contracts and independent review, with empirical choices explicitly gated.
2. **Focused prototypes:** small executable experiments that settle adapters, versions, limits, and platform behavior. Provisional code and synthetic data are allowed; prototype success is not a supported application.
3. **Development milestones:** integrated features that satisfy the relevant contracts and failure cases on named development configurations. Do not present a partial milestone as the complete first release.
4. **Supported release:** every required product workflow and its applicable evidence passes on each advertised platform/configuration. Conditional formats and optional integrations are advertised only where validated.

A platform unavailable to the implementer remains unverified. A labeled development preview may be limited to measured configurations; calling the first release cross-platform requires the required desktop workflows on Windows, macOS, and Linux. Choose exact OS versions/architectures during the packaging investigation and publish them before release, without implying every Electron-supported combination works. The same standard applies separately to supported independent-server hosts.

## Dependency Gates Before Feature Implementation

"Before implementation" in the owning topics means before relying on the choice in its dependent application feature, not before writing the prototype that establishes evidence. Use the smallest vertical slice needed for each uncertainty. Run initial adapter experiments on an available development host; repeat native experiments on each target before marking that target supported. Never infer cross-platform success from a mock.

| Gate | Decisions and evidence required | Must precede |
| --- | --- | --- |
| G1 Runtime composition | Pin Node, Electron, React, TypeScript, compatible Effect packages and adapters after the [composition prototype](application-logic.md#integration-and-verification-gate). Exercise renderer -> preload -> main typed HTTP -> independent server -> SQLite worker; tagged errors, teardown, late responses, draft recovery, mutation reconciliation, tasks and resources | Application skeleton and dependent runtime services |
| G2 Persistence and protocol | Executable server/client DDL, foreign keys/WAL/FULL, serialized short transactions, exclusive lock, worker adapter, canonical command encoding, schema/IPC snapshots and discriminated errors; Phase 1 pagination/cursor limits, stale-cursor restart and live-refresh fixtures. Establish busy/checkpoint deadlines, finite journal/cache/payload limits, operation retention and crash-safe compaction through fixtures | First persisted command, scan allocation, counted Open, and API surface |
| G3 Filesystem and NAS | Native comparison/containment adapters, root activation/suspension, overlap/collision evidence, read-only source-open auditing and actual share/account/mount policy with write-denial evidence from disposable fixtures; writable-destination separation from sources, including reverse nesting, known aliases, both setup orders and link/remount revalidation before writes or cleanup; mapping revisions and non-reused generations; measure quiet interval and bounded NAS I/O | Scanning, local path resolution and writes to configured application destinations on each target |
| G4 Imaging and fingerprints | Validate ZIP/CBZ + JPEG/PNG/WebP, directory boundaries, manifests, natural ordering fixtures, exact versioned fingerprint serialization (integer widths/byte order included), optional baseline acquisition, chosen thumbnail sizes/format, finite expansion/member/byte/dimension/time/memory limits and cache cleanup | Analysis, cover generation, or use of exact fingerprint evidence |
| G5 Reader and journal | Select real reader/version per OS and directory/archive targets and directory-only first-image mode. Prove direct/association invocation, encoding, accepted-handoff classification, shutdown survival and intent/dispatch/event/ack crash cases; no shell or automatic relaunch | Counted Open on that platform |
| G6 Deployment and trust | Concrete control channel/lock/credential adapters, owner initialization/rotation, owned-child lifecycle and cleanup deadlines, authenticated loopback, same-host TLS proxy/SSE, certificate trust, keyring-unavailable behavior, CSP and IPC sender checks, secret redaction, two runtime ABIs | Exposing local/remote setup and trusted desktop capabilities |
| G7 EH integration | Sanitized real metadata/error fixtures, authorized restricted-access capability check, candidate parsing, locator/credential generations, bounded scheduler/backoff. Verify sidecars, previews, and translation terms only if adopted; canonical tags work independently | EH network features and any optional integration |
| G8 Search | Versioned normalization/ordering fixtures, cursor schema/limits, relational indexes and representative query plans; baseline literal search correctness and recorded latency/memory targets. Add an accelerator only if measurements justify it and equivalence passes | Phase 2 search/filter implementation; Phase 1 basic-list protocol checks are part of G2 |
| G9 UI | Screen-level wireframes/state examples, tested accessible primitives, public error mappings, bounded lists/images, focus/selection and namespace lifetimes | Corresponding screen implementation |
| G10 Maintenance and distribution | Concrete backup/restore/clone/export procedures, supported schema/API compatibility matrix, package formats/architectures, codec licenses, signing/notarization requirements, uninstall behavior and upgrade rollback | Maintenance availability and supported packaged releases |

G1 includes the five cases in [application composition](application-logic.md), not just a successful HTTP request. G2 must exercise actual SQLite and IPC; G3/G5 need actual native adapters and mounts. G6 is an early dependency, not postponed until final installers. Separate Electron-main and standalone-Node native builds must work in development before their features rely on them; final packaged ABI verification is repeated in G10.

Explicit configuration proposals in the owning topics, including [contracts](api-and-tasks.md), [EH](eh-metadata.md), and [persistence](data-model.md), are starting values, not missing decisions or measured performance claims. Values explicitly left unchosen still require their named prototype gate. Record chosen versions, finite capacities/deadlines and their evidence before enabling the corresponding feature. Do not replace a defined semantic rule to meet a benchmark.

## Implementation Milestones

### Phase 1: Safe File Resolution and External Reading

Deliver a development build with the independent service, owned local mode, authenticated remote profile, root setup/preview, ZIP/CBZ and image-directory indexing, covers, a basic library list, replacement/missing states, client mappings, reader profiles and durable open events. G1-G6 and the relevant G9 screens must pass on the development configuration.

The Phase 1 list uses `POST /entries/search` with empty query, no filters, default ordering and the existing cursor/library-change-revision contract. Its paging, schema limits, stale-cursor and live-refresh cases belong to G2/Phase 1; richer query/filter behavior and performance evidence remain G8/Phase 2. Do not introduce a separate unpaginated listing API.

The complete initial scan lifecycle is required here: staging, stable observations, incomplete-scan handling, retained claims, generation fences, replacement decisions, manual review holds and safe relocation/import decisions cannot be deferred if the scanner encounters those situations. Full-library fingerprint acquisition remains opt-in; exact automatic relocation requires existing comparable evidence.

Acceptance includes:

- Server mapping A and client mapping B reach the same NAS collection through the same API whether the server is local or on another LAN machine. No collection file is transferred through Henshin.
- Invalid credentials cannot read library data, covers, tasks or artifacts or submit events/settings. Independent service starts without Electron; local ownership/readiness/cleanup and remote HTTPS work.
- Root/candidate revision races, same-path replacement, changed exclusions, partial scans and NAS loss preserve identity and retained metadata/history. Pre-scan holds persist before automatic allocation; stale results cannot publish.
- Native paths handle non-Latin names, spaces and literal metacharacters; traversal, child redirection, overlap and client-only collisions are blocked according to the mapping contract.
- Only OS-accepted handoffs count. Journal failure prevents unsafe dispatch, failed launch adds no event, crash ambiguity remains Unknown, accepted events survive app exit, retry never relaunches or duplicates the count.
- Minimal instance/epoch checks, per-event outcomes, durable command attempts, lost-reply reconciliation, explicit Disconnect and isolated queues are present from the first affected operation. Basic reconnect delivery is not postponed to Phase 3.
- Initial UI shows loading/empty/error/stale/recovery states and works by keyboard. Protocol errors round-trip without credentials or native private details.

This is the first usable milestone, not the full product. Missing metadata/search and final maintenance/distribution remain visible milestone limits.

### Phase 2: EH Metadata and Search

After G7/G8 and relevant G9 work, implement explicit bindings, confirmed candidates, shared-gallery refresh, effective metadata/overrides, optional licensed aliases, literal title/basename search, tag filters, defined sorts and live pagination.

Acceptance includes partial batch failures, invalid-versus-empty source fields, credential/locator changes, rebind during refresh, carried overrides, explicit empty title, source tag removal, and stale-edit conflicts. Corrected bindings must remove the old source layer immediately; file identity/history remain unchanged. Restricted access and upstream outages retain cached data with accurate status.

Verify one-/two-character CJK queries, width/case/Unicode fixtures, literal punctuation, mixed filters and deterministic null-last ties. Responses observe coherent data/revision views, while changes between pages retain the documented live-pagination limitations. Deduplicate displayed IDs and offer refresh; never claim snapshot pagination. A stale projection or accelerator cannot silently lose matches or leak old-gallery tags.

Revision checks ship with the first editing command. Scheduled EH refresh is disabled until configured; source-network pressure is bounded across windows and tasks. Any translation/sidecar/preview capability needs its own evidence before activation.

### Phase 3: Complete Multi-device and Recovery Workflows

Broaden the already-safe Phase 1/2 foundations to the full product journeys: configurable scans/refresh, comprehensive incremental/reconciliation UI, cross-root manual relocation, two-client conflicts, server/profile switching, bounded freshness notifications and recovery views. Do not defer integrity or authentication rules to this phase.

Acceptance includes two clients each opening once yielding exactly two unique events; partial batches and lost acknowledgments; same-epoch command retry versus changed-epoch/expired ambiguity; retained drafts and command attempts across restart; and explicit Disconnect pausing work without deleting it.

Broaden the lifecycle cases already required and verified in Phase 1 through complete multi-device UI journeys; this is additional coverage, not their first integrity check. Exercise source moves during enumeration, unchanged-path replacements with and without exact baselines, manual holds across restart, incomplete-scan import confirmation, missing-claim detachment, and Stop-scanning fences. Server NAS failure must not imply that a client's independent access fails. Cached eligible Open during service outage remains partial and visibly stale.

Switching instances cannot reuse mappings, caches, drafts, task selections or pending events across namespaces. A changed URL with the same instance still requires endpoint authentication; an independent clone is not replication. Notifications are hints backed by bounded periodic/focus refresh. Cancel/commit races retain completed work, forced reanalysis creates a durable compatible follow-up, and stale workers cannot publish.

### Phase 4: Maintenance and Supported Delivery

Complete G10 and all applicable native/platform evidence. Ship documented independent-server startup and same-host TLS proxy instructions, target desktop packages, compatible schema/API versions, explicit upgrades, backup/restore, metadata export, and accessible recovery.

Acceptance includes consistent backup during writes; interrupted publication; pre-migration backup and migration failure; supported old schema upgrade and rejection of unknown/new schemas; restore with post-backup history loss and missing entries; sole-authority migration; independent clone isolation; compatible binaries plus backup for rollback; and uninstall preserving data and collection roots.

Restore, authority migration, clone preparation and backup rollback must clear copied owner verifiers and active EH credential references before serving. Reject a pre-rotation owner token even when its verifier was in the snapshot. An old EH protected version still present in the secret store cannot be reused by recovered tasks/results; explicit re-entry or reattachment creates a new immutable version/generation. Test fresh independent initialization, managed transient credentials, missing-secret errors, and continued access to stored metadata while EH is blocked.

Metadata export follows the exact versioned UTF-8 schema/private-field defaults in [persistence](data-model.md#backup-restore-and-export), uses a coherent snapshot, and excludes secret credentials and file bytes. Cover bound/unbound/missing/detached entries, explicit missing IDs, notes opt-in, overrides and counts. It is neither backup nor a re-import promise.

RAR/CBR and 7z are conditional investigations, never blockers for required ZIP/CBZ/directory support. A failed optional decoder stays unavailable in capabilities. No application-content download, forwarding, automatic mounts, embedded reader, or source-file modification is introduced by delivery work.

## Acceptance Traceability and Fixture Strategy

Every owning topic's acceptance section is part of the corresponding gate; the following groups make failures reproducible without creating a second behavioral specification.

| Area and owning topics | Required fixture families | Evidence boundary |
| --- | --- | --- |
| [Identity](entry-identity.md), [mappings](path-mapping.md) | Same-path touch/replacement; exact/unverified evidence; distinct copies; missing detach/relocation; stale decisions; case/Unicode collisions; traversal, links, UNC, overlap and root changes | Pure domain cases plus real native filesystems/NAS and concurrent transaction tests |
| [Indexing](file-indexing.md) | Mixed directories/archives; explicit ZIP directory records; unsupported pages; encrypted/corrupt/zero-page candidates; active downloads; source moved mid-enumeration; interrupted scopes; pre-scan holds; stale cover/hash output; resource limits and eviction | Small legal generated image/archive fixtures, real adapters, bounded workers and NAS interruption |
| [EH](eh-metadata.md), [search](search.md) | Sanitized success/error/malformed/batch fixtures; rebind/credential races; effective tags; ambiguous aliases; normalization, substring/filter/sort/cursor equivalence; changing live pages | Deterministic fixtures plus narrowly scoped authorized live adapter validation and measured SQL |
| [Reading](external-reading.md), [consistency](synchronization.md) | Failure and accepted handoff; intent/dispatch/event/ack crashes; unknown outcome; duplicate/conflicting events; lost replies; expiry/epoch changes; offline/cache limits; server switches; retained drafts/attempts | Actual reader/OS and SQLite journal, deterministic transport failures and two clients |
| [Persistence](data-model.md), [contracts/tasks](api-and-tasks.md) | FK/domain invariants; claim and revision races; duplicate payload conflict; disk-full/busy; task cancellation/commit; forced-follow-up; restart; limits/malformed input; SSE backpressure; online backup and recovery | Real database/HTTP/IPC/worker integration; verify durable state after each injection |
| [UI](user-interface.md), [composition](application-logic.md) | Setup, search, conflict/recovery journeys; namespace changes; virtualization focus; keyboard/screen-reader operation; scaling/contrast/reduced motion; remount/unmount and late-result guards | Rendered screens and real Electron accessibility/manual checks, plus lifecycle/resource instrumentation |
| [Deployment](architecture.md) | Owned-child startup/orphan/stall, stale rendezvous, independent reuse, TLS and redirects, token rotation/recovery, keyring failure, CSP/IPC rejection, redaction, dual ABI, signed installs/upgrade/uninstall | Actual processes, OS credential backends, packaged builds and deployment recipe |

Use immutable small fixture manifests recording IDs, relevant filenames/stats/bytes, versions, action order and expected persistent outcomes. Deliberate same-size/time edits illustrate observation limits; do not turn them into a claimed detection guarantee. Hash/order fixtures must be shared by producer and consumer implementations. Synthetic fixtures use neutral generated content, no upstream account secrets or private collection files.

Test pure rules cheaply, but do not replace actual SQLite/filesystem/IPC/process boundaries with in-memory substitutes for their acceptance claims. Use deterministic clocks/barriers/fault injection for races; inspect state after crash/restart, not only return codes. Inject cancellation before and after commit/dispatch to prove the distinction. A fixture may satisfy multiple rows when its evidence explicitly covers each assertion.

Live EH checks use valid operator access and conservative request policy; offline fixtures support repeatable CI. Required credentials, private library samples, signing identities or unavailable OS hosts are obtained at the dependent gate, not invented or embedded in the repository. No automated upstream issue/message is implied by selecting a dataset; any required communication needs explicit authorization.

## Platform and Capability Matrix

The following is the initial **target matrix**, with every row currently **Not run**. An evidence record must name exact OS/version, architecture, runtime versions, storage protocol/filesystem, native adapters, reader/version and package artifact; a generic "Windows passed" is insufficient.

| Target | Required native/platform evidence | Release decision |
| --- | --- | --- |
| Windows desktop | Drive and UNC mapping; actual case/Unicode behavior and junction rejection; direct and association launch; directory/archive targets and directory-only first-image modes; process lifetime; credential backend; keyboard/screen reader; installer and Electron ABI | Advertise only tested versions/architectures and reader capabilities |
| macOS desktop | Actual volume case behavior and NAS mounts; symlink boundary; reader app/association and lifetime; credential backend; accessibility; application/DMG, required signing/notarization and Electron ABI | No support claim from an unsigned development build alone |
| Linux desktop | Actual mounts/case behavior; direct/association launch and lifetime; functioning keyring and explicit session-only mode when unavailable; accessibility; AppImage and Electron ABI | Record tested desktop environment, credential backend and distribution requirements |
| Independent server on each advertised host | Standalone Node ABI, local SQLite lock/backup, native codecs, service-account NAS access, foreground startup, stop/restart, same-host TLS proxy/SSE and secret permissions | Publish tested host/runtime recipe; OS service-manager integrations only when exercised |
| Mixed client/server topology | At minimum one remote server with Windows/macOS/Linux clients using different mappings, plus managed-local mode on every supported desktop; two clients concurrently | Proves storage/deployment independence without claiming every possible OS/NAS pair |
| Upgrade and compatibility | Clean install, supported prior client/server/schema combinations, wrong API major, interrupted upgrade, restore rollback, uninstall preservation | Publish exact compatibility combinations and unsupported versions |

Named native failures are not papered over by accepting unsafe paths, disabling TLS verification, silently storing Linux credentials as plain text, or using shell expansion. Fail the affected capability clearly. A failed required capability blocks support for that configuration; an optional capability may remain disabled with explicit documentation.

The format matrix begins with ZIP/CBZ and direct-image directories containing JPEG/PNG/WebP as required. RAR/CBR, 7z, GIF/AVIF and other page decoders are unvalidated extensions. Recognized unsupported suffixes and mixed-page rejection follow [indexing](file-indexing.md); nested archives are not pages. Record decoder/runtime/license, encryption/corruption handling, resource-limit cases and per-platform results before extending capabilities. Not recognizing arbitrary unknown-extension data is an explicit discovery limit.

## Performance and Resource Evidence

No library capacity, query latency or NAS throughput promise is established yet. Start with small deterministic correctness fixtures, then labeled synthetic metadata/library workloads covering different entry counts, page/member distributions, nested paths, long titles/tags and high collision/duplicate rates. Use a permitted, privacy-preserving representative real NAS sample before accepting performance targets.

Record CPU/RAM/storage, network/NAS protocol and latency, dataset count/bytes, page formats, cache warmth, concurrency and exact application/dependency revision. Measure separately:

- Initial discovery time to first entries, complete enumeration, cover readiness and peak memory.
- Unchanged incremental scan, changed candidate analysis, quiet-interval behavior and interruption recovery.
- Opt-in baseline hashing and change-triggered verification throughput, separate from fast discovery.
- First and later query pages for short/long CJK, combined tags, empty/missing sort keys and concurrent metadata/open updates; query plans and latency distribution.
- UI list/image memory, focus responsiveness and main/server event-loop delay while workers run.
- Event delivery/reconciliation, task cancellation, subscriber backpressure, owned-child cleanup and worker resource bounds.

Before dependent feature implementation, record provisional budgets for the available representative workload with actual measured justification; reassess on integrated packaged builds. Unknown real-library dimensions remain an input needed at that gate, not a fabricated universal benchmark. Tuning may change concurrency/cache sizes; it cannot weaken identity, search membership, event durability, authentication or containment.

## Evidence Records and Release Decision

Create versioned records under `docs/validation/` when experiments begin; do not create empty reports that look like executed tests. Each record contains:

- Gate/case IDs and owning contract revision; feature/build commit and dependency lockfile or exact prototype versions.
- Fixture manifest/digest, platform/runtime/NAS/reader/credential/proxy details, commands or reproducible steps, expected outcomes and fault-injection points.
- Actual outcomes and measurements, sanitized log/artifact references, date and executor; private raw evidence stays outside the public repository.
- Status: Not run, Pass, Fail, Blocked (with missing external input), or Not applicable (with scope justification). Record limitations and a concrete follow-up for failures.

Only actual evidence can change runtime status. A design reviewer PASS, successful compile, mock test or one platform's result cannot stand in for another gate. A version/adapter change invalidates dependent evidence where its behavior could change; rerun affected checks, not every unrelated experiment mechanically.

A milestone review confirms its prerequisites and all applicable acceptance cases, links evidence, and records remaining later scope. A release review additionally confirms all required [product scenarios](product-scope.md#release-scenarios-and-observable-success), the advertised platform/format/API matrix, accessible failure recovery, maintenance/upgrade instructions, required signing/licenses, and performance/resource budgets. No unresolved data-loss, authentication, containment, duplicate-launch/counting or required-workflow defect can be waived as an optional follow-up.

Later implementation evidence may require amending an earlier design. Make the smallest coherent cross-topic change, document the reason and affected contracts in its PR, and re-review the affected rules. Preserve historical review verdicts as claims about their recorded revisions. The stacked documentation PRs remain separate review units; completing this plan does not merge them or authorize a release announcement.

## Source-protection Gate Addendum

The [NAS source-safety acceptance cases](source-safety.md#acceptance-and-release-evidence) are mandatory for affected features. G3 establishes read-only native access, observed/account/mount policy and disjoint writable destinations; G6 establishes process, authentication and IPC trust; G4 audits decoder/helper writes and failure fallbacks; G5 tests real reader behavior under denied source writes; G10 tests backup, restore, retention and uninstall boundaries. Use disposable fixtures for write-denial tests and operation auditing, never a production collection. Status: **Not run**. Read-only native access, decoder/helper behavior, reader protection, permissions and source/output separation apply from Phase 1. Maintenance/retention/uninstall cases gate their own features under G10/Phase 4; they are not prerequisites for features absent from Phase 1.

## Backup and Archival Recovery Gate Addendum

The [backup and recovery acceptance cases](backup-and-archive.md#acceptance-and-evidence) refine G10/Phase 4 for rotating/archive classes, coherent configuration capture, bounded containers, destination verification/publication, orphan reconciliation, disk-full and pruning safety, restore-induced policy suspension, stopped desktop backups and isolated drills. G2 still proves the SQLite backup/rollback mechanism before migrations rely on it. Server backup cannot stand in for desktop-journal or external NAS-content backup. Record actual recovery results and time instead of inferring them from file creation; all added runtime gates are **Not run**.

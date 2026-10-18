# Product Scope and Release Scenarios

Henshin makes an externally managed collection searchable and keeps its metadata and opening history together. This topic owns confirmed requirements, proposed first-release defaults, release boundaries, and end-to-end success scenarios. Detailed behavior remains in the linked owning topics; this document does not replace their failure and integrity rules.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Confirmed Requirements

- A cross-platform desktop application with an independent client/server architecture. The server can run on the desktop's machine or another machine.
- Electron with React and TypeScript for the desktop. Effect is preferred for backend and frontend application logic.
- Collection storage and server location are independent. The current collection is on a NAS; server and desktop may mount the same content at different native paths.
- File indexing, thumbnails, EH information/tags and updates, search, and open counts.
- Reading invokes an external reader locally. No embedded reader is required.
- Shared library metadata and open events are synchronized across clients of the authoritative service.
- Design documentation is English and organized into separate topics.

The NAS scenario does not require the service to run on the NAS, and a remote service does not imply remote file delivery. The server must be able to read collection files to index them; each desktop needs its own access to open them. Mounts and share credentials are managed by the operating system.

## Proposed First-release Defaults

These are design decisions for a coherent initial release, not additional confirmed user requirements:

| Decision | Default and reason |
| --- | --- |
| Audience | One user across several desktops; no accounts, roles, sharing invitations, or per-user history partitioning |
| Authority | One authoritative server per connection; several saved connections may be switched, but their libraries and event queues stay separate |
| Visible library | One visible library per server, containing multiple storage roots; initialize its stable ID with the server, without library creation/deletion/switching UI inside that instance |
| Storage ownership | Read-only collection access; changes to filenames, archives, and folder organization remain external to Henshin |
| Service stack | Independent Node/TypeScript + Effect HTTP direction and SQLite on server-local disk; package/adapter validation is required |
| Disconnected use | Browse the explicitly partial display cache and attempt Open for eligible cached entries; no offline metadata edits, full-library search promise, or distributed merge |
| Opening statistics | Count OS-accepted Henshin handoffs per entry across devices, not actual reading, completion, duration, or launches made outside Henshin |
| Scanning and refresh | Manual operations first; configurable schedules are disabled until configured; server scans and EH refresh are separate workflows |
| Removal | No source-file deletion, hard entry deletion, entry merging, or transfer of old history onto a replacement edition |

Library IDs remain in contracts to scope roots and events coherently, but multiple user-visible libraries are deferred. Existing same-library relocation rules still apply. An independent server is a separate namespace, not another tab onto automatically synchronized data. Future multi-user or multi-library support requires a separate scope decision and cannot be inferred from existing IDs.

## First Release, Conditional Support, and Exclusions

| Area | Required first-release behavior | Conditional or later work |
| --- | --- | --- |
| Setup | Desktop-managed local service or authenticated remote connection; client root mappings independent of server mappings | Docker image optional after packaging validation; hosted service and automatic LAN discovery deferred |
| Indexing | Manual/scheduled incremental scans, exclusions, progress/errors, staged reconciliation, retained missing/pending/detached records, explicit relocation/replacement decisions | Similarity-based recommendations and file organization deferred |
| Formats | ZIP/CBZ and image directories with JPEG/PNG/WebP pages; unsupported/encrypted/corrupt content receives explicit diagnostics | RAR/CBR and 7z only after adapter/license/platform validation; PDF/EPUB/nested archives deferred |
| Covers | Server extraction/cache, local display cache, optional user-selected page, content/version-aware invalidation | Full-page browsing and per-page thumbnail grids are outside scope |
| EH | Explicit URL binding, confirmed candidate selection, shared-gallery metadata refresh, corrections, separate personal overrides | Automatic ambiguous binding, other metadata sources, EH favorites synchronization deferred |
| Tags/search | Canonical namespaced tags, local tags, effective-tag include/exclude filters, title/basename literal search, short CJK support, defined sorts/live pagination | Advanced query language, semantic recommendations, OCR, and content-text search deferred |
| Tag aliases | Chinese aliases when the chosen translation dataset and license permit distribution; canonical identity remains usable without aliases | Additional translation providers/languages are extensions; no translation service credential requirement |
| Reader/history | Local profiles, direct executable/association modes, archive/directory/first-image targets, accepted-event history and pending diagnostics | Reader progress telemetry, history editing/deletion, manual count correction, and untracked Open mode deferred |
| Consistency | Conditional edits, per-event deduplication, bounded refresh, isolated connection caches/queues, migration/clone/restore semantics | Independent-server replication and offline edit merging deferred |
| Maintenance | Consistent backup/restore, task controls, diagnostic errors, metadata export | External plugin framework, content backup, bulk source cleanup, and automatic upgrades across incompatible schemas deferred |

Conditional archive support must be advertised per validated capability; it cannot silently become a first-release dependency. Unsupported pages in an otherwise recognized container follow [indexing](file-indexing.md), rather than being silently dropped. Restricted EH access requires the operator's valid credentials and upstream availability; the core library remains usable when source refresh is blocked. [EH integration](eh-metadata.md) owns source policy, translation licensing, and failure distinctions.

Content downloads, replication, server-side collection forwarding, automatic NAS mounts, embedded readers, and modifying source archives are outside scope. Derived covers and metadata are application data, not a promise to make collection content available without the NAS. Export is metadata-only and excludes credentials, executable profiles, and file bytes by default; schema and private-field handling belong to persistence/contracts. Backup covers application state, not the user's collection itself.

## Release Scenarios and Observable Success

| Scenario | Observable outcome and owning contract |
| --- | --- |
| Same-machine service, NAS collection | Configure server root A and client root B once; scan creates searchable entries/covers; Open launches the desktop's reader against B. [Indexing](file-indexing.md), [mappings](path-mapping.md), [reading](external-reading.md) |
| Move service to another LAN machine | After controlled migration, the same entry IDs/overrides/history remain; clients keep their mappings and authenticate the new endpoint. [Consistency](synchronization.md) |
| Second desktop joins | After its own mapping/profile setup, it sees server metadata/history and contributes unique events without accessing the database directly. [Consistency](synchronization.md) |
| Bind and refresh EH metadata | A user confirms the source; refresh updates source fields while retaining local title/tag decisions. Failure preserves last-known data with status. [EH](eh-metadata.md) |
| Find a short CJK title or combined tags | One-/two-character literal matches work; canonical tag filters and deterministic order follow the specified rules. [Search](search.md) |
| NAS unavailable to server but available to desktop | Library remains searchable while service is up; accepted entries may open locally without treating server status as client access proof. [Identity](entry-identity.md), [search](search.md), [reading](external-reading.md) |
| Service offline but NAS available | Only cached eligible entries can open with stale status; queued events later deduplicate. No complete offline search claim. [Reading](external-reading.md), [consistency](synchronization.md) |
| External move or same-path replacement | Evidence and explicit decisions preserve or split identity correctly; old history never follows a filename automatically. [Identity](entry-identity.md), [indexing](file-indexing.md) |
| Conflicting edits or partial event upload | Preserve unsaved intent, show conflicts/per-event outcomes, and retry only safe operations. [Consistency](synchronization.md) |
| Restart, restore, or independent clone | Epoch/namespace rules prevent stale commands and queue reassignment; restore limitations are visible. [Consistency](synchronization.md), [persistence](data-model.md) |

Each required workflow must include usable loading, empty, error, stale, and recovery behavior, not just its successful screenshot. Keyboard navigation, readable focus, labels, and status semantics are baseline desktop requirements in [UI](user-interface.md). Collection titles, tags, thumbnails, local paths, and credentials are private data; logging and export defaults must not expose them unnecessarily. No online analytics is required for product operation.

## Release Readiness and Remaining Evidence

The first usable implementation milestone is narrower than a complete first release: it proves scan, cover, mapped Open, and durable event handoff together with required authentication and replacement-identity handling. This summary does not waive any Phase 1 acceptance criterion. Metadata/search, reconnect/conflict handling, and final maintenance/packaging follow in dependency order. [Delivery](delivery-and-validation.md) defines phases and must distinguish development milestones from supported release claims.

Target platforms are Windows, macOS, and Linux; Electron alone does not establish functional parity for mounts, filesystem names, native dependencies, or reader invocation. Release capability statements must be backed by the platform matrix. Package/native-adapter choices and signing/distribution procedures remain implementation gates, with explicit unsupported combinations when necessary.

Representative library size, directory layout, NAS latency, and preferred readers are currently unknown. Use labeled synthetic fixtures plus a privacy-preserving representative real sample before accepting performance or compatibility targets; do not invent a capacity promise. These measurements refine tuning, not the already-defined identity or search semantics. No unresolved preference prevents completing the behavioral design, and defaults remain revisable when real evidence warrants a change.

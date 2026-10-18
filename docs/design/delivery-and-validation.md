# Delivery and Validation

This document owns implementation order, acceptance criteria, platform coverage, and focused technical investigations. Topic documents own the behavior each phase must implement.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Implementation Phases and Acceptance Criteria

### Design and Integration Gates

Design refinement order and implementation phases are separate. UI journeys may inform contracts before code is written. Each implementation phase starts only after its required behavior, minimal schemas/contracts, and transaction boundaries are specified.

- Before Phase 1 application implementation, settle storage-root ownership, entry identity including same-path replacement, and the minimum scan/open/event contracts. Run the focused Effect, SQLite, and reader-launch integration prototype, then pin the compatible packages it exercises.
- Specify fingerprint serialization, discovery/staging transactions, stable-observation interval, supported page formats, thumbnail profile, and finite decoder limits before scan/analysis implementation. Measure fast discovery separately from opt-in full verification; lack of a full fingerprint disables automatic identity matching rather than blocking cover discovery.
- Phase 1 also requires the minimal local/LAN authentication flow and HTTPS setup for remote connections. Validate independent server startup, desktop-managed local startup, and required native dependencies in the development build; final installers remain Phase 4 work.
- Before Phase 2 search implementation, define short Chinese and Japanese query behavior and choose an index/tokenizer approach using a representative sample. Specify revision checks before exposing metadata edits.
- Before migration, restore, or clone implementation, specify the identity-preservation/isolation procedure, backup-point limitations, cache refresh, and pending-event reconciliation.

Exploratory prototypes may use provisional adapters to answer these questions. They are not completed Phase 1 application implementation, and their results must be reflected in the selected dependencies and contracts before dependent features are built.

### Phase 1 File Resolution and External Reading

Build a minimal client and independent server with root configuration, image-directory and ZIP/CBZ scanning, a basic list, covers, path mappings, reader launch, and open events.

Acceptance criteria:

- A server using path A and a client using path B can open the same NAS file. Cover drive letters, UNC paths, and Unix-like mount paths.
- Local and LAN deployments use the same API and location model without transferring content through the server.
- Local connections use credentials and remote connections use authenticated HTTPS. Missing or invalid credentials cannot access library details, covers, settings, or event submission.
- The server runs without Electron, and the desktop can start and connect to its local server in the development build with the selected native dependencies.
- Root configuration includes mapping revision protection in Phase 1: stale configuration edits are rejected, concurrent overlap cannot activate, and old-mapping scan results cannot commit. Metadata-edit revision checks remain a separate Phase 2 requirement.
- Chinese and Japanese names, spaces, and special characters are passed correctly. Paths outside configured roots are rejected.
- Failed reader launches do not increase counts. Resubmitting the same event after a successful launch does not count twice.
- Replacing a file at an unchanged path cannot silently transfer the old edition's binding, overrides, or history. Verify both a confirmed same-edition representation change and an unresolved replacement using the identity rules settled before implementation.
- Verify actual launch and file access on Windows, macOS, and Linux. Explicitly leave unavailable platforms unverified.

### Phase 2 EH Metadata and Organization

Implement URL binding, batch metadata retrieval, tag search, local overrides, candidate confirmation, and background refresh. Revision checks ship with the first metadata editing commands, including binding corrections, because multiple clients can already connect.

Acceptance criteria:

- Explicit URLs can be bound. Multiple candidates do not silently resolve to the first result.
- One gallery failure does not discard successful results in the same batch. Authentication expiry and rate limiting are recoverable.
- Source tag additions and removals update search while retaining local overrides. Corrected bindings do not retain tags from the old source.
- Language editions with identical titles remain separate. A newer gallery version does not change an existing file's binding.
- An edit based on a stale revision cannot silently overwrite a newer edit from another device or window, for either overrides or binding corrections.
- Title and filename search, including one- and two-character Chinese and Japanese cases, follows the query semantics selected before implementation and passes the representative functional sample.

### Phase 3 Multiple Devices and File Changes

Complete incremental scanning, relocation, queued event delivery after reconnecting, and change refresh. Extend the revision protection delivered in Phase 2 to the broader reconnection and multi-device acceptance scenarios.

Acceptance criteria:

- One open from each of two clients adds two events in total. Batch retries and reconnects do not double-count them.
- Reconnecting clients refresh their view without bypassing the revision checks already required by Phase 2.
- NAS disconnection or scan failure does not clear the library. Clients can still attempt to open files when their own access works but the server's does not.
- Reliable matching or manual relocation preserves entry IDs and history after files move.
- Switching servers does not mix mappings, caches, or pending events.

### Phase 4 Formats and Delivery

Validate RAR/CBR and 7z support, package all three desktop platforms, prepare remote server deployment, implement backup, restore, and metadata export, and check performance with a representative library.

Acceptance criteria:

- Packages install and run independently on their target platforms. The format support matrix matches actual validation.
- Corrupt or encrypted archives report errors while processing continues for other files.
- Backup and restore retain entries, bindings, overrides, and open history present at the backup point. Thumbnails can be regenerated.
- Metadata export produces a readable artifact matching the format and field scope specified before implementation. Validate representative bound and unbound entries, source metadata, and local overrides against that contract; exclude credentials. Export is not a database backup or a promise of re-import support.
- A migration has only one active authority and preserves the namespace used by mappings and events. An independent clone has a new namespace and cannot silently consume the original client's pending events. Restore checks acknowledge the backup point and missing-entry reconciliation rules.
- Measure initial and incremental scans, short Chinese queries, combined tag queries, and recovery from NAS interruptions using actual samples. Record the environment and dataset size.

## Inputs Needed Before Implementation

- Select representative external readers and argument formats for each target system; verify direct opening of directories and archives.
- Determine required first-release archive formats and decoders, including packaging and distribution conditions on all three platforms.
- Identify existing downloader metadata formats and implement only the imports that are needed, prioritizing formats with explicit source URLs.
- Obtain representative library sizes and directory samples to establish scan defaults and measurable performance targets.
- Validate the Effect integration described in [Application logic with Effect](application-logic.md), then pin compatible HTTP, React, and SQLite adapters before implementation.

Unresolved topics that do not affect a phase may remain open. Use the gates above to distinguish exploratory prototypes from application implementation; unresolved prerequisites do block their dependent features.

## Open Design Questions

- What representative libraries and target machines will be used to measure scan, query, and recovery behavior?
- What installation formats, server deployment instructions, and upgrade procedures are required for each platform?
- Which investigations must precede implementation, and what evidence will settle decoder, search, and reader-integration choices?

## Related Topics

- [Product scope](product-scope.md) defines release boundaries. [Architecture](architecture.md) owns deployment choices. All topic documents are linked from the [design overview](../design.md).

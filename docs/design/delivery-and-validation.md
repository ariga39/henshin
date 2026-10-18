# Delivery and Validation

This document owns implementation order, acceptance criteria, platform coverage, and focused technical investigations. Topic documents own the behavior each phase must implement.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Implementation Phases and Acceptance Criteria

### Phase 1 File Resolution and External Reading

Build a minimal client and independent server with root configuration, image-directory and ZIP/CBZ scanning, a basic list, covers, path mappings, reader launch, and open events.

Acceptance criteria:

- A server using path A and a client using path B can open the same NAS file. Cover drive letters, UNC paths, and Unix-like mount paths.
- Local and LAN deployments use the same API and location model without transferring content through the server.
- Chinese and Japanese names, spaces, and special characters are passed correctly. Paths outside configured roots are rejected.
- Failed reader launches do not increase counts. Resubmitting the same event after a successful launch does not count twice.
- Verify actual launch and file access on Windows, macOS, and Linux. Explicitly leave unavailable platforms unverified.

### Phase 2 EH Metadata and Organization

Implement URL binding, batch metadata retrieval, tag search, local overrides, candidate confirmation, and background refresh.

Acceptance criteria:

- Explicit URLs can be bound. Multiple candidates do not silently resolve to the first result.
- One gallery failure does not discard successful results in the same batch. Authentication expiry and rate limiting are recoverable.
- Source tag additions and removals update search while retaining local overrides. Corrected bindings do not retain tags from the old source.
- Language editions with identical titles remain separate. A newer gallery version does not change an existing file's binding.

### Phase 3 Multiple Devices and File Changes

Complete incremental scanning, relocation, queued event delivery after reconnecting, change refresh, and concurrent edit handling.

Acceptance criteria:

- One open from each of two clients adds two events in total. Batch retries and reconnects do not double-count them.
- An edit based on a stale revision cannot silently overwrite a newer edit from another device.
- NAS disconnection or scan failure does not clear the library. Clients can still attempt to open files when their own access works but the server's does not.
- Reliable matching or manual relocation preserves entry IDs and history after files move.
- Switching servers does not mix mappings, caches, or pending events.

### Phase 4 Formats and Delivery

Validate RAR/CBR and 7z support, package all three desktop platforms, prepare remote server deployment, implement backup and restore, and check performance with a representative library.

Acceptance criteria:

- Packages install and run independently on their target platforms. The format support matrix matches actual validation.
- Corrupt or encrypted archives report errors while processing continues for other files.
- Backup and restore retain entries, bindings, overrides, and open history. Thumbnails can be regenerated.
- Measure initial and incremental scans, short Chinese queries, combined tag queries, and recovery from NAS interruptions using actual samples. Record the environment and dataset size.

## Inputs Needed Before Implementation

- Select representative external readers and argument formats for each target system; verify direct opening of directories and archives.
- Determine required first-release archive formats and decoders, including packaging and distribution conditions on all three platforms.
- Identify existing downloader metadata formats and implement only the imports that are needed, prioritizing formats with explicit source URLs.
- Obtain representative library sizes and directory samples to establish scan defaults and measurable performance targets.
- Validate the Effect integration described in [Application logic with Effect](application-logic.md), then pin compatible HTTP, React, and SQLite adapters before implementation.

These choices do not prevent starting with a minimal workflow for path mapping, an independent server, and external opening.

## Open Design Questions

- What representative libraries and target machines will be used to measure scan, query, and recovery behavior?
- What installation formats, server deployment instructions, and upgrade procedures are required for each platform?
- Which investigations must precede implementation, and what evidence will settle decoder, search, and reader-integration choices?

## Related Topics

- [Product scope](product-scope.md) defines release boundaries. [Architecture](architecture.md) owns deployment choices. All topic documents are linked from the [design overview](../design.md).

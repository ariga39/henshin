# File Indexing and Thumbnails

This document owns entry discovery, directory boundaries, file-change detection, relocation, and thumbnail generation. Path resolution is specified separately.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Scanning and Thumbnail Workflow

1. Load the storage root configuration and check accessibility. If the root is unreachable, mark it offline without marking all entries as deleted.
2. Enumerate allowed formats and directories, skipping exclusions and temporary downloads. Defer analysis of files that are still changing.
3. Compare recorded paths, sizes, and modification times to create or update analysis tasks. Normal scans use incremental checks; forced reanalysis handles content replacements that preserve modification times.
4. Analyze candidates and record formats, local page counts, and cover candidates. Sort images naturally; the presence of a cover image must not cause the entire library root to be treated as one book.
5. Generate cover thumbnails and update entries when complete. Invalidate cached thumbnails by content version and cover selection. Do not cache content files on the client.
6. Reconcile missing entries only within fully and successfully enumerated scopes. Preserve previous states for scopes affected by permission errors or interrupted scans, and show the scan error.

Default entry boundaries: one archive is one entry; a directory directly containing images can be an entry without recursively absorbing images from subdirectories. Evaluate nested directories separately. Provide a scan preview or exclusions for mixed content to avoid combining multiple books into one entry.

Rename and move detection uses existing content fingerprints where available. Reassociate a location when the match is unique and reliable; retain candidates and allow manual relocation when evidence is insufficient or multiple identical copies exist. Size and modification time alone do not guarantee recognition of all later moves.

Reanalysis of a changed file does not by itself authorize reuse of its entry identity. At an unchanged path, distinguish an established update to the same edition from replacement by another edition before applying new analysis to the accepted entry. Preserve prior bindings, overrides, and open history when identity is uncertain instead of silently carrying them onto replacement content. The resolution workflow and behavior of Open while a replacement is unresolved are prerequisites for the first file-update implementation, jointly owned with [Data model](data-model.md) and [External reading](external-reading.md).

Archive processing reads only the required directory and image entries and limits resource consumption. Malformed archives, path traversal, encryption, or corruption produce entry-level errors. A single file failure does not stop processing the library. Decoders, temporary resources, and distribution arrangements for RAR and 7z will be determined during format validation.

## Open Design Questions

- What exact rules identify image-directory entries when images, archives, and subdirectories coexist?
- When are fingerprints computed, which contents do they cover, and what evidence permits automatic relocation?
- What evidence distinguishes a representation change from another edition at the same path, and how does the user resolve uncertainty without misattributing history?
- Which image formats, cover selection rules, thumbnail dimensions, and cache limits are required?
- What file-stability checks, scan schedule, and cancellation boundaries are appropriate for the actual NAS?

## Related Topics

- [Path mappings](path-mapping.md) supply filesystem locations. [Data model](data-model.md) owns entry identity. [API and tasks](api-and-tasks.md) owns scheduling and recovery. [Delivery](delivery-and-validation.md) owns format validation.

# Source Manifest Prototype Evidence

Status: **Focused bounded prototype evidence** for exact commit
`8887d0d81168f084a8ee6fdb1d1121434d78233c`. This is a G3/G4 precursor, not
completion of either gate or of the production indexer.

## Scope

The isolated server analysis service inspects one trusted local regular-file
ZIP/CBZ or one direct-image directory in read-only mode. It returns a complete
naturally ordered manifest of direct JPEG, PNG, and WebP pages, or a typed
candidate error. Directory children, nested archives, sidecars, and unknown
extensions are outside the page manifest. Recognized unsupported page formats
produce an unsupported-pages error with bounded diagnostic counts rather than
partial success.

Archive enumeration uses `@zip.js/zip.js` 2.24.0. Its maintained
`checkOverlappingEntryOnly` path is invoked with an inert writer and the
cooperative signal to validate local-header, data-descriptor, entry-range, and
overlap structure without deliberately streaming or decompressing page
payloads. Central-directory tail reads are bounded and may incidentally
include payload bytes. One instrumented large stored-member fixture showed no
payload-overlapping read for that fixture; this is not a universal zero-payload
read claim. The manifest does not claim page decode validity or CRC validation.

Names are preserved as decoded member names, with CP437 and declared UTF-8
handling supplied by zip.js. Unsafe names, lossy decoding, exact duplicates,
encryption, malformed structure, archive page-suffixed symlinks, zero pages,
and finite-limit violations are rejected. Directories use lossless buffer-name
enumeration and reject page-suffixed symlink children. Natural ordering is
tested with numeric runs, zero padding, Unicode, case, normalization, nested,
and backslash-name fixtures.

## Finite defaults

| Limit | Default |
| --- | ---: |
| Archive bytes | 4 GiB |
| Entries or direct children | 100,000 |
| Manifest pages | 20,000 |
| Name and metadata accounting | 32 MiB |
| Central-directory/read allocation | 64 MiB |
| Cumulative declared uncompressed bytes | 8 GiB |
| One member's declared uncompressed bytes | 1 GiB |
| Cooperative deadline | 30 seconds |

The deadline is checked between bounded filesystem reads, enumeration, sorting,
and final observations. Native filesystem I/O is not hard-preemptible; no NAS
deadline or stalled-I/O guarantee is claimed. Interruption is wired through
Effect and the caller signal, and an instrumented local fixture proves that the
interrupted fiber does not complete until its owned file handle close settles.

## Executed evidence

Primary independently accepted the exact candidate commit with:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass |
| `pnpm test` | Pass; 80 Vitest tests and 5 Electron tests |
| Read-only sample probe | 3 ZIP/CBZ samples; aggregate 726014572 bytes; complete manifests of 148, 201, and 299 pages |

The sample probe recorded process-inclusive times of 128 ms, 150 ms, and 149
ms. Its before/after source observations were unchanged size and mtime only;
they do not establish quiet-interval stability or snapshot semantics. Sample
filenames, paths, and contents are intentionally not recorded.

Synthetic fixtures also cover unsafe names, CP437 and malformed UTF-8,
Unicode-path extras, exact duplicates, unsupported-only and mixed pages,
encryption, empty candidates, local-header corruption, invalid central member
offsets, overlapping entries, page symlinks, limits, cancellation, direct
source links and changes, direct-name boundaries, natural order, and source
write auditing.

The write audit covers only the instrumented `FileHandle` opens, `writeFile`,
and source inventory used by these tests. It is not an audit of every native
write capability. This evidence makes no production API, indexer, decoder,
CRC, fingerprint, cover, full-G3/G4, platform, NAS, or NAS-permission claim.

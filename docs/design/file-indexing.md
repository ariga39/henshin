# File Indexing and Thumbnails

This topic specifies discovery, analysis, reconciliation, fingerprint evidence, and cover generation. It follows [entry identity](entry-identity.md) and [path mapping](path-mapping.md); scanning never modifies collection files. Defaults below are proposed pending representative library measurements. Concrete decoder packages and database/task schemas belong to their later topics.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Scan Modes and Entry Boundaries

The server scans through its active mapping. Clients do not scan the NAS for the shared index; their local resolution checks remain independent. The first release provides manual root scans, a configurable per-root schedule, and explicit forced reanalysis. The default schedule is disabled until configured. Filesystem watchers may later trigger reconciliation but are not required for correctness, especially on network shares.

One supported archive is one discovery candidate. A directory becomes a candidate only when it directly contains at least one supported image; its child directories are evaluated separately. Do not recursively absorb their images into the parent entry. Images, archives, and child image directories can coexist: the direct images form the directory entry, and each archive/child forms its own candidate. Root-level loose images are reported as unassigned because the logical path model requires a child entry path. Show a preview with candidate boundaries and allow directory/file exclusions before confirming the first scan.

Initial source formats are image directories and ZIP/CBZ. JPEG, PNG, and WebP are the initial page formats; whenever a page is decoded, validate its actual content rather than trusting the extension. GIF/AVIF and other page formats, RAR/CBR, and 7z remain validation-dependent extensions, not silently accepted partial books. Ignore non-page sidecars for page analysis, but report unsupported image-like files so a candidate is not presented as fully analyzed while known pages were omitted. Nested archives are not unpacked as pages. [Delivery](delivery-and-validation.md) records the format matrix and decoder gates.

For archives, inspect members without extracting the entire archive. Supported pages can occur in member subdirectories. Reject unsafe member names (absolute paths, traversal, backslashes, NUL, duplicate normalized names) and encrypted/corrupt content as candidate-level errors. Source filenames follow the portable path rules; archive member names are decoder identifiers, never native output paths. Thumbnail files are written only under a server-controlled cache name.

## Pipeline and Positive Results

| Stage | Durable result | Failure behavior |
| --- | --- | --- |
| Enumerate | Scan generation, mapping revision, paths and lightweight observations, scope completion/error markers | Keep previous accepted entries; failed scopes cannot imply absence |
| Analyze | Staged candidate, stable observation token, format/page manifest, page count and cover result or errors | Preserve the old accepted analysis; report a retryable or unsupported candidate |
| Reconcile | Decisions for unchanged claims, replacements, missing paths, and new/moved candidates | Conditional transactions reject obsolete mapping/location/candidate revisions |
| Derive | Thumbnail variants and search/file-facet refresh for accepted content versions | Retry independently; a cover error does not delete the accepted entry |

Use one active enumeration/reconciliation generation per root. Coalesce repeated triggers; an explicit stronger mode (forced reanalysis) schedules a follow-up rather than changing the meaning of in-flight work. Enumerate with bounded asynchronous I/O, persist progress in batches, and limit concurrent archive/image work separately from EH tasks. Exact limits are configuration backed by measured defaults before implementation, not promises about NAS throughput. [Task contracts](api-and-tasks.md) own concrete states and cancellation checkpoints.

Read the root's active mapping revision before starting. A changed mapping, disabled root, cancellation, or stale task cannot publish absence or accepted-analysis results from the old generation. Recheck revision and claim ownership when committing. Retain task errors and the most recent successful observations; restarting resumes/retries staged work only after fresh validation, never by treating interrupted enumeration as complete.

Normal scans compare path, kind, size, and modification time; image directories also compare their direct page-name/stat manifest. A change schedules analysis. No detected change reuses accepted analysis without claiming a full-byte check. Forced reanalysis rereads candidates regardless of timestamps; explicit fingerprint verification performs full-byte reads. These modes must be separately visible to users.

New discoveries are staged before allocation so an old missing entry can be relocated first. Existing entries whose content changed become replacement-pending as soon as a changed observation is established; old bindings/history/accepted covers remain intact. If later exact evidence matches the accepted representation, restore Accepted under the lifecycle revision checks. Other changed representations require the user's edition decision.

## Stable Observations and Partial Analysis

A candidate is eligible for acceptance only after two matching lightweight observations separated by a configurable quiet interval and a matching observation before/after analysis. For image directories, each observation includes the direct supported-page names and stats, not merely the parent directory mtime. Changes restart the quiet interval and invalidate the in-progress candidate version. Common temporary/download suffixes and configured exclusions are skipped; they do not count as evidence of deletion. Set the quiet interval and read/resource limits during the NAS prototype before implementation; a zero-delay check is not treated as stability.

These checks reduce the chance of analyzing an active download; they cannot prove that an external writer has finished or detect every same-size/same-time mutation. Decoder failures remain errors rather than evidence of a different edition. Full fingerprints require their own stable before/after observations and are discarded if interrupted or changed. No filesystem snapshot guarantee is claimed.

A complete page manifest with a failed cover decode may still yield a recognized format and manifest page count, but it must show the cover error. A detected structurally corrupt/encrypted archive or incomplete manifest cannot be accepted as successfully analyzed. Fast analysis validates enumeration/structure and the pages actually decoded, not every page payload; record that validation level. The local page count is the number of recognized page members, not a guarantee that every one decodes. A later page-decoding error is surfaced when encountered. A new failed candidate remains visible in scan/task results for retry, without creating an accepted edition or inheriting another entry's records. For an existing entry, failures preserve the accepted analysis and pending state. A single candidate failure does not prevent analysis of other candidates.

## Reconciliation Scope and Moves

The first release's automatic move reconciliation scope is one complete root enumeration, including its eligible candidates. A successful enumeration means every non-excluded traversable directory was listed under the same mapping revision; permission failures, timeouts, cancellation, or unclassified link errors prevent a complete root reconciliation. Known excluded paths and known links are recorded as excluded, never as missing. Fingerprint/decoder errors do not make enumeration incomplete, but prevent identity decisions that require that candidate's evidence.

Missing status can be updated for previously indexed paths only after their containing enumeration scope completed successfully. A path newly covered by an exclusion remains retained and marked outside the current scan scope, not missing. Positive observations of unchanged/changed existing claims may commit from successful subscopes, but new candidates stay staged until a complete root reconciliation establishes the move/copy context. Partial scans therefore cannot accidentally turn a possible move into a new accepted entry.

For a complete root, compare newly staged paths with missing old claims using previously accepted comparable exact fingerprints. Apply the lifecycle's one-to-one/unambiguous criteria before creating new entries. Existing present copies or multiple matching old/new candidates prevent automatic relocation. A match transfers only the location; a different representation never becomes a same-edition move merely because its title or EH URL matches.

New candidates can be accepted automatically only when no unmatched missing old claims remain in that root, or all such old claims have comparable exact fingerprints that rule out a match. Duplicate bytes at two present paths produce separate entries. Ambiguous relocation candidates remain staged for user choice: select a missing entry and confirm relocation under the lifecycle rules, or explicitly import as a new entry. A missing old fingerprint cannot rule out a match; display plausible candidates without calling them exact and do not auto-import them. An old claim intentionally no longer awaiting relocation can be explicitly detached while retaining its records under the lifecycle rules. Do not silently overwrite already accepted target claims. Cross-root moves use manual relocation in the first release, after both relevant mappings and target evidence are checked; a scan preview can reserve selected new candidates for that review before import. The exact staging and user-decision persistence is an implementation prerequisite in [persistence](data-model.md).

A failed root scan retains staged new candidates with its error and a retry action. A user may explicitly import a selected fully analyzed staged file as a new entry after being told that the incomplete scan cannot rule out a move; this allocates a new identity and never transfers old history. It is not automatic partial-scan reconciliation. Removing stage records or task logs must not remove accepted entries.

## Fingerprint Profiles and Cost

Fingerprint evidence is optional for fast initial discovery; lack of evidence disables automatic identity decisions rather than fabricating a match. Initial analysis does not require an entire archive digest merely to display a cover. Full verification is an explicit per-entry/batch operation; a background verification schedule is opt-in. Read files with bounded concurrency and cancellation, and expose bytes/progress when available. Do not promise a full library hash within a fixed time before measuring its size and NAS.

| Profile | Exact bytes covered | Identity use |
| --- | --- | --- |
| `archive-sha256-v1` | The entire source archive, including headers and non-page members | Exact representation equality for the same profile; repacking changes the digest |
| `directory-pages-sha256-v1` | Complete direct supported-page set, with each original relative filename and full-byte SHA-256 digest | Exact indexed-page representation equality; changed page names or bytes change the digest |

The directory profile serializes a fixed profile identifier followed by page records sorted by the original filename's UTF-8 bytes. Each record contains a length-prefixed UTF-8 filename, byte length, and binary SHA-256 digest; integer widths/byte order must be fixed in the implementation contract and covered by shared fixtures before this profile is enabled. Non-page sidecars and child directories are excluded consistently with entry boundaries. A change in supported page formats or serialization requires a new profile version; never compare digests from incompatible profiles as exact evidence.

Associate a completed fingerprint with the exact accepted observation/content version it verified. A late digest for changed bytes cannot be attached to an older accepted version. If the old content is gone before a fingerprint was acquired, its fingerprint is unavailable; hashing the replacement does not reconstruct it. A hash establishes representation evidence, not edition equivalence, reading completion, or an integrity guarantee against malicious concurrent writers.

## Page Ordering and Covers

Order pages by full relative page name using a deterministic natural comparison: split ASCII digit runs, compare numeric magnitude without integer overflow, compare other text by original Unicode code point order, and break numeric-equivalent ties by original full-name UTF-8 bytes. Do not use locale-dependent ordering, case folding, or Unicode normalization. The directory manifest includes only direct images; archive member subdirectories participate in full-name ordering. Ordering fixtures must cover `2`, `10`, leading zeroes, non-ASCII names, nested archive members, and ties before implementation.

Default cover is the first decodable page in that order. Report skipped decode failures and distinguish the local manifest page count from successfully decoded cover candidates and EH page count. A user-selected page is stored by the original member/page name with the accepted content version. If that page disappears in an accepted replacement, fall back to the default cover and notify the user; never reinterpret its old ordinal as a different page silently.

Generate a small fixed set of thumbnail sizes in the focused imaging prototype, selecting pixel sizes and an encoded format before implementation. Decode under resource limits for archive expansion, member count, compressed/uncompressed bytes, image dimensions, wall time, and worker memory. Limits are configurable but finite; reject or defer over-limit candidates with a visible error, not a truncated successful analysis. CPU-heavy decoding/resizing uses workers or subprocesses; async NAS enumeration alone does not require worker threads.

Thumbnail cache keys include entry ID, accepted content version, chosen page identity, rendering profile, and requested size. Stable keys are invalidation identifiers, not a guarantee that a cache file exists or is reused. Write to a temporary file in the server cache directory and publish atomically only if the captured versions remain current. Pending candidates use a separate candidate/version key for comparison previews; they cannot overwrite the accepted cover. Eviction can delete any derived thumbnail; a missing thumbnail is regenerated or returns a placeholder while its task runs. Old files are cleaned only after no current cache reference needs them.

## Acceptance and Handoffs

| Scenario | Required result |
| --- | --- |
| Directory contains direct images, an archive, and child image directories | Separate candidates using explicit boundaries; no recursive absorption |
| Root has loose images, unsupported page formats, or nonportable filenames | Explain what was excluded/unassigned; no silently incomplete successful book |
| Archive with traversal, duplicate member names, encryption, corruption, or excessive resources | Candidate error; no writes outside cache and no halt of unrelated analysis |
| Download changes during quiet interval, analysis, or fingerprinting | Discard stale result, retry when stable; retain prior accepted records |
| Same-size/same-time replacement | Normal scan may miss it; forced reanalysis/verification exposes the documented limitation |
| Partial enumeration or changed mapping | No absence inference for failed scopes and no automatic new-entry/move allocation from incomplete root context |
| Unique exact within-root move with prior accepted fingerprint | Preserve identity after complete reconciliation |
| Copies, missing fingerprints, or several possible matches | No automatic merge/guess; staged review or explicit new entry |
| Reconciliation or server crashes after staging | Recover staged state, revalidate observations, and commit each decision once |
| Original bytes restored while replacement pending | Exact comparable evidence clears candidate with revision checks |
| Repack/rename changes fingerprint profile input | Do not call it exact equality; use explicit same-edition judgment |
| Late cover task or fingerprint finishes after content/mapping change | Cannot publish under the newer accepted version |
| Selected cover page disappears; cache is evicted | Explicit fallback or regeneration; metadata/history unchanged |

Acceptance fixtures must exercise the failure cases on representative NAS data; none have been runtime-tested yet. Before implementation, choose the exact directory serialization, page formats/decoders, quiet interval, thumbnail profile, and finite resource limits. Measure discovery, cover latency, incremental enumeration, verification throughput, and cancellation separately. Record dataset size and machine/NAS environment rather than setting unsupported performance targets.

[API and tasks](api-and-tasks.md) defines durable job states and operation deduplication. [Data model](data-model.md) defines stage/claim transactions and retained observations. [UI](user-interface.md) owns scan preview, unresolved candidates, exclusions, and error recovery. [Delivery](delivery-and-validation.md) must distinguish fast discovery from opt-in full verification. These mechanisms must be settled before their dependent implementation; identity and containment rules remain binding.

# Entry Identity and File Lifecycle

This topic defines when a library entry keeps its identity, when new content requires a new entry, and which records survive a change of file location. These are first-release design defaults for review, not additional user-confirmed requirements. Concrete filesystem observations belong to indexing; device path syntax belongs to path mapping; database columns and wire schemas remain in their owning topics.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Identity and Ownership

An entry represents one independently managed edition in a library. Its stable, opaque ID is allocated by the server and is never derived from a path, title, EH gallery ID, or file hash. Entry IDs are unique within a server instance and are never reused, including after retention or removal. Clients refer to the pair of server instance ID and entry ID.

A library can contain several storage roots; a root belongs to exactly one library. Root IDs are unique within the server instance and survive mount-path changes. Moving an entry between roots of the same library can preserve its identity. Moving or copying content between libraries does not automatically transfer identity or history; first-release relocation is restricted to the same library.

An entry has at most one current logical location: a storage root ID and a relative path. A current location can be temporarily missing or inaccessible; that observation alone does not release it for another entry. A detached entry has no current location but retains its last-known location for display. Last-known locations are not unique reservations and cannot be used to resolve Open. Device mappings add their own revision and collision/containment checks; changing a mount prefix does not change the entry's location revision.

Bindings, local overrides, and open events belong to the entry, not its location. Source metadata belongs to the bound EH gallery and may be shared by several entries. A filename change never changes an EH binding by itself. Separate language editions, revised editions, and distinct copies remain separate entries unless this document explicitly permits retaining identity.

An entry ID is not a guarantee that the bytes currently at its recorded path still match the indexed edition. Henshin observes an externally managed NAS; it cannot make external file changes and database transactions atomic with each other.

## Records Needed by This Topic

| Record | Responsibility |
| --- | --- |
| Entry | Stable identity, library membership, current or last-known location, retained metadata and history, revision for conditional decisions |
| Accepted content observation | Last accepted representation, analysis version, observation time, and available fingerprint evidence |
| Replacement candidate | Newly observed representation at an occupied location, evidence, candidate version, and pending decision; it is not yet a new accepted entry |
| Location revision | Changes when the current logical location changes or is detached; it lets clients and tasks detect stale location decisions |
| Content version | Advances when a different or byte-unverified representation is accepted; exact-equality observation refresh retains it; cached analysis and thumbnails depend on it |

Do not implement a general versioned file archive or retain old content bytes. Keeping metadata about an old representation does not preserve the old file. Schema design may combine these responsibilities where the invariants remain explicit.

## Observation and Identity States

Identity state and filesystem availability are separate. A root being offline, a permission failure, or a missing file must not erase identity or metadata.

| Identity state | Meaning | Normal Open |
| --- | --- | --- |
| Accepted | An entry has an accepted representation and current location | Allowed subject to local accessibility and the checks below |
| Replacement pending | A changed representation at the current location has not been classified | No reader launch or open event until resolved |
| Detached | The location was deliberately released, for example when a replacement became a new entry | Unavailable; show retained metadata and history |

Availability observations can be present, missing after a successful scan, inaccessible, or unknown. They include their observation time and are not claims about the client's current NAS access. Accepted entries that are missing from the server's view can still be attempted by a client with its own working mapping. A known pending replacement is a different condition and remains blocked.

The existing term file status collectively refers to these two axes: identity state and last server availability observation. Do not collapse them into a single mutually exclusive enum. UI and search must distinguish, for example, an accepted-but-server-inaccessible entry from a replacement-pending entry; neither is evidence of client accessibility. Exact display labels and filter syntax belong to their later topics.

Excluded is a separate scan-scope indicator derived from root/path policy, not a fifth availability observation. It can coexist with any retained identity/availability state and does not establish whether the file exists or is locally readable.

## Evidence Rules

Sizes and modification times are change-detection hints, not identity proof. Similar titles, EH IDs, page counts, covers, perceptual hashes, partial hashes, or a file's continued presence at the same path do not prove identity. They may rank candidates for user inspection.

Exact fingerprint equality can prove an unchanged representation within the supported fingerprint profile. For an archive, this means a full-file cryptographic digest. For an image directory, this means a complete manifest of the indexed pages, including their relative names and full-byte digests, with a deterministic ordering and a versioned profile. A partial or interrupted computation is never exact evidence. Indexing must specify the profile and stable-observation checks before enabling automatic decisions for that format; unsupported or incomparable profiles require manual resolution. Hash equality does not prove edition equivalence between different representations.

| Observation | Identity action |
| --- | --- |
| No detected change | Keep the entry; the unchanged observation is not a fresh full-content verification |
| Lightweight stats/manifest change without comparable full evidence | Treat as an uncertain replacement and block counted Open until exact verification or explicit edition confirmation; the hint alone proves neither change nor equality |
| Reanalysis shows an exact match to the accepted fingerprint, including after a pending replacement disappears | Clear the pending candidate if any, return to Accepted, and keep identity and content version; update observation details |
| Changed representation, even with the same EH URL or page count | Create or update a replacement candidate; keep prior accepted metadata |
| User confirms a repack, filename-only page rename, or other representation change of the same edition | Retain entry identity, binding, overrides, and history; accept the candidate and increment content version |
| User confirms another language edition, revised edition, or unrelated content | Detach the old entry and create a new entry at the location; do not copy binding, overrides, or events |
| Incomplete, corrupt, encrypted, or still-changing content prevents comparison | Report the analysis error and leave identity unresolved; do not infer a new edition or silently accept it |

A user confirmation is an explicit edition judgment, not a claim that the application proved equivalence. The resolution screen explains that retaining identity carries the old history and personal metadata onto the candidate. Existing gallery metadata may no longer describe a confirmed representation change accurately; preserve it but show changed local page/format information separately.

## Replacement Resolution

On detecting a change, retain the accepted observation and attach one current candidate to the occupied location. Show old versus candidate filename, format, size, page count when available, prior binding, and available covers. Label old data as previously indexed. Do not present old thumbnails or source metadata as newly verified candidate metadata.

The user can choose:

1. **Keep this entry**: explicitly confirm the same edition and accept the current candidate, preserving the entry's records.
2. **Treat as a different entry**: release the old current location, preserve the old entry as detached, and create an unbound entry with no inherited overrides or events.
3. **Decide later**: retain the unresolved state and block normal Open for that entry. A later scan can replace the candidate but cannot make the decision on the user's behalf.
4. **Stop scanning this location**: for an unacceptable replacement, explicitly add an exact-path exclusion and retain the old entry, its current claim, and pending state with an excluded/error indicator. Normal Open stays blocked and no new entry is created. The user can later remove the exclusion and retry analysis after repairing the file or adding format support; source-file deletion is not required. This terminal handling preserves old records without pretending the replacement was accepted.

The exception is an exact match to the previously accepted fingerprint: restoring the accepted representation needs no edition judgment. Atomically clear the candidate and restore Accepted under the current decision, location, and candidate revisions. Advance the decision revision so an already-open comparison cannot resolve the discarded candidate. A failed scan, missing candidate file, or matching size/mtime alone does not perform this transition. Fingerprint profiles must be comparable and the observation stable and successful under the complete acceptance analysis profile below. Enumeration completeness or equality of only the supported-page digest is insufficient when analysis reports unsupported pages, structural corruption, encryption, zero pages, or an incomplete manifest. Such equality remains diagnostic evidence; the candidate stays pending. This profile prerequisite also applies to automatic relocation.

Only a stable candidate satisfying the complete acceptance analysis profile in [Indexing](file-indexing.md) can be accepted. This means a complete supported-page manifest, not full decoding of every page or mandatory full-byte hashing. Unsupported-page/incomplete-manifest failures remain pending; a separately reported cover error need not invalidate a complete manifest. The first release does not provide an untracked preview launch to bypass the pending state.

Accepting a byte-unverified candidate with an explicit same-edition judgment always advances content version and invalidates derived analysis/thumbnail keys, even when the user believes only timestamps changed. Without prior exact evidence, reusing the old cache could hide actual changes. Only comparable exact equality retains content version; version advancement is a conservative invalidation decision, not proof that the bytes differ.

Stop scanning is a non-accepting configuration action: it requires matching decision/location/candidate revisions but no successful analysis or fingerprint. Atomically add the exact-path exclusion and preserve the existing claim/state; reject a stale target. Its operation ID makes retries idempotent. The fresh-evidence acceptance checks below apply to Keep this entry and Treat as a different entry, not to exclusion or Decide later.

Resolution submits the decision revision, location revision, and candidate version observed by the user. Before accepting, check that the candidate still matches a fresh stable observation and that those revisions still match; compare the same fingerprint profile when fingerprint evidence is available. Without it, repeat the lightweight/manifest checks and retain the explicitly byte-unverified classification and its limits. Changed evidence requires refreshing the comparison. Apply the old-entry detachment, new-entry creation or accepted-content update, location ownership, and cache invalidation atomically. No intermediate state may expose two accepted entries at one current location or move old events to the new entry. A retry after a successful resolution returns the existing result for the same operation ID rather than creating another entry.

Scanning and resolution for a location must serialize their commits or use conditional revision checks. A late analysis result for an old location/candidate cannot overwrite a later user decision. A file can still change after the last check: subsequent observation returns it to pending. This is a documented external-filesystem race, not an atomic file-lock guarantee.

## Moves, Copies, and Relocation

Automatic relocation requires all of the following within one completed reconciliation scope:

- The previous location was confirmed missing by successful enumeration, not inferred from an offline or failed scan.
- Exactly one unmatched old entry and one newly discovered, unclaimed location in the same library have comparable exact fingerprints.
- No other known matching copies or pending replacements make the association ambiguous.
- The target observation is complete and stable, and the source entry and target claim still match their expected revisions at commit.

If these conditions hold, atomically transfer the current location, retain identity and content version, and increment the location revision. Keep the previous location only as last-known diagnostic information. Metadata and history remain with the entry. A case-only rename follows the same identity rule; the path-mapping topic defines platform comparison and collision behavior.

Otherwise show relocation candidates for explicit confirmation. Manual relocation checks same-library membership, target accessibility and completed analysis, target claim, and revisions. Exact representation matches retain identity; different representations require the same explicit same-edition confirmation as replacement. It never overwrites another accepted entry's location. If discovery has already created a separate entry for the target, report that conflict rather than silently merging entries or histories; entry merging is outside the first release.

When both old and new paths are present, treat the new path as a separate copy and allocate a separate entry, even if the bytes are identical. It can independently bind to the same gallery, but bindings and personal records are not copied automatically. If several copies make a move ambiguous, do not select the first matching result.

Discovery must stage potential new locations until relocation reconciliation is complete; allocating entries immediately would prevent reliable moves from retaining identity. A cancelled or failed reconciliation preserves prior claims and can be retried. The indexing topic must specify scope completeness and the staging persistence before implementation.

## Root Changes and Retention

Changing a device mapping changes only the access path for the same logical root. It is not a command to move entries to different content. The path-mapping workflow must verify the intended root and warn about mismatches before scanning or opening through a changed mapping. Hostnames, mount letters, root labels, and identical filenames do not establish identity.

Disabling or removing a root from active scanning retains its entries, root identity, bindings, and history. Re-enabling the same root can reconcile them. Creating a different root with the same label allocates a different ID and does not inherit those records. Removing a client mapping leaves shared data intact; that client must configure the mapping again to open files.

The first release has no hard deletion, entry merge, or history transfer. Missing entries with current claims remain in default library browsing regardless of server availability; detached entries require an explicit view/filter. Both remain inspectable under [search](search.md#tag-aliases-and-filters). Exclusions and incomplete scans do not delete entries. A future permanent-removal feature must define retention and pending-event handling separately; it is not implied by removing a path mapping or disabling a root.

A user may explicitly stop awaiting relocation for a confirmed-missing current claim by detaching it. Require the observed decision/location revisions, explain that metadata/history remain and automatic relocation will no longer use that claim, and release only the location. This is not file deletion or record removal; it prevents intentionally retired missing claims from indefinitely blocking unrelated new discoveries. A detached entry may later be manually relocated to an unclaimed target under the same identity evidence rules.

## Opening and Delayed Events

Before launching, an online client refreshes the entry's identity state, current location, location revision, and content version. A disconnected client uses its last cached accepted state, clearly marked stale. It never knowingly bypasses a cached pending or detached state. If a lightweight local check detects changed size/mtime compared with that accepted observation, block the normal counted Open and ask for server reconciliation; unchanged hints do not prove unchanged bytes.

Record the entry ID and observed location/content versions with the event. Never retarget an event by filename, current path ownership, or gallery binding. Events queued before an entry is detached remain attributed to that retained entry. A stale event does not mutate the entry back to its former location or accepted state. The synchronization topic defines acknowledgment and user-visible handling of stale observations.

No full-file hash is required for every Open, and an external reader opens by path. Undetected replacements, changes during a reader launch, or disconnected caches can therefore produce an event based on stale identity evidence. Counts record the entry selected from the client's accepted view, not proof of the bytes actually read. Known mismatches are blocked; the application must not claim stronger guarantees than its observations provide.

## Acceptance Scenarios

| Scenario | Required result |
| --- | --- |
| Server uses `/mnt/nas/books`, client uses `B:\Books` | Same root/entry IDs; device mappings alone determine absolute paths |
| Byte-identical archive moved to a unique unmatched location; old location reliably missing | Entry ID and history preserved; location revision advances |
| Identical archive copied while old path remains | Separate entry; no inherited history |
| Several identical copies, or old scope unreadable | No automatic relocation; explicit candidates or retry |
| Archive at the same path replaced with another edition | Pending first; after confirmation, old entry detached and new entry unbound |
| User confirms a repack of the same edition | ID and records retained; content version changes and covers are regenerated |
| Candidate changes while the comparison screen is open | Reject stale resolution and show fresh evidence |
| Replacement cannot meet the analysis profile | Retain pending/error state; explicit exact-path exclusion suppresses further scanning without deleting files or history; removing it permits retry |
| Accepted image directory gains a recognized unsupported GIF while its supported-page digest stays equal | Remain pending with the unsupported-page diagnostic and Open blocked; removing the GIF permits exact restoration only after successful stable acceptance analysis, retaining content version |
| Original accepted bytes are restored while a replacement is pending | Exact comparable evidence clears the candidate and restores Accepted without changing content version; a stale comparison cannot commit |
| Two clients resolve the same candidate concurrently or retry a completed resolution | One committed result; stale conflict or idempotent replay, no duplicate entry |
| Analysis completes after a relocation or replacement decision | Conditional commit rejects obsolete result |
| NAS disconnects or a scan is cancelled | Preserve identities and prior claims; no mass missing/deletion inference |
| Root disabled and re-enabled | Same root/entry IDs; no implicit new library or reset of history |
| Old entry detached while an earlier open event is queued | Event keeps old entry ID; never lands on the new owner of the path |
| Client knows replacement is pending | No reader launch and no open event until resolution |
| Disconnected cache misses a same-size/same-time replacement | Document the observational limit; no claim of exact content verification |

These are design acceptance cases. They have not been executed against an implementation or a NAS.

## Related Contracts

- [Path mappings](path-mapping.md): root verification, path comparison, unsupported names, overlap detection, and links/reparse points.
- [Indexing](file-indexing.md): fingerprint profiles, stable observations, reconciliation scopes, staging, directory boundaries, and stale-result rejection.
- [Persistence](data-model.md) and [contracts](api-and-tasks.md): exact constraints, revisions, operation deduplication, transaction boundaries, and retention representation.
- [Reading](external-reading.md) and [synchronization](synchronization.md): cached state, local mismatch checks, event version fields, retry, and stale-observation presentation.
- [UI](user-interface.md): accessible comparison and resolution screens with explicit consequences for retained history.
- [EH metadata](eh-metadata.md): a confirmed same-edition representation change preserves the binding and overrides while keeping changed local analysis separate from source metadata.

No automatic identity operation for a format may ship before the corresponding evidence and transaction handoffs are specified and tested. These related contracts refine mechanisms; they do not reopen the identity/record-ownership rules above.

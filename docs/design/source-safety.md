# NAS Source Safety and Read-only Access

This topic owns protection of collection files from Henshin-initiated writes. It makes the confirmed read-only requirement concrete across the server, desktop, workers and maintenance operations. [Path mappings](path-mapping.md) owns containment and identity checks; [deployment](architecture.md) owns process/account isolation. These rules apply whether the service is local or remote and whether A and B refer to the same NAS through different mount paths.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Non-negotiable Source Boundary

Every Henshin operation on a collection source is read-only. Permitted operations are bounded enumeration, metadata inspection, read-only file opening, byte streaming, hashing and decoding. Open source handles with read access only, without create, truncate, append, delete-on-close or write-capable mapping flags. This remains true when the account happens to have write permission; a writable source is never authorization for Henshin to modify it.

No Henshin flow may create, overwrite, rename, move, delete, repair, repack, extract into, change permissions/ownership on, or set timestamps/extended attributes on source files or directories. Do not write markers, sidecars, tags, thumbnails, lock files, reader progress, hidden files, or probe files beside a book. Read imported sidecars only if a separately validated feature supports them; metadata refresh always updates application data. Identity relocation changes database claims, never NAS locations. Exclusion, cache eviction, cancelled tasks, rollback, backup retention, uninstall and failed operations cannot turn into source cleanup.

Read-only is an access contract, not a promise that every NAS bit or timestamp remains unchanged. NAS/OS access-time updates, audit logs and external actors are outside Henshin control. Never restore atime by writing it back. Document such filesystem behavior separately; it does not authorize an application source write.

## Enforcing the Boundary

Use both a narrow application capability and filesystem permission enforcement:

- The source-access capability offers enumeration, stat and read-only streams/handles. It exposes no mutation method. Effect composition supplies it to scanners, analyzers, fingerprints and local access checks; application writes use a separate owned-output capability.
- Source adapters enforce read-only flags at the actual native file-open boundary. Pure TypeScript types or a service named ReadOnly do not constrain native code by themselves. Decoders receive read-only streams/handles where supported; path-based helpers must have documented, validated read-only modes and no in-place repair behavior.
- A supported protected deployment uses NAS credentials/ACLs or mounts that deny source writes for the server account and the desktop reader's effective access. Run without administrator/root privileges. Source access and backup-destination writes use separate permissions even when they share a NAS host. A read-only file attribute alone is not a substitute for share/filesystem permissions.
- Configure and audit permissions outside Henshin. The application never changes NAS ACLs, remounts shares, escalates privileges or tests permissions by attempting a write. Deployment validation may use a disposable fixture/share to demonstrate denied writes, never a user's collection.

On Windows, account access can be shared by several SMB connections; merely naming a second drive letter or account does not prove isolation. On POSIX, a read-only mount does not cover a separate writable alias automatically. Record the actual account, mount and share policy used by the service and by the reader. Setup explains that read-only restrictions also affect other applications using that same access context; file organization needs a separately managed writer context rather than relaxing the protected one. Permission errors produce explicit unavailable/unsupported results, not a retry with broader access or a source-modifying workaround.

## Operation and Output Matrix

| Operation | Allowed source access | Write destination |
| --- | --- | --- |
| Root preview, incremental/full scan and reconciliation | Enumerate and inspect metadata; no sentinel/probe file | Server-local database and task state |
| Manifest, format analysis and optional fingerprint | Read bytes/members; reject unsupported or failed candidates without repair | Server-local observations and bounded worker scratch |
| Cover generation or regeneration | Decode eligible source bytes after identity checks; no adjacent extraction | Server-owned cache with generated names |
| EH metadata refresh and personal edits | No source write; source reads only if an adopted matching feature needs them | Server database and protected credential store |
| Client Check access and Open preparation | Stat/enumerate/read using client mapping; no access-time repair or local marker | Desktop database/journal and local diagnostics |
| External reader handoff | Supply a checked client-native path; Henshin does not modify it | Reader-owned behavior is constrained by OS/NAS permissions, as below |
| Backup/export/restore, migration, cache cleanup and uninstall | Never mutate source content | Explicit application/backup destinations, outside all collection roots |

All Henshin working directories, logs, crash artifacts, caches, temporary outputs and decoder output directories are application-owned, outside source roots. Set helper working directory and temporary-directory environment explicitly; never inherit the selected book directory as cwd. Reject a helper that requires writing beside its input. No fallback to a source directory when a cache, temp directory or local disk is full/unwritable. Decoder temporary page output, if an adapter needs it, stays bounded and private; it is not automatic extraction for reading or content forwarding.

## Disjoint Writable Locations

Application data, scratch, cache, export and backup destinations must not be inside a collection root, contain a collection root, or be the same location through a known alias. Perform component-aware canonical checks in both directions when configuring either kind of location; enabling a new collection mapping cannot swallow an existing writable data directory. Include disabled-but-retained configured roots in this check; disabling scanning does not make their contents writable.

Validate the existing destination parent and final target, reject link/reparse redirections inside managed output trees, and recheck the configured boundary before publication or cleanup. Use generated relative output identifiers under that boundary rather than source names as write paths. A remount or changed canonical destination suspends writes until revalidation. Restore may replace an application store only after this check; a backup source path grants no permission to overwrite that path or nearby collection files. Client artifact saving applies the same rule against that desktop's known roots.

Different hosts cannot discover every equivalent share name or physical directory alias. Operators must configure destinations physically separate from every collection source, including roots unknown to that process, and maintain read-only source permissions. A separate backup share/directory on the same NAS is allowed with its own write permissions and validated separation; another folder on the same disk is not an independent disaster-recovery copy. Do not claim that canonical strings or one successful sample establish global physical separation. Unknown alias/protection status is visible, not labeled verified protection.

Cleanup is limited to individually identified Henshin-owned outputs beneath a validated writable boundary. A path outside that boundary, a link-like entry, uncertain ownership, or a missing generation prevents deletion; do not recursively delete a user-selected backup parent or a collection directory. Retention policy applies to application artifacts, never books. Existing [indexing](file-indexing.md) resource and stale-result rules still apply.

## External Readers and Setup

Henshin does not sandbox an external reader. A native reader or system association can create bookmarks, sidecars, extraction files or write back to an archive even though Henshin only passed a path. Passing a read-only handle internally, selecting first-image mode, or specifying shell=false cannot restrict that separate process. Configure the NAS access used by the reader as read-only; otherwise end-to-end source-write protection is not established. Reader settings should put progress/cache/extraction outputs in the reader's own local data directory. If a reader cannot work without source writes, it is incompatible with the protected workflow; do not relax NAS permissions to make it work.

Mapping setup displays the configured source path, observed mount/access information, operator-confirmed protection policy, and whether OS enforcement has been validated on that configuration. The application does not infer enforced read-only access merely from a successful read, a read-only attribute, or an unexecuted platform test. Henshin's own operations always use read-only access, including in an unverified environment; UI must label external-reader protection unverified when it cannot establish the mount/account policy. No per-Open permission prompt or automatic permission change is implied.

The [reader](external-reading.md) and [UI](user-interface.md) contracts explain this boundary at setup. Reading remains direct from the NAS, with no local content-copy fallback. A distinct writer used by the user to organize files remains external to Henshin and subject to the existing replacement/reconciliation rules.

## Acceptance and Release Evidence

| Scenario | Required evidence/result |
| --- | --- |
| Server uses read-only A and desktop uses read-only B | Preview, scan, analysis, fingerprints, covers and a compatible reader work; application outputs appear only in their designated writable stores |
| Source ACL permits writes in a disposable fixture | Instrument all Henshin source opens and mutations, including worker/helper activity; no write-capable opens or source mutation calls occur on success or failure paths |
| Production NAS protection setup | Record effective account/share/mount policy without a live write probe; validate denial on a disposable equivalent configuration |
| Decoder requests repair, adjacent extraction or writable input | Reject that mode/helper; preserve source, surface analysis failure |
| Local temp/cache/journal is full or unwritable | Fail visibly under the relevant task/Open rules; no source-directory fallback or lost-history workaround |
| Writable output and source overlap, including reverse nesting or a known alias | Reject configuration before writes; test both source-first and output-first setup |
| Output parent becomes a link or remounts; cleanup sees foreign files | Suspend/refuse the affected write/deletion; preserve foreign/source data |
| Reader attempts bookmark/sidecar/archive writes | Validated read-only source permissions deny writes; compatible reading still works or reports failure without relaxation |
| Backup/restore/retention/uninstall under injected failure | Only validated owned application artifacts change; NAS source bytes, names and explicit metadata remain unchanged |

Run source-write auditing as well as before/after inventories on disposable Windows/macOS/Linux and representative SMB/NFS fixtures; final hashes alone would miss attempted or reverted writes. Treat expected NAS-managed access-time/audit changes separately from application mutation. G3 covers read-only source capability, account/share/mount permissions and source/output separation, including reverse nesting, known aliases, both setup orders and link/remount revalidation. G4 covers decoder/helper behavior, G5 covers reader protection, and G6 covers process, authentication and IPC trust before the relevant feature ships. G10 covers maintenance and uninstall. [Delivery](delivery-and-validation.md) records actual adapters/platforms, traces and results. No such runtime or permission test has been executed in this design repository.

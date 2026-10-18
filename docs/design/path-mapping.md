# Storage Roots and Path Mappings

This topic specifies logical locations, mapping setup, device resolution, and root containment. It implements the user's NAS scenario without routing content through the server. These are first-release design defaults; native path adapters still require platform validation.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md) | [Entry lifecycle](entry-identity.md)

## Location and Mapping Keys

An entry has a server-scoped stable ID and at most one current logical location: `storage_root_id` plus `relative_path`. The root identifies the same collection directory across devices. It does not identify a host, mount, share credential, or drive letter. Root IDs are unique within the server instance, including across libraries, and are never reused for an unrelated root.

```json
{
  "entry_id": "entry-001",
  "storage_root_id": "nas-books",
  "relative_path": "Author/Title.zip",
  "location_revision": 3
}
```

| Device | Root mapping | Resolved path |
| --- | --- | --- |
| Linux server | `/mnt/nas/books` | `/mnt/nas/books/Author/Title.zip` |
| Windows client | `B:\Books` | `B:\Books\Author\Title.zip` |
| Windows client using a share | `\\nas\books` | `\\nas\books\Author\Title.zip` |
| macOS client | `/Volumes/Books` | `/Volumes/Books/Author/Title.zip` |

Server mappings belong to that server's configuration and are used for scanning. Client mappings are local to a device and keyed by server instance ID and storage root ID. They are not synchronized across devices. A display label may change freely; the key does not. Never derive mappings from the server URL or substitute strings inside the server's absolute path. Server absolute paths need not be returned in ordinary entry responses.

Each device has one active mapping per root. Multiple aliases and automatic fallback mounts are outside the first release: selecting the wrong reachable alias can open different content without an obvious error. OS mounts and NAS credentials remain the user's responsibility.

## Relative Path Contract

The transport form uses `/` between nonempty segments. It is a logical name sequence, never a URL or native path to concatenate blindly. Preserve filename case and Unicode code points returned by discovery. Do not lowercase, Unicode-normalize, expand environment variables, decode percent escapes, interpret a leading `~`, or resolve shell syntax. Encode the logical path as schema-validated data, not as the path portion of an HTTP request.

Reject an empty path, leading/trailing `/`, empty segments, `.` or `..` segments, NUL, backslashes, and drive-qualified prefixes such as `C:`. Thus `/outside`, `../outside`, `a/../b`, `a//b`, `C:book.zip`, `C:/book.zip`, and `\\host\share` are invalid. Backslashes in POSIX filenames are unsupported in the first-release portable path model; report them without renaming or silently interpreting them as separators. The configured root itself cannot be an image-directory entry: use a child directory as the entry and map its parent as the root.

Other names are validated by the device adapter before any access. On Windows this includes reserved device names, invalid characters, alternate-data-stream syntax, and trailing dots/spaces; reject unsupported names rather than trimming or aliasing them. Length and filesystem restrictions are detected by native APIs and reported as unsupported names. A name valid on the server may remain indexed while one client cannot represent it.

Native absolute paths are accepted only as locally configured mapping values. Validate them with the device adapter; Windows drive/UNC roots and Unix absolute mount paths are supported. Native extended-length handling is an adapter detail, never accepted from an entry's relative path. A mapping cannot be a URL or executable command.

## Setup and Verification

Root setup has a draft mapping and an active mapping. Editing a path does not immediately replace the active one.

1. Select the server instance and logical root. For a new root, name its intended collection directory and allocate a new ID; do not reuse a removed ID based on a matching label.
2. Select an absolute native directory. Resolve its canonical directory, check permissions and configured-root overlap, and enumerate a bounded preview. Do not scan the whole library or write a marker into collection files.
3. For an existing root, compare the preview with representative indexed relative paths. Show found/missing samples, format/size information, and comparable complete fingerprints when already available. Server absolute paths are only configuration hints, never client path templates.
4. Ask the user to confirm that the selected directory is the intended root, showing its absolute path and preview. Samples are evidence, not proof that every file is identical. Conflicting comparable fingerprints for a sample require resolving the discrepancy before activation; missing samples alone may reflect file moves and must be explained rather than silently rebinding entries.
5. Activate the mapping atomically and increment that device's mapping revision. Keep the prior active mapping until activation succeeds. Invalidate local accessibility observations; server activation schedules reconciliation rather than resetting library identities.

An inaccessible candidate may be saved as a draft but cannot be activated. A client may activate a mapping while disconnected using cached sample information and explicit confirmation, or with an explicit unverified-root warning if no samples are available. It must still reach and preview the local directory. Creating or changing server mappings requires an authenticated server connection. The warning is part of setup, not a prompt on every subsequent Open.

Sample verification does not make a mapping immutable or authenticated by file content. NAS mounts may later point elsewhere; existing local mismatch checks and entry reconciliation remain necessary. Do not claim that matching filenames, a root label, or a single cover verifies the root. Explicit user selection is the authority when stronger evidence is unavailable.

## Containment and Links

Resolve a mapping's selected directory to its canonical root during activation. A user-selected root may itself be reached through a mount or a directory link; its canonical target becomes the configured boundary. Revalidate that boundary before operations. If the configured root now resolves to a different canonical directory, suspend use and require mapping verification again; do not silently accept the new target.

Within the root, scanning and Open do not follow symbolic links, junctions, or directory/file reparse redirections. Check every existing path component and the final target, not only the lexical prefix. Report excluded links in scan results. Ordinary mounted filesystems at the configured root remain supported; link-like or reparse behavior that the adapter cannot classify safely is unsupported until validated.

Resolution must satisfy both segment-safe joining and canonical containment. Use path-component comparison under the actual filesystem semantics; `/books2` is not a descendant of `/books`. A naive string prefix, `resolve` call without link inspection, or lowercasing is insufficient. The Electron main process performs local resolution; the renderer supplies logical identifiers, never an arbitrary executable path from server metadata. The server applies the same containment policy to scanning and analysis.

An external reader is launched by path, so containment checks cannot eliminate a race if another process swaps a path component after the check. Recheck immediately before launching and use no-follow/file-handle operations for internal reads where the platform supports them. Henshin does not promise safe execution against a malicious actor concurrently mutating trusted NAS directories. This limitation must be stated in platform validation; it does not permit intentionally following a known link outside the root.

## Case, Unicode, and Collisions

Preserve the discovered logical spelling. A device resolves names component by component using directory entries and its filesystem's comparison behavior. Exact spelling is preferred. If the filesystem applies case or normalization equivalence, resolution is allowed only when a single physical candidate matches and the library has no conflicting current logical claim under that device's equivalence. Do not impose Windows comparison rules on a Linux server.

For example, a server may index both `A.zip` and `a.zip` on a case-sensitive share. A client whose mount cannot distinguish them reports a name collision for both; it must not open whichever file its OS chooses. Equivalent Unicode spellings receive the same treatment. The server exposes the logical sibling names/claims needed for this check as part of the resolution data; exact API shape belongs to contracts. A disconnected client lacking sufficient cached collision information cannot fall back to an ambiguous alias.

Same-root uniqueness therefore uses the server filesystem's actual comparison semantics, while each client separately checks its own resolvability. Detect a case-only rename without allocating a second current claim to the same physical path; identity retention still follows [entry lifecycle evidence](entry-identity.md). If a platform or share's comparison rules cannot be determined, allow only exact, unambiguous resolution verified by directory enumeration and report unsupported equivalence cases.

## Overlapping Roots and Aliases

Reject an active server mapping when its canonical directory equals, contains, or is contained by another active server root's canonical directory, including roots in different libraries. Comparison must follow the relevant filesystem semantics and path-component boundaries. Client mappings use the same check within a single server instance; different server connections keep separate namespaces and do not inherit mappings.

Different share aliases can hide a physical overlap that canonical strings cannot establish. Use stable filesystem object/volume identifiers where available, but never promise that every NAS reports comparable identifiers. Show suspected aliases in setup and require the user to choose non-overlapping roots. If overlap is discovered later, suspend the affected server scans and report the conflict; do not merge entries or delete existing history to repair it. Direct client use still follows identity/access checks unless its own mappings are ambiguous.

Overlap exclusions are deliberately not used to permit nested roots in the first release. Organize separate sibling roots or one parent root with indexing exclusions instead.

## Mapping Changes and Operations in Flight

An operation captures the mapping revision, entry location revision, root ID, and server instance ID. On mapping activation/removal or server switch, cancel or discard unresolved client operations from the old revision. Recheck the revision immediately before a launch; an already accepted OS launch is not undone, and its event retains the original entry/observation values. Never relaunch automatically after a mapping change.

Server scans and analysis also capture the server mapping revision. A mapping change interrupts old work where possible and prevents its results or missing-file reconciliation from committing. Stage new work under the new revision. Clearing old tasks does not clear the library; unsuccessful mapping changes keep the prior active configuration. Mapping revision is separate from an entry's location revision: a changed mount prefix does not move the logical entry.

Removing a client mapping blocks that device's future Open actions but leaves library data and other devices intact. Disabling a server root retains its identity and entries under [retention rules](entry-identity.md); it does not delete source files or client mappings. Re-enabling requires a verified active server mapping. Independent clones require new namespace-scoped mappings; a sole-successor migration preserves the namespace under [synchronization rules](synchronization.md).

## Resolution Results and User Recovery

| Result | Meaning and recovery |
| --- | --- |
| Missing mapping | Configure the root on this device |
| Draft or suspended mapping | Complete verification; do not attempt Open or scanning with it |
| Unavailable root | Check mount/network; keep indexed entries and prior observations |
| Permission denied | Explain that OS/share access is required; Henshin does not mount or prompt for NAS credentials |
| Missing target | Report this device's observation; do not declare the entry deleted |
| Invalid/unsupported name | Show the preserved logical name and affected device restriction |
| Name collision or ambiguous alias | Require an unambiguous mount/name layout; do not guess or rewrite names |
| Link, traversal, or outside-root target | Reject access and report the unsafe location |
| Stale mapping/location decision | Refresh state; a rejected Open creates no event and is not automatically retried |

When an OS error cannot distinguish disconnection from permissions or missing content, report an unavailable/unknown result with the diagnostic rather than inventing a specific cause. Mapping errors do not change entry identity or clear metadata. The [reader topic](external-reading.md) adds reader configuration and launch failures after resolution succeeds.

## Acceptance Scenarios and Implementation Gates

| Scenario | Required result |
| --- | --- |
| Linux server mapping A, Windows drive/UNC mapping B, macOS mount C | Same logical location resolves directly on each device; no server content forwarding |
| Mapping changed to another valid prefix for the same root | Entry IDs, relative paths, and history unchanged; mapping revision advances |
| Wrong directory selected or exact sample fingerprints conflict | Show discrepancy; no silent activation or scan-driven identity reset |
| Candidate root inaccessible | Save draft at most; existing active mapping retained |
| `../`, drive paths, backslashes, empty segments, or NUL in a relative path | Reject before filesystem access |
| Name contains literal `%2e%2e`, spaces, or shell metacharacters | Treat as literal segments when legal; no URL decoding or shell evaluation |
| Child symlink/junction/file redirection escapes root | Skip/reject, including final archive links; no content read outside boundary |
| Root canonical target changes after activation | Suspend and require verification |
| `A.zip` and `a.zip`, or equivalent Unicode spellings collide only on a client | That client blocks ambiguous entries; server data remains distinct |
| Native-invalid Windows name is valid on server | Keep server entry, report unsupported resolution on Windows |
| Nested or duplicate roots, including detected share aliases | Reject/suspend overlapping mappings, preserving existing records |
| Mapping/server changes while resolving, scanning, or decoding | Old results cannot commit or launch; already accepted launches keep original event attribution |
| NAS/server inaccessible but client's accepted mapping and cached collision data are sufficient | Client may resolve locally subject to identity rules; server outage does not force content transfer |

Before implementing resolution, validate the native adapters on actual Windows, macOS, and Linux filesystems and representative NAS mounts. Exercise drive letters, UNC paths, canonical root links, child links, case-sensitive and case-insensitive names, Unicode, and error reporting. Record unsupported platform cases rather than claiming portability from string-only tests. These acceptance cases are specified, not executed.

Concrete request/response fields, preload schemas, and task cancellation checkpoints belong to [contracts](api-and-tasks.md). [Indexing](file-indexing.md) supplies discovery and current claims; [persistence](data-model.md) stores root configuration and revisions. Those topics may refine the mechanisms but must preserve this containment and namespace contract.

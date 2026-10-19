# Native Source Boundary Precursor

Status: **bounded macOS development-host precursor evidence**, not a G3
completion claim. The implementation is recorded at commit `3642d1d14b699d738be27378ef477ad4c17dc417` in
[`NativeSourceBoundary.ts`](../../apps/server/src/analysis/NativeSourceBoundary.ts)
with focused cases in
[`native-source-boundary.test.ts`](../../apps/server/test/native-source-boundary.test.ts).
The canonical contracts remain [path mapping](../design/path-mapping.md) and
[source safety](../design/source-safety.md).

## Observed behavior

The precursor was exercised on the local macOS development filesystem with
disposable temporary directories only. Fixtures covered:

- exact Unicode and literal metacharacter names such as `100% [vol]! café.zip`,
  `图书 [1]`, and `page 1!.jpg`;
- a selected root reached through a symlink, then retargeted to another
  directory;
- intermediate, final, and dangling child symlinks;
- case-alias lookup (`Case.zip` requested as `case.zip`), sibling prefixes,
  source/output reverse nesting, known symlink aliases, a missing output leaf,
  a dangling output link, and a regular-file output parent.

Portable logical paths are validated before native access. Empty segments,
`.`/`..`, absolute paths, backslashes, drive-like prefixes, NUL, and trailing
slashes are rejected. Literal percent, shell, space, and Unicode characters
are preserved. Configured absolute native paths containing `.` or `..` are
deliberately rejected rather than lexically normalized across a symlink.

Each requested component is resolved by incremental directory enumeration and
the exact spelling observed in the directory entry. The precursor does not
invent lowercase or Unicode normalization equivalence: if native lookup would
find a nonexact alias but enumeration cannot establish the requested spelling,
the result is the typed `unsupported-name` error. Valid final candidates are
regular `.zip`/`.cbz` files or directories; child links, including dangling
links, are rejected. Component-aware containment is checked using native path
relationships, not string prefixes.

Root selection records its canonical target and native `dev`/`ino` identity.
Resolution rechecks the selected root before work and after final candidate
verification, and rejects a changed canonical target or identity. Final
candidate identity and canonical containment are also rechecked. These checks
do not claim immunity from hostile concurrent swaps.

Source-root/source-root and source-root/writable-location equality,
ancestor, and descendant overlap are rejected in either configuration order.
Existing-parent canonicalization detects known aliases and overlap for a
not-yet-existing output leaf. Nested writable locations are permitted when
they do not overlap a source root; writable/writable overlap itself is not a
source-boundary violation. Validation only reports a result: it never creates
output directories, writes source or output data, changes permissions, or
changes mounts.

## Bounds and results

The default finite limits are 10,000 entries per enumerated directory, 1 MiB
of directory-entry name bytes per component enumeration, a 1 MiB logical path,
and 1,024 logical segments. Candidate resolution has one cooperative 5-second
deadline shared by component enumeration and the final native canonical/root
checks. Limits reject non-positive, non-finite, fractional, or unsafe-integer
overrides before filesystem work. The deadline is cooperative; it does not
hard-cancel an in-flight native I/O operation.

Public failures are typed and redact native paths and raw operating-system
errors. The evidence includes `invalid-portable-path`, `unsupported-name`,
`missing-target`, `source-link`, `root-changed`, `directory-limit`,
`location-unavailable`, and `location-overlap` outcomes. No archive payload or
image bytes are read. The source-byte before/after assertion proves only that
the fixture content was unchanged; it is not a syscall audit.

## Scope boundary

This is exact-spelling native evidence on one local macOS development host. It
does not provide server sibling-claim collision data or full client collision
validation, and it does not activate production mappings, CAS, mapping
generations, or a production schema/API/full scanner/UI. It does not establish
unknown NAS/share aliases or mount aliases, permissions or read-only syscall
auditing, or cross-platform behavior. It does not validate links or cleanup in
a future managed output tree. It does not claim hard native-I/O cancellation,
hostile-swap protection, or immunity to unknown NAS aliases/mount changes.

The focused native suite recorded 10/10 passing cases at the implementation
commit. The independently accepted broader verification was 108 Vitest tests
in 11 files plus 6 Electron tests, with typecheck and build passing; those
results do not expand this precursor's scope. Full G3 remains **Not run**.

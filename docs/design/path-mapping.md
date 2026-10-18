# Storage Roots and Path Mappings

This document owns logical file locations and their resolution on each device. A server path and a client path can refer to the same NAS file without transferring its contents.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Location Model and Resolution

A library entry has a stable `entry_id`. Its location is represented by `storage_root_id` and `relative_path`. Changing a path does not directly change the entry ID, and a content hash is not the entry's primary key.

```json
{
  "entry_id": "entry-001",
  "storage_root_id": "nas-books",
  "relative_path": "Author/Title.zip"
}
```

| Device | Mapping for storage root nas-books | Resolved path |
| --- | --- | --- |
| Linux server | `/mnt/nas/books` | `/mnt/nas/books/Author/Title.zip` |
| Windows client | `B:\Books` | `B:\Books\Author\Title.zip` |
| Windows client using a network path | `\\nas\books` | `\\nas\books\Author\Title.zip` |
| macOS client | `/Volumes/Books` | `/Volumes/Books/Author/Title.zip` |

Mappings are scoped by server instance and storage root to prevent accidental reuse when switching between servers with similarly named roots. A client joins its mapped root path with the relative path; it does not perform arbitrary string replacements on the server's absolute path.

Root IDs are unique within a server instance, including across libraries. A sole-successor server migration preserves this namespace; an independently running clone gets a new one. Follow the lifecycle rules in [Cross-device consistency](synchronization.md) rather than inferring identity from a server URL or root label.

API relative paths use `/` separators and preserve filename case and original characters. Native filesystem APIs handle platform path conversion. Reject absolute paths, parent-directory traversal, and paths that resolve outside the configured root. Initial scanning does not follow symbolic links or junction directories, avoiding traversal outside the root and duplicate scans. Report filenames that the current device cannot represent or access without modifying the source names.

Server mappings are used for scans; client mappings are used for opening files. They are configured independently. Before reading, the client checks its own path and distinguishes a missing mapping, disconnected share, insufficient permissions, and missing file. Changing a mapping affects resolution without rewriting entries' relative paths.

## Open Design Questions

- How does setup help the user verify that two device mappings refer to the same storage root?
- How should overlapping roots, case differences, and filesystem name differences be detected and explained?
- What happens to mapping configuration when a root is removed, and how is the user guided through reconnecting to a migrated server or configuring an independent clone?

## Related Topics

- [Indexing](file-indexing.md) discovers files through server mappings. [External reading](external-reading.md) resolves client mappings. [Data model](data-model.md) stores stable identities and relative locations.

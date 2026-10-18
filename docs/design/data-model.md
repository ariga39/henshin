# Data Model and Persistence

This document owns entity identities, relationships, persistence rules, and database constraints. Domain terms remain defined in the glossary.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Entities and Relationships

The following table describes data responsibilities and relationships. Concrete database schemas will be detailed before implementing persistence.

| Entity | Main fields or relationships | Constraints |
| --- | --- | --- |
| Library | Library ID, name, associated storage roots | A library can contain multiple storage roots; the number of user-visible libraries is a separate product choice |
| Storage root | Root ID, owning library ID, name, server mapping, scan options | Belongs to exactly one library; stable root ID unique within a server instance; avoid overlapping scan scopes within a library |
| Library entry | Entry ID, root ID, relative path, format, size, modification time, local page count, file fingerprint, file status, content version | At most one current entry association per root and path; separate entries for language editions and revisions |
| EH gallery | Source, gid, token, both titles, category, site page count, raw response, retrieval time, sync status | EH and EX belong to one source identity system; preserve the access URL without duplicating galleries by domain |
| Gallery binding | Entry ID, gallery ID, binding origin, confirmation time | At most one gallery per entry initially; multiple entries may bind to the same gallery |
| Tag and association | Namespace, original text, gallery or entry association, translated aliases | Namespace and original text determine identity; translations are not primary keys |
| Local override | Entry ID, title override, added tags, hidden source tags, notes, revision | Stored separately from EH data; distinguish an empty value from removing an override |
| Open event | Event ID, entry ID, device ID, occurrence time, server receipt time | Unique event ID; retries do not increase the count |
| Background task | Type, target, status, progress, attempt count, next attempt time, error | Recoverable after restart; coalesce duplicate triggers for the same target |

Store file page counts separately from EH page counts, and overridden titles separately from source titles. Aggregate statistics from open events; cached counts can be rebuilt. Search indexes and thumbnails are also rebuildable data.

The first release does not automatically merge entries by EH gid, identical titles, or similar covers. Identical files may be flagged as duplicates, but the user must decide whether to merge entries and how to handle their history.

An unchanged path does not establish unchanged entry identity. A verified representation change of the same edition may retain the entry ID, binding, overrides, and history. Replacement by another edition requires a distinct entry; previous records remain associated with the previous edition. An ambiguous replacement must preserve existing records without silently attributing them to the new content. Resolve the classification evidence and user-resolution workflow jointly with indexing before implementing file-update persistence. Historical locations must not compete with a new entry's current location.

## Database Direction

SQLite is the proposed database, stored on the server machine's local disk. Clients access it only through the API. Do not place the live database on a NAS share or have desktop clients open it directly.

Use WAL mode and short, batched write transactions. Coordinate writes within the server because SQLite permits one writer at a time. Keep source responses as JSON where useful for tracing or reparsing, while using relational tables for entities and tag associations. Store thumbnail files outside the database and record their references and versions.

Search indexing is specified in [Search](search.md). Define schemas, indexes, and migration rules after the entity relationships and lifecycle rules have been resolved, before implementing persistence.

## Open Design Questions

- Should an entry have exactly one file location initially, and how are identical copies and historical locations represented without merging editions?
- Does the first release expose one library or several user-visible libraries? Keep this separate from support for multiple storage roots; do not add user accounts or ownership fields merely to anticipate a multi-user release.
- What are the lifecycle rules for missing entries, explicit removal, rebinding, and retention of open history?
- What concrete constraints and transaction boundaries protect bindings, tag updates, and event deduplication?
- How are schema migrations and consistent backups performed without losing identity or history?

## Related Topics

- [Indexing](file-indexing.md) identifies file changes. [EH metadata](eh-metadata.md) defines bindings and overrides. [Synchronization](synchronization.md) defines revision and event semantics. [Delivery](delivery-and-validation.md) owns backup and restore acceptance.

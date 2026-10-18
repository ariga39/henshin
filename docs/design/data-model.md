# Data Model and Persistence

This document owns entity identities, relationships, persistence rules, and database constraints, including which editable records carry revisions and how those revisions advance atomically. Synchronization owns the client conflict protocol. Domain terms remain defined in the glossary.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Entities and Relationships

The following table describes data responsibilities and relationships. Concrete database schemas will be detailed before implementing persistence.

| Entity | Main fields or relationships | Constraints |
| --- | --- | --- |
| Library | Library ID, name, associated storage roots, library change revision | A library can contain multiple storage roots; the number of user-visible libraries is a separate product choice |
| Storage root | Root ID, owning library ID, name, server mapping and mapping revision, scan options | Belongs to exactly one library; stable root ID unique within a server instance; active server mappings cannot overlap, including across libraries |
| Library entry | Entry ID, date added, root ID, relative path, format, size, modification time, local page count, file fingerprint, identity state, server availability observation, content version, location revision | At most one current entry association per root and path; separate entries for language editions and revisions; date added survives relocation and metadata changes |
| EH gallery | Source, gid, token, both titles, category, site page count, raw response, retrieval time, sync status | EH and EX belong to one source identity system; preserve the access URL without duplicating galleries by domain |
| Gallery binding | Entry ID, gallery ID, binding origin, confirmation time | At most one gallery per entry initially; multiple entries may bind to the same gallery |
| Tag and association | Namespace, original text, gallery or entry association, translated aliases | Namespace and original text determine identity; translations are not primary keys |
| Local override | Entry ID, title override, added tags, hidden source tags, notes, entry edit/decision revision | Stored separately from EH data; binding/override edits share the entry revision; distinguish an empty value from removing an override |
| Device label | Device ID, display label, edit revision | Instance-local diagnostic registry; no authentication authority; label changes retain event provenance IDs |
| Open event | Event ID, entry ID, device ID, observed location revision, observed content version, occurrence time, server receipt time | Unique event ID within the server instance across all entries/devices; retries do not increase the count; observed versions never reassign entry ownership |
| Background task | Type, target, status, progress, attempt count, next attempt time, error | Recoverable after restart; coalesce duplicate triggers for the same target |

Store file page counts separately from EH page counts, and overridden titles separately from source titles. Aggregate statistics from open events; cached counts can be rebuilt. Search indexes and thumbnails are also rebuildable data.

The desktop also owns a separate SQLite store on its local disk for its installation identity and durable launch/event journal. Installation identity is shared across server connections; journal records are isolated by server instance. Prepared or unresolved launch intents are not server open events and cannot be replayed after restart; only accepted-handoff events enter the delivery queue. Preserve immutable event payloads until acknowledged and never evict pending events silently. This topic owns that client store's transactions, migrations, and storage-retention constraints as well as server persistence; the server-database access rule below does not forbid client-local storage. Its transaction/retention design must implement the [external-reading crash rules](external-reading.md) separately from server event aggregation.

The first release does not merge entries or transfer their history, whether they share an EH gid, similar titles/covers, or identical bytes. Duplicate detection may flag candidates for inspection, but copies remain separate entries under the [entry lifecycle](entry-identity.md).

The [entry lifecycle](entry-identity.md) owns identity decisions: one current location per entry, explicit resolution of changed representations, distinct entries for replacement editions, and retained detached records. Historical locations do not compete with current claims. Model its candidate/version checks and atomic resolution before implementing file-update persistence.

[Indexing](file-indexing.md) also requires durable scan generations, staged discoveries, per-scope completion/errors, accepted observation tokens, and versioned fingerprint profiles. Keep staged paths separate from current entry claims until reconciliation commits; a restart cannot convert an incomplete scan into missing-file evidence. Exact table layout and deduplication constraints belong to the schema refinement.

## Database Direction

SQLite is the proposed database, stored on the server machine's local disk. Clients access it only through the API. Do not place the live database on a NAS share or have desktop clients open it directly.

Use WAL mode and short, batched write transactions. Coordinate writes within the server because SQLite permits one writer at a time. Keep source responses as JSON where useful for tracing or reparsing, while using relational tables for entities and tag associations. Store thumbnail files outside the database and record their references and versions.

Search indexing is specified in [Search](search.md). Define schemas, indexes, and migration rules after the entity relationships and lifecycle rules have been resolved, before implementing persistence.

## Open Design Questions

- How are current claims, last-known locations, and pending replacement candidates represented under the entry-lifecycle invariants?
- Does the first release expose one library or several user-visible libraries? Keep this separate from support for multiple storage roots; do not add user accounts or ownership fields merely to anticipate a multi-user release.
- How are missing and detached entries retained under the entry-lifecycle rules, and how does binding revision storage support metadata correction?
- What concrete constraints and transaction boundaries protect bindings, tag updates, and event deduplication?
- How is the shared entry edit/decision revision stored and advanced for binding, override, and lifecycle mutations, separately from source-gallery snapshot revisions?
- How are schema migrations and consistent backups performed without losing identity or history?

## Related Topics

- [Indexing](file-indexing.md) identifies file changes. [EH metadata](eh-metadata.md) defines bindings and overrides. [Synchronization](synchronization.md) defines revision-check submission, conflict responses, and event delivery. [Delivery](delivery-and-validation.md) owns backup and restore acceptance.

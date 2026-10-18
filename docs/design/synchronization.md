# Cross-device Consistency

This document owns shared-server consistency, concurrent metadata edits, disconnection behavior, event delivery, and isolation between service instances.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Shared State and Reconnection

Clients query the same server database for consistent library information and local overrides. HTTP responses carry revision or version information; change notifications prompt clients to refresh affected entries. Notifications are refresh hints. After reconnecting, clients query the current view and relevant state again rather than assuming every notification was delivered.

While disconnected, clients can browse cached entry information and attempt to open NAS files through their device mappings. The first release does not promise full-library search while disconnected. Pending events are isolated by server instance so switching servers cannot upload events to another library.

Local and remote servers running as separate instances are not automatically synchronized replicas. Clients use one authoritative server for cross-device consistency.

## Migration and Independent Copies

A migration replaces the authoritative server: stop the original instance before activating its successor. Preserve the server instance ID, entry IDs, and persisted event IDs, then configure the successor's filesystem mappings. Clients explicitly reconnect to the authenticated successor and verify its instance identity; their existing mappings and pending events remain in the same namespace. A changed host or URL alone does not require a new identity. Instance ID is a data namespace, not proof of authentication.

A clone intended to operate independently must receive a new server instance ID before clients connect. Do not automatically transfer client mappings or pending events to that clone, even if its entry IDs originated from a copied database. Copying a database and running both copies with the same instance ID is not a supported migration procedure.

Restoring a backup as the sole authoritative instance preserves its identity but restores data only to the backup point. Previously acknowledged events after that point may be absent and cannot be assumed recoverable from client queues. Define cache refresh and pending-event reconciliation for restored state before implementing restore; never reassign an event for a missing entry to another entry by filename.

## Concurrent Editing

Edits use server-side revision checks. A client submits the revision it originally read; if that revision is stale, prompt it to refresh and reapply the edit instead of silently overwriting another device's changes. Metadata editing is unavailable while disconnected in the first release, so offline edit merging is unnecessary.

Revision protection is a prerequisite for exposing mutable metadata commands, including overrides and binding corrections. It is delivered with those commands in Phase 2, rather than waiting for Phase 3 notifications and reconnection work.

## Open Design Questions

- What revision granularity is used for edits, and what conflict response lets users recover their changes?
- What event acknowledgement, partial-batch failure, retry, and pending-queue persistence rules are required?
- Which metadata is cached for disconnected use, and how is stale information presented after reconnecting?
- How does the migration/clone workflow enforce the identity rules, and how do clients refresh cached state and reconcile pending events after an older backup is restored?

## Related Topics

- [External reading](external-reading.md) defines event creation. [Data model](data-model.md) owns revisions and unique identifiers. [API and tasks](api-and-tasks.md) defines submission and notification contracts.

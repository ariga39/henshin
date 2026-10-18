# Cross-device Consistency

This document owns shared-server consistency, concurrent metadata edits, disconnection behavior, event delivery, and isolation between service instances.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Shared State and Reconnection

Clients query the same server database for consistent library information and local overrides. HTTP responses carry revision or version information; change notifications prompt clients to refresh affected entries. Notifications are refresh hints. After reconnecting, clients query the current view and relevant state again rather than assuming every notification was delivered.

While disconnected, clients can browse cached entry information and attempt to open NAS files through their device mappings. The first release does not promise full-library search while disconnected. Pending events are isolated by server instance so switching servers cannot upload events to another library.

Local and remote servers running as separate instances are not automatically synchronized replicas. Clients use one authoritative server for cross-device consistency. Server migration uses backup and restore to retain instance and entry identities.

## Concurrent Editing

Edits use server-side revision checks. A client submits the revision it originally read; if that revision is stale, prompt it to refresh and reapply the edit instead of silently overwriting another device's changes. Metadata editing is unavailable while disconnected in the first release, so offline edit merging is unnecessary.

## Open Design Questions

- What revision granularity is used for edits, and what conflict response lets users recover their changes?
- What event acknowledgement, partial-batch failure, retry, and pending-queue persistence rules are required?
- Which metadata is cached for disconnected use, and how is stale information presented after reconnecting?
- How should restoring or cloning a server affect instance identity, mappings, and pending events?

## Related Topics

- [External reading](external-reading.md) defines event creation. [Data model](data-model.md) owns revisions and unique identifiers. [API and tasks](api-and-tasks.md) defines submission and notification contracts.

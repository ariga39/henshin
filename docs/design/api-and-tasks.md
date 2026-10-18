# API Contracts and Background Tasks

This document owns client/server contracts, local Electron capability boundaries, task execution, retries, cancellation, and change notifications.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## API Responsibilities

The following interface responsibilities are a draft. Endpoint paths and response fields will be detailed before implementation.

| Interface group | Typical operations |
| --- | --- |
| Server connection | Read instance ID, version, capabilities, and authentication status |
| Libraries and storage roots | Query libraries, configure server root paths, check accessibility, trigger scans |
| Entries | Paginated search, details, local override editing, relocation of missing files |
| Thumbnails | Retrieve covers by entry and thumbnail version |
| EH | Search candidates, establish or correct bindings, refresh metadata individually or in batches |
| Open events | Submit event batches and return acceptance or failure for each event |
| Tasks and changes | Query, cancel, or retry tasks; subscribe to task and entry changes |
| Data maintenance | Create consistent backups and export metadata; restore through a maintenance workflow |

Do not expose remote command execution or arbitrary absolute-path file downloads. Launching a reader is a local client capability, not a server API operation.

Define shared transport schemas and typed endpoint declarations with Effect, including expected public error variants. Validate HTTP and IPC boundaries without exposing server entities or raw Effect failure causes. Effect HttpApi and its typed client are the preferred direction; package selection and runtime boundaries are specified in [Application logic with Effect](application-logic.md).

## Background Execution

Run scanning, archive processing, and image processing in background workers to avoid blocking interaction and API requests. Persist task state and recover unfinished tasks after server restarts. Do not run concurrent scans of the same storage root. Apply separate concurrency limits to EH updates and file analysis so slow NAS reads do not consume every task resource.

Effect coordinates task execution, bounded concurrency, interruption, and retry schedules. Fibers do not replace workers for blocking processing, and in-memory queues do not replace persistent task state. Disconnecting a client or cancelling a request does not automatically cancel an accepted background task or roll back a committed operation.

## Open Design Questions

- What endpoints, request/response fields, validation errors, pagination fields, and revision checks form the first API contract?
- What are the exact task states and valid pause, cancel, retry, and restart transitions?
- Which operations need idempotency, coalescing, or per-root serialization, and how are partial results reported?
- What notification transport and reconnect behavior are required, and which narrow methods belong in the Electron preload bridge?

## Related Topics

- [Architecture](architecture.md) owns process and authentication boundaries. [Data model](data-model.md) owns persisted state. [Indexing](file-indexing.md), [EH metadata](eh-metadata.md), and [Synchronization](synchronization.md) define task and consistency semantics.

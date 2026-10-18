# Application Logic with Effect

Effect is the preferred foundation for server and frontend application logic. This document owns service composition, runtime lifetimes, error handling, and the boundary between React, Electron, and server workflows. Electron and React remain the selected desktop technologies.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Responsibilities

| Layer | Responsibility | Effect integration |
| --- | --- | --- |
| React UI | Render results, collect input, manage focus and transient interaction state | Invoke application operations through a small binding layer; subscribe to their state |
| Renderer application logic | Search requests, metadata commands, task subscriptions, coordination of local open actions | Effect programs with explicit dependencies, expected errors, cancellation, and connection-scoped resources |
| Electron main process | Device path resolution, file checks, reader launch, local server lifecycle, durable local event storage | Effect services around local capabilities, exposed through a narrow preload API |
| Independent server | Library operations, EH integration, persistence, task orchestration | Effect services composed with Layers and owned by the server lifecycle |
| Shared contracts | Transport data, request and response schemas, public error variants | Effect Schema and typed HTTP declarations; no server-only dependencies |

Keep deterministic domain calculations as ordinary pure TypeScript functions where useful. Use services at actual dependency boundaries, such as filesystem access, persistence, HTTP access, and reader launch. Do not create a service or Layer for every helper or React component.

## Composition and Runtime Lifetimes

Express application workflows as Effects and compose their dependencies with Layers. Execute them at entry points such as HTTP handlers, task runners, Electron IPC handlers, and React integration code. Avoid starting unrelated runtimes inside domain services.

The server, Electron main process, and each renderer have separate runtime lifetimes. A renderer runtime cannot grant Node.js privileges or share live services across IPC. Transport only validated, serializable data across HTTP and IPC; do not send Effect values, runtime objects, database handles, or raw failure causes.

Use a lifecycle-managed runtime at framework boundaries. Effect documents `ManagedRuntime` for reusing service composition in environments such as React. In Henshin, connection-specific resources belong to the selected server session and are disposed or replaced when that session changes. [Effect runtime documentation](https://effect.website/docs/v4/runtime)

Client requests and subscriptions must not outlive their owners. Dispose renderer resources when a window closes, and release server and main-process resources during shutdown. Persist pending open events before disposing the component that sends them. A cancelled UI request must not be interpreted as a rollback of a server operation already committed.

## Frontend State and Operations

React retains transient presentation state such as an expanded panel, focus, or an unsubmitted form field. Effect owns asynchronous application workflows and their expected failures. Keep these workflows outside view components so they can be exercised without rendering the UI.

Select one owner for remote query caching and subscription state. Evaluate Effect's React integration against the chosen package versions before selecting bindings; do not introduce competing caches or a custom state framework by default. The binding must expose loading, successful, stale, failed, and interrupted operations where those states affect the user.

For search, a newer query supersedes the older display request. Interrupt work where supported and reject obsolete results so they cannot replace the current view. A read request may be retried according to policy. Commands require operation-specific retry rules: submitting an existing open event is safe to repeat with its event ID, but launching a reader again is a new external action.

An Open command resolves to the Electron capability, which checks the local path and launches the reader. Once accepted by the operating system, the resulting event is persisted locally and submitted independently of the originating React component. The reader remains usable even if the details screen is closed.

## Server Logic and HTTP Direction

The preferred backend is an independent Node.js/TypeScript process using Effect, with SQLite persistence. First evaluate Effect's `HttpApi`, typed client, and Node HTTP adapter as the HTTP stack. Fastify is no longer the default proposal; add a separate HTTP framework only if validation exposes a concrete requirement the Effect stack does not meet.

Effect's HTTP client derives operations and request/response codecs from shared API declarations. Use that contract to connect client application logic to server use cases, while keeping database entities and private errors internal. [HttpApi](https://effect.website/docs/v4/api/effect/http-api/HttpApi), [HttpApiClient](https://effect.website/docs/v4/api/effect/http-api/HttpApiClient), and [HttpServer](https://effect.website/docs/v4/api/effect/http/HttpServer) describe this integration.

The referenced v4 HTTP modules are marked unstable. Select and pin a compatible Effect release and adapter set before implementation; verify the actual APIs and packaging together. These references establish an architectural direction, not a completed dependency or version selection. Do not mix examples or import paths from different Effect major versions.

## Errors and Resource Handling

Represent expected failures with explicit types, for example an unavailable storage root, a missing mapping, an expired EH session, a revision conflict, or a reader launch failure. Map them to public HTTP or IPC errors and then to user-facing states. Unexpected defects remain diagnostic failures; do not disguise them as successful empty results or retry them indefinitely.

Validate data at HTTP, IPC, configuration, and external-response boundaries using schemas. Within a validated application flow, rely on typed values instead of repeatedly decoding the same object. Layer implementations translate third-party Promise failures into the application's error model and connect cancellation where the underlying operation supports it.

Use scoped resource handling for connections, subscriptions, and temporary processing resources. Database transactions remain responsible for database atomicity. Interruption must respect commit boundaries, and an interrupted archive decoder may require explicit worker or process cleanup.

## Concurrency and Durable Work

Effect coordinates concurrent I/O, bounded work, retry schedules, and interruption. Fibers do not make synchronous CPU-heavy work run on another thread. Archive decoding and image processing still need appropriate workers or subprocesses when they would block the event loop. [Effect fibers](https://effect.website/docs/v4/concurrency/fibers)

In-memory queues and fibers are not the durable task store. Persist task identity, progress, and recovery state in SQLite, and reconcile interrupted tasks after a restart. Keep the first implementation within the existing server architecture rather than adopting an additional workflow engine without a demonstrated need.

## Validation Before Adoption Details Are Finalized

- Exercise one shared-schema endpoint from a renderer-side Effect client through a Node HTTP adapter to a SQLite-backed server operation.
- Verify renderer mount/unmount and server switching release resources, ignore obsolete search results, and do not duplicate subscriptions or commands under React development checks.
- Verify typed errors survive HTTP and IPC encoding without exposing private causes or credentials.
- Verify request interruption, task cancellation, database commit handling, and restart recovery as separate behaviors.
- Verify native SQLite and archive dependencies in the independent server and Electron packaging on the target platforms.

## Open Design Questions

- Which compatible Effect release, Node adapter, React binding, and SQLite integration should be pinned after the integration prototype?
- What owns frontend remote state and caching, and how are its lifecycle and invalidation rules exposed to React?
- What service boundaries are justified by the first end-to-end workflows, without adding unused abstractions?

## Related Topics

- [Architecture](architecture.md) owns deployment and process boundaries. [API and tasks](api-and-tasks.md) owns wire contracts and task state machines. [User interface](user-interface.md) owns visible behavior. [Data model](data-model.md) owns persistence and transaction rules.

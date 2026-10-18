# Product Scope and Scenarios

This document owns confirmed product requirements, proposed first-release defaults, and the boundary between the initial release and later work.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Confirmed Requirements and Proposed Defaults

Confirmed requirements:

- A cross-platform desktop client with a client/server architecture. The server can run independently on the same computer or another machine.
- Electron for the desktop application, with React and TypeScript for the UI.
- File storage and server location are independent. Collection files currently reside on a NAS, and the server and clients may access the same directory through different paths.
- File indexing, thumbnails, EH information and tag retrieval and updates, search, and open counts.
- Reading through an external reader on the client device, with no built-in viewer.
- Synchronization of EH metadata, library information, and records across devices.

Proposed defaults for the first release:

- One user, one authoritative server, and multiple clients. Clients can configure and switch server connections; separate servers retain independent data.
- The server can access the NAS and performs scans. Clients can access the NAS and open files. The operating system manages mounts and share credentials.
- Indexing reads source files without automatically moving, renaming, deleting, or modifying archives.
- Open counts are aggregated per user and library entry across devices.
- Metadata editing requires a server connection. While disconnected, clients can open accessible files for cached entries and queue open events.

These defaults provide an implementation starting point. They do not introduce requirements for multiple users, content synchronization, or merging distributed libraries.

## Feature Scope

| Area | First release | Later extensions |
| --- | --- | --- |
| Connections and libraries | Local server startup, remote connections, multiple storage roots, device-specific path mappings | Merging libraries across independent servers |
| Indexing | Manual and scheduled scans, incremental updates, directory exclusions, missing-file status, manual relocation | Similarity-based deduplication, automatic file organization |
| File formats | Image directories and ZIP/CBZ; RAR/CBR and 7z after cross-platform validation | PDF, EPUB, nested archives |
| Thumbnails | Cover extraction, caching, selecting another page as the cover | Per-page thumbnails and previews |
| EH metadata | URL binding, batch retrieval, candidate matching, binding corrections, manual and scheduled refresh | Other sources, EH favorites synchronization |
| Tags and search | Namespaced tags, combined filters, title and filename search, personal tags, Chinese aliases | Similarity recommendations, advanced statistics |
| Reading and history | Reader settings per device, direct NAS access, open counts and last-opened time | Reader-specific progress reporting |
| Multiple devices | Shared library and records on the server, event retries and deduplication, client refresh | Merging conflicting offline edits |
| Maintenance | Task progress and errors, retries, database backup and restore, metadata export | External plugin system |

Content downloads, content caching, server-side file forwarding, and automatic NAS mounting are outside the current scope. If a path is inaccessible, prompt the user to check its mapping or mount rather than starting a download workflow.

## Core Scenarios

- A user runs the server locally and opens files from a NAS using a desktop reader.
- A user connects to a server on another LAN machine while continuing to open the same NAS files through a device-specific path mapping.
- A second client connects to the same server and sees the shared library and aggregated open history.
- A user binds an entry to an EH gallery, refreshes its source metadata, and retains personal edits.
- A client loses its server connection but can still access the NAS and open a previously cached entry; it submits the open event after reconnecting.

## Open Design Questions

- Which archive formats are mandatory for the first usable release?
- What library sizes and directory layouts should define the initial acceptance dataset?
- Which current first-release defaults need explicit confirmation before detailed design?

## Related Topics

- [User interface](user-interface.md) turns scenarios into user journeys. [Delivery and validation](delivery-and-validation.md) assigns them to implementation phases.

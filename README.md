# Henshin

Henshin is a cross-platform desktop application for managing E-Hentai / ExHentai collections, with independently deployable clients and a server. It provides file indexing, cover thumbnails, EH metadata, search, and open history. Reading takes place in an external reader on the client device.

File storage and server deployment are independent. The current target scenario stores files on a NAS, with each device accessing the same files through its own network path or mount point. The server can run on the user's computer or another machine on the local network.

## Documentation

English is the working language for repository documentation.

- [Design overview and topic index](docs/design.md): navigation and refinement order for 14 separate design documents with behavioral contracts and explicit implementation gates.
- [Domain glossary](CONTEXT.md): shared definitions for libraries, entries, storage roots, path mappings, EH galleries, and open history.

## Current status

The project is in the design phase. This repository does not yet contain a runnable client or server. The desktop client uses Electron with React and TypeScript. Effect is preferred for frontend and server application logic. The proposed backend uses Node.js, Effect's HTTP stack, and SQLite. The design distinguishes confirmed choices from proposed defaults; package versions, framework integration, packaging, native dependencies, and NAS access still require validation.

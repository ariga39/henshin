# Henshin

Henshin is a personal desktop application for managing a household comic collection on a trusted home LAN. The collection remains in user-managed storage such as a NAS, and each device opens files through its own local or mounted path. Collection files are read-only to Henshin; reading uses an external reader.

## Design

The product design and core constraints are in [docs/design.md](docs/design.md).

## Technology

The planned service is a standalone Rust application built with Cargo. The desktop is built with Node.js and pnpm using Electron, React, TypeScript, and esbuild. The service and desktop are separate applications.

## Current status

The repository contains the product design and the desktop workspace dependency setup. The Rust/Cargo service and desktop implementation are not present yet.

The repository requires Node.js 24.19.0 or newer and pnpm 11. Install the locked workspace dependencies with:

```sh
pnpm install --frozen-lockfile
```

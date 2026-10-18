# User Interface and Journeys

This document owns screen structure, navigation, user journeys, and visible loading, empty, error, and disconnected states. The UI uses React in an Electron desktop application.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Screen Structure

| Screen | Content and actions |
| --- | --- |
| Connection and initial setup | Select a local or remote server, configure authentication, add storage roots, configure device paths and reader |
| Library | Cover grid or list, search, tag and status filters, sorting, bulk selection, opening entries |
| Entry details | Titles, original EH tags and translations, file information, source link, local overrides, open count, last-opened time |
| Matching queue | Unbound entries, candidate comparison, gallery URL input, binding confirmation and correction |
| Tasks | Scan, cover extraction, and EH update progress; failure reasons, pause, and retry |
| Settings | Server scan and EH connection settings; device mappings and reader settings; backup and export |

Entry details distinguish the server's file status from accessibility on the current client. An unavailable NAS mount on the server does not necessarily prevent a client from reading. An inaccessible client path does not mean that the library file has been deleted.

## Application Logic Boundary

React owns presentation and transient interaction state. Effect application operations own asynchronous queries, commands, expected errors, and subscriptions outside view components. Keep filesystem and process access behind Electron's preload boundary. Runtime lifetimes, frontend state ownership, and cancellation behavior are specified in [Application logic with Effect](application-logic.md).

## Open Design Questions

- What is the exact first-run journey from connecting a server to opening the first entry?
- Which operations belong on cards, in entry details, and in bulk actions, and how is selection preserved?
- How are unmatched entries, conflicting edits, unavailable mounts, and expired EH authentication resolved in the UI?
- What keyboard navigation, focus behavior, accessibility, and large-library rendering requirements should wireframes cover?

## Related Topics

- [Product scope](product-scope.md) defines scenarios. [Path mappings](path-mapping.md), [EH metadata](eh-metadata.md), [Search](search.md), and [External reading](external-reading.md) own the behavior exposed by these screens.

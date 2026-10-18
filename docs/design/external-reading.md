# External Readers and Open History

This document owns launching readers on the client, determining whether an open request succeeded, and creating usage events. Readers access NAS content directly.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Reader Launch and Event Workflow

1. The user selects Open. The client obtains the accepted entry state and location (cached when disconnected) and resolves it using the device mapping for that server and storage root. Follow [entry-lifecycle checks](entry-identity.md): known pending replacements and detached entries cannot launch; detected local changes require reconciliation.
2. Check file accessibility and reader configuration. Report failures without increasing the open count.
3. Submit an open request using the locally configured executable and an argument array. Pass paths as individual arguments without constructing a shell command. Allow the operating system's associated application as an alternative.
4. After the operating system accepts the launch or open request, create an open event, persist it in the local pending queue, and submit it to the server.
5. The server deduplicates by event ID and updates statistics. The client removes acknowledged events from its queue, and other clients refresh the relevant data.

Each device chooses its reader and argument format independently. Initially, Henshin passes an archive, an image directory, or the directory's first image directly to the reader. The reader must support the chosen format. Henshin does not initially extract entire archives to accommodate readers without archive support.

Open count measures requests successfully handed to the operating system through Henshin, not completed reading sessions. An intentional new open creates a new event; network retries reuse the original event ID. Reader launch and event persistence cannot form an atomic transaction across processes. A crash between them may lose an event, so counts are personal usage records rather than an audit-grade completeness guarantee.

Use device occurrence time for display and retain server receipt time to help diagnose clock differences. Define explicit time zone and ordering rules. Aggregate history across devices by library entry, not directly by file path or EH gallery.

Include the observed location revision and content version with each event. Delayed events retain their selected entry ID even after detachment; they never follow a path to a new entry. Offline caches and filesystem changes between observation and launch limit content verification, as specified in [Entry identity](entry-identity.md).

## Open Design Questions

- Which readers and argument forms must be tested on each desktop platform?
- How are executable selection, argument placeholders, associated applications, and launch errors configured and presented?
- How are rapid repeated actions distinguished from intentional repeated opens?
- Can users inspect or correct open history, and what should last-opened time mean when device clocks disagree?

## Related Topics

- [Path mappings](path-mapping.md) resolve local access paths. [Synchronization](synchronization.md) owns event delivery and deduplication. [User interface](user-interface.md) owns reader setup and error presentation.

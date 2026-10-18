# User Interface and Journeys

This topic owns navigation, screen responsibilities, action placement, interaction states, and accessible recovery journeys for the Electron/React desktop. It implements [product scope](product-scope.md), not an embedded reader. These are functional design defaults; visual assets, exact spacing, and component-library selection remain implementation choices.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Application Shell and Navigation

Use one active server context per window, with a persistent connection indicator and server switcher. The shell exposes Library, Review, Tasks, and Settings. The server's single visible library needs no separate library chooser. Settings clearly separates This device from Server; switching the server does not change local reader profiles or move pending events between namespaces.

| Surface | Primary content and actions |
| --- | --- |
| Connection/setup | Saved connections, local service or remote URL, authentication, compatibility, expected-instance confirmation, setup progress |
| Library | Search, canonical tag chips, filters, sorting, cover grid/list, explicit loaded-item selection, entry details/Open |
| Entry details | Effective title/tags, source versus local values, file observations, identity/location, cover, binding, notes, history, Open and edit actions |
| Review | Separate queues for file identity decisions and EH candidate matching; staged discoveries are not normal library entries |
| Tasks | Scan/analysis/metadata jobs, determinate or indeterminate progress, scoped errors, cancellation/retry, held event delivery diagnostics |
| Settings: This device | Server connections, client root mappings, reader profiles, display/cache preferences, pending-event recovery |
| Settings: Server | Server roots/schedules, EH credentials/status, backup/export and maintenance entry points |

Display raw titles/tags/paths as text, never executable HTML. Source links open only after the URL is validated against the EH domain contract. Copying paths and revealing a target are explicit local actions; they do not count as Open. Remote native paths may be shown as labeled configuration diagnostics, but only the client-resolved path can be passed to a local capability.

## First-run Journey

1. Choose Start local service or Connect to server. Local setup waits for authenticated readiness and shows startup errors with retry/diagnostics. Remote setup collects URL and credentials, validates TLS, protocol compatibility, and instance identity. An unexpected instance requires explicit separate enrollment; do not silently replace existing data context.
2. For a new empty service, add a server storage root. Label its path as the path on the server, not this desktop. Existing libraries skip this step and can be browsed immediately. Run mapping verification and activate the mapping only under [path rules](path-mapping.md); failed verification remains a draft with a reason.
3. Start the first scan explicitly and show its task. Entries/covers appear as accepted results become available; unfinished staging has its own review/progress state. Explain missing/unsupported content without presenting it as a successful empty library.
4. Configure this device's mapping for the same logical root. Show the server root label, logical identity, and verification samples alongside the independently selected local prefix. Do not assume equal absolute paths even for a local service. An unavailable NAS mount leads to OS/mapping recovery, not a download button.
5. Configure a compatible local reader profile and target mode. Present arguments as separate tokens and show the resolved target preview. A profile test is labeled as a local application test and creates no entry open event. System association explicitly warns that opening a directory may show a file manager.
6. Open an accepted entry. Report OS handoff, then pending or server-confirmed event status. First success does not imply completed reading.

Browse/setup progress is resumable. A missing reader or client mapping blocks only Open, not metadata inspection/search. A failed server scan does not require repeating authentication or local reader setup. Settings provide the same flows after first run; the wizard does not become a separate configuration authority.

## Library Interaction and Selection

A single click or keyboard activation on an entry opens details. An explicit Open button or its labeled shortcut launches the external reader. Double-click follows the same details action by default, rather than adding a hidden launch gesture. Space toggles selection when focus is on a selectable item; it does not interfere with text inputs/buttons. Enter on a focused entry opens details, and Enter on an Open button invokes that button. Shortcut help lists platform-appropriate key combinations; shortcuts are suppressed in text editing unless native editing semantics apply.

Search follows [literal substring rules](search.md). Show active tag chips by namespace/original identity with available translated labels; ambiguous alias matches require choosing a canonical candidate. Search text does not parse tag syntax. Invalid include/exclude combinations stay visible with an inline explanation. Changing query/filter/sort resets pagination, clears selection with a visible notice, and returns focus to the initiating control. Debounce may reduce requests, but only the newest applicable response updates results.

Use stable entry IDs for cards, rows, focus, and selection. Grid/list switching preserves loaded IDs and focus where possible. Paging appends live results with ID deduplication; a library revision change shows Refresh results. Refresh replaces the sequence and preserves selected IDs only if they remain in the new loaded set, reporting removals. A visible Load more control supports keyboard/screen-reader pagination even if scrolling also triggers it. Do not display an exact total unless supplied with its request-time scope.

Select all means all currently loaded entries, labeled with the exact selected count; it never implies all matching rows on the server. The first bulk action is metadata refresh. Bulk reader launch, replacement resolution, deletion, and automatic binding are not offered. Before executing, show eligible/skipped IDs and reasons; validate current revisions on the server and report per-item results. A bulk refresh may start one coalesced source-gallery job for several entries. Newly matching entries are never added to the submitted IDs.

## Entry Details and Editing

Show an effective display title plus expandable source titles and filename. An explicit empty title override displays a localized Untitled label while preserving the empty value. The title editor distinguishes Use source/default from Set custom title; clearing an input alone is not the same operation as removing an override. Tag editing distinguishes local additions from hidden source tags and shows the resulting effective set before save. Notes are local overrides. [EH metadata](eh-metadata.md) owns precedence and tag identity.

Present three separate status groups: entry identity (accepted/replacement pending/detached), last server file observation with time, and this device's last local access result with time. Scan exclusion is a separate badge. Unknown local access is not an error until checked; rendering a grid must not probe every NAS path. Open performs the required current checks; an explicit Check access action may refresh a local diagnostic without counting an open.

Metadata forms submit their base revision. On conflict, preserve the unsaved values and show the current server values with Refresh/reapply controls; do not auto-save the old draft over new data. Switching away from a dirty form asks whether to keep a local unsent draft or discard it. Offline drafts remain unsent and visibly stale; offline editing commands are disabled as specified by [consistency](synchronization.md). A restored or changed authority requires refresh before any reapplication.

History lists accepted events separately from locally pending/held events, with occurrence time, receipt time in diagnostics, device label/ID, and delivery state. Count and last-opened statistics retain [search](search.md) semantics. Clock-skew indications explain the two clocks; history has no edit/delete/count-correction controls in this release.

## Review Journeys

### File Identity

The file review queue shows accepted old data and candidate data side by side, clearly labeling old covers as previously indexed. Missing analysis or corrupt/unsupported candidates show the reason and do not invent comparison values. Keep this entry explains that history and overrides follow the accepted representation. Treat as a different entry explains that old history stays in a detached record and the new entry starts unbound. Decide later leaves Open blocked. Stop scanning this location explicitly adds an exclusion without accepting or deleting content.

Enable acceptance decisions only with the required current evidence and revisions; rejected stale decisions reload comparison and preserve the user's prior intent as unsent context. Stop scanning follows its non-accepting revision checks even when analysis fails. Detach a confirmed-missing claim and manual relocation are explicit detail/review actions with their ownership consequences. No action is labeled Delete when it merely detaches/excludes. [Entry lifecycle](entry-identity.md) owns exact transitions and [indexing](file-indexing.md) owns staged/accepted evidence.

### EH Binding and Matching

Unbound entries may accept a validated gallery URL or request candidates. Candidate cards show source title, canonical tags/category, page count, link, and any permitted preview with provenance; no first candidate is preselected for binding. Compare and confirm one candidate. A batch preserves independent per-entry outcomes and does not hide ambiguous or failed matches. Existing bindings are shown before correction; confirm that rebind removes the old source layer immediately and retains local overrides for review.

Authentication failure, rate limit, network failure, and valid empty candidate results are distinct states. Recovery links to server EH settings or retry timing without exposing secret values. Gallery expunged/status flags do not imply local deletion. Translations supplement canonical tags; absence of a translation is not missing metadata. Upstream access/preview restrictions follow the EH topic.

## Open and Failure Presentation

While an Open action is pending, disable repeated launch controls for that entry across local windows and show progress without promising a reader window. A known failed launch has no count; success is labeled request handed to reader/OS. An unknown result after crash/timeout says it may have opened and offers a new explicit Open, never an automatic retry. Closing details does not cancel an already accepted handoff or its durable event processing.

| State | UI behavior and recovery |
| --- | --- |
| Loading | Preserve already displayed data when refreshing; mark it refreshing and avoid empty-state flashes |
| Empty library | Explain no accepted entries yet; offer root/scan setup |
| No query matches | Keep query/chips visible; offer clear filters without resetting mappings |
| Server disconnected | Mark cached view partial/stale, disable shared edits, retain eligible local Open and pending history |
| Authentication/protocol failure | Show connection recovery; do not silently route writes to another server or downgrade to plaintext |
| Missing/suspended mapping | Open device mapping setup for that root; keep server data visible |
| Local target unavailable | Report this device's observation and OS diagnostic; no claim that the library entry was deleted |
| Pending/detached identity | Explain why Open is blocked and link to appropriate review/history |
| Queue full/write failed | Explain event durability state; offer diagnostics/recovery, not an automatic untracked launch |
| Held event after restore | Show original entry/namespace, export/discard consequence, and retry only after reconciliation |
| Stale edit or task result | Refresh current state, retain unsent intent, and show that prior work did not overwrite current data |

Task views show scope, latest progress time, success/failed/skipped counts when known, and retryable versus permanent errors. Indeterminate enumeration must not display a fictional percentage. Offer cancellation only for supported states; pause is not implied before [task contracts](api-and-tasks.md) defines resumable pause. Partial results remain inspectable after cancellation. Cancel request and confirmed cancellation are distinct statuses.

## Accessibility, Scale, and State Ownership

Use semantic buttons, links, inputs, lists/tables, and dialogs with accessible names; translated tags retain namespace/original text for disambiguation. Every pointer action has a keyboard path. Visible focus is never conveyed by color alone. Status/error badges include text, and loading/progress announcements are polite and coalesced rather than announcing each scan result. Error summaries link to invalid controls; dialogs trap focus and restore it to the invoker, or a stable parent if the invoker disappeared. Escape closes a dismissible dialog without silently discarding a dirty form or cancelling committed work.

Grid/list virtualization must preserve logical focus and accessible item identity. Never recycle a focused row into a different entry; keep it mounted or move focus deliberately to the list before removal and announce the change. Keyboard paging must reach all loaded entries and the Load more control. Decorative covers have empty alternative text when the adjacent title names the entry; standalone clickable covers use the entry title as their accessible name. Thumbnails and lists use bounded memory; no full-library DOM or eager full-library NAS checks.

Support text scaling, reduced motion, high-contrast/OS color preferences, and layouts that keep essential actions reachable in narrow windows. Do not announce successful actions only through transient toasts; durable task/event states remain available. Precise visual tokens and localization catalogs are later implementation choices, but layout must tolerate longer translated labels and non-Latin titles. English documentation does not prescribe the application's only UI language.

React owns presentation, focus, and unsent form state. [Effect application logic](application-logic.md) owns connection/query lifetimes, command states, cancellation, and subscriptions; Electron main owns paths, profiles, launch coordination, and the journal through narrow IPC. Do not duplicate authoritative server state in independent component stores or run side effects during render. No component unmount may replay a reader action or discard a pending event.

## Acceptance and Implementation Gates

Exercise first-run local/remote setup; independent server/client paths; initial scan errors; short-CJK/tag searches; live pagination/selection; metadata conflict/rebinding; replacement decisions with stale evidence; offline Open; unknown launch recovery; queue errors; and epoch/restore recovery. Test each with keyboard-only navigation and representative screen readers on the target desktop platforms. Check focus preservation during virtualization, asynchronous refresh, dialog dismissal, and entry disappearance.

Before UI implementation, produce screen-level wireframes/state examples for these journeys, choose tested accessible primitives, and define IPC/public error mappings. Record usability and accessibility evidence in [delivery](delivery-and-validation.md); this document specifies behavior but contains no rendered mockup, measured virtualization performance, or executed accessibility test.

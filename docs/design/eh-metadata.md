# EH Metadata, Bindings, and Local Overrides

This topic owns gallery selection, source snapshots, refresh, effective metadata, and translation aliases. It does not download collection content or change file identity. These are first-release design defaults. [Entry lifecycle](entry-identity.md) owns edition identity; [search](search.md) owns query semantics; [synchronization](synchronization.md) owns transport conflict responses.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Source Contract and Evidence

The [EHWiki API page](https://ehwiki.org/wiki/API), inspected on 2026-10-18, documents JSON POST requests to `https://api.e-hentai.org/api.php`, `gdata` requests containing gallery IDs/tokens, batches of at most 25, and `namespace: 1` for namespaced tags. It describes per-item errors and shows parent/current gallery references. Its request-frequency guidance is approximate, not a service-level guarantee. This was documentation inspection, not a live authenticated EH/EX integration test.

Use that documented metadata endpoint initially; do not infer a separate ExHentai API endpoint from a pasted page URL. Gallery page access/search and metadata retrieval are different adapters with separate capability/error reporting. Validate restricted-gallery behavior with permitted test accounts before implementation; the design does not promise that all inaccessible galleries are available through `gdata`.

The canonical source key is `(source, gid)`, with `source = EH` for both EH and EX page domains. A token is a request credential/locator for that gallery, not a separate edition or primary key. Preserve the confirmed page domain as the user's preferred access link. Conflicting tokens for one gid require verification before replacing a working token; do not create duplicate galleries just because the domain or token differs.

## URLs, Imports, and Candidate Selection

Accept gallery URLs only from the exact supported hosts `e-hentai.org` and `exhentai.org`, using the gallery path shape `/g/{gid}/{token}/`. Parse the structure, preserve the exact ID, validate bounded token syntax, remove query/fragment noise, and store a canonical HTTPS gallery link. Reject userinfo, unexpected ports/hosts, malformed identifiers, and extra path structures. Legacy HTTP input may be normalized to HTTPS without making an HTTP request. Image-page URLs need a separate token-resolution feature and are not accepted as gallery URLs initially. Never issue a fetch to an arbitrary pasted URL or forward credentials to its redirects.

Pasting a valid URL and choosing Bind is an explicit user confirmation; it does not need a second candidate-picker confirmation. Save the binding even if its first metadata request fails, showing the source URL and pending/error state rather than inventing a title. Correcting or removing a binding is also explicit. A binding never proves that the file is a complete or matching edition.

Sidecar import adapters may propose URLs with filename/format provenance, but discovery does not silently bind them. Conflicting URLs or disagreement with an existing binding require user selection. Implement specific sidecar formats only after representative downloader samples establish a requirement; manual URL binding works independently of them.

For unbound entries, candidate search is an explicit server operation using a user-reviewable title, author, and language query. Initial scans do not submit the entire collection to EH search. Show candidates' source URLs, titles, language evidence, source page counts, and rating when available, alongside local analysis. Rank results as suggestions; only the selected candidate becomes a binding. A failed search or no results is not a binding failure and changes no existing metadata. Candidate image previews are optional; URL/text comparison remains usable if they cannot be fetched safely.

Image-hash matching requires a separately validated search adapter and explicit user initiation; no original images are uploaded as part of matching. The title-search adapter must handle access failures and changed page layouts without breaking known-URL metadata refresh. Exact parsing fixtures and supported query forms are implementation gates, not assumed framework capabilities.

## Ownership and Effective Values

Keep three layers separate: a gallery's last successful source snapshot, an entry's binding, and that entry's local overrides. One gallery snapshot can serve several independently managed entries; changing it must not copy their notes/history between entries. Local page count and format always come from indexing, separately labeled from EH values.

| Field | Effective rule |
| --- | --- |
| Display title | Explicit local title override, otherwise nonempty source Japanese title, otherwise source primary title, otherwise filename/directory name |
| Source titles | Preserve both fields and display their origin even when a local title overrides the main display |
| Category, publication time, site rating, uploader, source page count | Source-only values; unknown when absent, not fabricated from filename or local file size |
| Notes | Entry-local only; never sent to EH |
| Tags | Apply the set rule below to canonical source tags and entry-local changes |
| Language | Derive language facets from effective canonical language tags; no guessing from UI locale or filename |

The source-title preference above is a labeled first-release default. Sorting uses the effective display title unless the search topic explicitly defines another sort. Source/filename matching remains possible even when display is overridden. An explicit empty title override remains distinguishable from removing the override: preserve the empty value, show an Untitled placeholder, and expose source titles separately. Clearing the override restores fallback behavior; whitespace-only input is treated as explicit empty after trimming. Notes may be empty without affecting other fields.

Let `S` be current source tags, `H` source-tag suppressions, and `A` locally added tags, whether canonical EH tags or local-namespace tags. Effective tags are `(S minus H) union A`. Canonical identity is namespace plus original tag text; translations are aliases, never keys. For canonical EH tags, an add removes that tag from `H`; hide/remove removes it from `A` and adds it to `H` so a subsequent source refresh cannot resurrect it unexpectedly. Hiding an absent canonical EH tag keeps a suppression for later reappearance. For `local`-namespace tags, add changes only `A`, and remove deletes the addition from `A` without creating a suppression; `H` contains only canonical EH tags. Resetting a tag override removes it from both local sets. Keep local-only tags in a distinct `local` namespace; they do not become EH source tags or translations.

Example using neutral names: source `artist:alpha` is hidden, source refresh adds `artist:beta`, and the user adds `local:favorite`. Effective tags are `artist:beta` and `local:favorite`; removing the source-tag suppression restores `artist:alpha` if still present upstream. Removing `local:favorite` deletes its addition without leaving a suppression, and adding it again restores only that local addition. Source removal never deletes a local addition of the same canonical tag. The first release edits personal tags per entry; batch personal tag editing is deferred by [UI scope](user-interface.md). If later introduced, it must apply this rule independently per entry with per-entry conflicts.

## Binding Changes and Entry Revisions

Binding and override commands use the same entry edit/decision revision as other entry-level mutations, preventing a stale form from editing a newly replaced/rebound entry without review. Source-gallery refresh has its own gallery revision and does not itself overwrite or increment local override data. [Persistence](data-model.md) defines the storage/transaction implementation; [API contracts](api-and-tasks.md) defines validation and conflict payloads.

A corrected binding atomically switches the entry's source reference and refreshes its effective projection. Local title, notes, added tags, and suppressions remain for explicit user review; identify that they were carried across a rebind and offer reset. Do not retain tags from the old source in the new projection. If the new gallery has no successful snapshot, source fields are unknown/pending and effective values use only filename/local overrides until retrieval succeeds. Keep the previous gallery snapshot for other bindings and diagnostics, but never display it as the new gallery's data.

Removing a binding clears the source layer for that entry and preserves its local overrides and history. A repeated command with the same operation ID returns its prior outcome; a genuinely new command with a stale revision conflicts. Binding changes do not alter the file's content/location versions or cause content downloads. Source version relationships are informational: discovering a newer gallery never automatically rebinds older files.

## Refresh, Concurrency, and Failure

Refresh works per gallery, not per entry copy. Coalesce concurrent triggers for the same gallery and request credential generation. Serialize requests per gallery so an older response cannot replace a newer accepted snapshot. A credential/token update invalidates older request generations. A late refresh for gallery A may still update A for other entries after one entry switches to B, but it cannot mutate that entry's current binding or apply A's tags to it.

For each response item, validate the returned gallery identity and required snapshot shape before publication. Match by identity, never array position. A missing/duplicate/mismatched item is a protocol failure for that target; successful peers in the batch may commit independently. Preserve absent optional scalar fields as unknown. Require a valid complete tag array for a successful tag replacement; a valid empty array clears source tags, while a missing/malformed array preserves the old snapshot and reports failure. Store the bounded raw successful response and retrieval time for traceability, plus a separately recorded latest error and last-attempt time.

Publish source fields, source-tag associations, and gallery revision atomically. Derived effective metadata/search rows use the current binding and overrides, never a request-time copy. Commit derived updates with the source transaction when practical; otherwise mark affected projections stale and rebuild conditionally from current versions before presenting them as current. No request failure may erase last successful source data. A valid new snapshot replaces source values; it does not overlay absent fields with potentially stale values from an older snapshot.

| Outcome | Policy |
| --- | --- |
| Valid item | Replace that gallery snapshot; preserve entry overrides and expose retrieval time |
| Valid snapshot carries an `expunged` flag | Preserve and display the source flag; it does not prove local deletion or prevent publishing otherwise valid metadata |
| Invalid token or explicit gallery-level error | Preserve prior data, flag that gallery, require corrected locator or explicit retry |
| Expired credentials or access challenge established by adapter evidence | Pause affected authenticated tasks until credentials/access are repaired |
| Access denied or unavailable gallery | Preserve data; expose the adapter's known cause, or unknown access failure when ambiguous |
| Timeout, transient server failure, or rate-limit response | Bounded delayed retry; honor server-provided retry timing when available |
| Malformed response, unexpected redirect, or parser/layout change | Stop that attempt, retain data, report adapter/protocol failure rather than treating it as an empty gallery |

Do not equate all HTTP failures or empty pages with authentication expiry, deletion, or a ban. Only adapter evidence of terminal source unavailability pauses that gallery's automatic refresh until an explicit retry or locator correction; an expunged flag alone is not such evidence. Error classifiers need fixtures and diagnostics before deployment. The UI presents last success and latest failure separately, so stale metadata is useful without appearing freshly synchronized.

## Scheduling and Credentials

Manual refresh is available for selected entries or all bound galleries. Scheduled refresh is disabled by default until the user configures it; it targets known bindings, not candidate discovery. Use one bounded EH scheduler for metadata, search, and optional previews so multiple windows/tasks do not multiply request pressure. The initial conservative proposal is one in-flight EH request and at least five seconds between starts, with response-driven backoff; this is Henshin policy, not a guaranteed safe service quota. The integration prototype must validate rate handling and choose bounded retry counts/delays before implementation. Never rotate accounts, proxies, or domains to evade access limits.

Store EH cookies/credentials and proxy configuration on the server, scoped to the configured source connection. Client configuration transmits changes only through authenticated encrypted remote transport or the protected local connection. Secrets are not returned in normal settings reads, source caches, exports, or logs; display only configured/expired status. Restrict cookie attachment to the intended supported origin and validate redirects before following them. Changing credentials resumes eligible tasks under a new generation and does not silently clear earlier failures or bindings.

Remote preview URLs are untrusted input. Before enabling previews, constrain origin/redirects, response size/type, cache storage, and credential attachment in the source adapter; never let a metadata URL become an arbitrary server fetch or a renderer-authenticated request. Local extracted covers remain the normal library thumbnails. Source adapters and search fixtures must be validated without embedding live cookies in tests.

## Translation Aliases

Keep tag association keys stable while translations update. A translation snapshot has its own version and attribution; publishing a validated replacement updates display/search aliases without changing source tags, overrides, or bindings. Missing aliases fall back to original namespace/text. Local tags remain local. Rich descriptions from translation data are untrusted: use plain text initially rather than rendering supplied HTML or loading embedded resources.

The [EhTagTranslation Database](https://github.com/EhTagTranslation/Database) states CC BY-NC-SA 3.0 for its text, with possible additional terms, and asks downstream projects to file an introduction issue before use. Record the selected dataset version, license/attribution, and integration obligations before adoption. This design does not bundle the dataset or send that issue; canonical tag behavior works without a translation provider. Dataset distribution and any required upstream communication are explicit integration work, not assumed completed research.

## Acceptance Cases and Handoffs

| Scenario | Required result |
| --- | --- |
| Same gid supplied through EH and EX; conflicting token | One source identity; preserve link preference and verify locator change before replacing working credentials |
| Explicit gallery URL binds while source access is unavailable | Confirmed binding persists with pending/error state; no invented metadata |
| Two plausible candidates or conflicting sidecars | No automatic binding; user chooses |
| A batch contains success, error, missing, or mismatched items | Publish only valid targets, never by positional pairing; failures preserve their previous snapshots |
| Source refresh removes a tag hidden or locally added by the user | Effective set follows the explicit formula; local choices survive |
| Empty source tags versus absent/malformed tags | Valid empty clears source layer; invalid response preserves old snapshot |
| Rebind A to B while A refresh or a stale edit is in flight | Current binding and overrides control projection; A cannot leak into B; stale user command conflicts |
| Rebind to B with no metadata, or remove binding | Old A source tags/titles vanish from this entry; local overrides/history remain |
| Timestamp-only source refresh or translation update | File identity/content/location and open events remain unchanged |
| Token/credential generation changes while a request runs | Obsolete response cannot publish over the newer generation |
| Repeated network failure, expired auth, or ambiguous denial | Bounded retry/pause with accurate uncertainty; no erasure of successful data |
| Malicious preview URL, unexpected redirect, or rich translation markup | No arbitrary fetch/credential forwarding or executable renderer content |

Before implementation, validate real sanitized response/error fixtures, restricted-gallery capability, search parsing, preview policy if enabled, retry settings, and any chosen sidecar/translation integration. The database/API topics must specify snapshot publication, per-gallery serialization, entry revisions, operation deduplication, and projection freshness. [UI](user-interface.md) owns candidate confirmation, carried-override review, and failed-sync recovery. Runtime EH behavior and all acceptance cases remain untested in this design change.

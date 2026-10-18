# EH Metadata and Matching

This document owns gallery candidate discovery, confirmed bindings, source refresh, local overrides, and tag translation. It does not cover content downloading.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Matching and Update Workflow

### Establishing a Binding

Prefer a gallery URL pasted by the user or a source URL in existing file metadata. Parse and validate the gallery identity before binding. Conflicting source information for an entry requires a choice.

Entries without an explicit source enter candidate search. Search by title, author, and language, adding image-hash evidence where useful. Show candidate titles, languages, page counts, covers, and links. Only confirmed candidates become bindings for ongoing synchronization. Search ranking does not establish a correct match.

### Retrieval and Updates

The server retrieves bound gallery information through `gdata`, preserving namespaced tags. Each batch contains at most 25 galleries. A shared queue controls EH request frequency, backs off according to responses, and handles each gallery's success or failure separately. Keep search-page parsing separate from metadata retrieval for known URLs so page layout changes do not prevent updates to existing bindings. [EH API documentation](https://ehwiki.org/wiki/API)

After a successful refresh, replace the source metadata and source tag set, apply local overrides, and update the search index. Retain the latest successful data, its retrieval time, and the most recent error. Failures must not clear titles or tags. Correcting a binding replaces the old source data while retaining local overrides for user review.

When a newer gallery version is found, record the relationship and notify the user without automatically rebinding older files or changing their content. Distinguish restricted access, expired authentication, and unavailable galleries. Pause affected requests when authentication expires and resume after the connection is repaired.

Configure and securely store EH credentials and proxy settings on the server. Do not distribute credentials to client display caches or ordinary logs. Client access to the NAS and server access to EH are independent conditions.

### Tag Display and Search

Original English tag text and namespaces form canonical tags. Chinese translations serve as display and search aliases. Translation updates affect display and search without changing tag associations. Before adopting the [EhTagTranslation database](https://github.com/EhTagTranslation/Database), address its license and project integration requirements.

## Open Design Questions

- Which existing downloader or sidecar metadata formats need importing, and how are conflicting URLs handled?
- What candidate evidence is displayed, and which explicit-source cases can bind without a candidate selection step?
- What are the exact field precedence and tag add/remove rules during refresh, rebinding, and override removal?
- What refresh schedule, retry policy, and authentication recovery behavior should EH tasks use?

## Related Topics

- [Data model](data-model.md) stores sources and overrides. [Search](search.md) defines retrieval semantics. [User interface](user-interface.md) owns candidate review. [API and tasks](api-and-tasks.md) owns retry execution.

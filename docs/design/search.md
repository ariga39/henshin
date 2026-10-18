# Search and Filtering

This document owns search fields, query semantics, filtering, ordering, pagination, and language-specific retrieval behavior.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Search Behavior

The first release supports title and filename queries, with filters for namespaced tags, language, category, storage root, binding status, whether an entry has been opened, and file status. Tag filters support inclusion and exclusion; multiple filters use intersection by default. More complex query syntax can follow once basic filtering is stable.

Results can be sorted by date added, title, EH publication time, site rating, open count, and last-opened time. Pagination runs on the server rather than loading the entire library into the client. Results should distinguish filename matches, source-title matches, and overridden-title matches. Title sorting uses the effective display-title rule in [EH metadata](eh-metadata.md); effective tags and language facets use its override set rule.

## Indexing Direction

Store business data in SQLite and query tags through relational tables. Validate FTS5 and substring-search behavior for Chinese and Japanese titles, particularly queries of one or two characters. Establish library sizes and performance targets through sample-library validation rather than assuming scan or query durations. [SQLite FTS5 documentation](https://sqlite.org/fts5.html)

Before implementing the first title/filename search index, define expected short-query behavior and evaluate tokenizer or substring options against representative Chinese and Japanese titles. This is a Phase 2 design gate, not a Phase 4 discovery task. Phase 4 measures the selected approach at representative scale. The index remains rebuildable; query semantics should not be an accidental consequence of a tokenizer default.

## Open Design Questions

- What are the exact semantics for phrases, partial titles, tag aliases, inclusion, exclusion, and multiple terms?
- How should one- and two-character Chinese or Japanese queries behave, and which tokenizer or substring strategy meets that behavior?
- Given the EH topic's effective-title precedence, how are ties, explicit empty overrides, and missing sort values ordered?
- What pagination contract and performance targets apply to the representative library?

## Related Topics

- [EH metadata](eh-metadata.md) supplies canonical tags and translations. [Data model](data-model.md) owns persisted fields. [User interface](user-interface.md) owns query controls and results.

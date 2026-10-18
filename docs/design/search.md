# Search, Filtering, and Result Ordering

This topic owns query meaning, tag selection, filters, sorting, pagination, and index correctness. These are first-release design defaults, with representative performance measurement required before implementation. [EH metadata](eh-metadata.md) owns effective titles/tags; [entry lifecycle](entry-identity.md) and [path mapping](path-mapping.md) define identity and file-status meaning.

[Design overview](../design.md) | [Domain glossary](../../CONTEXT.md)

## Text Query Semantics

The main text field is a literal substring query over each entry's filename/directory basename, both source titles of its current binding, and its local title override. A match in any one field includes the entry once and identifies the matching field(s). Do not concatenate fields in a way that permits a match across field boundaries. File contents, notes, parent directory paths, and remote gallery search are not part of this field.

Trim leading and trailing Unicode whitespace before normalization; an empty result applies no text restriction. Internal spaces and punctuation remain literal: quotes, `%`, `_`, `*`, colon, and boolean-looking words are not query syntax. A multi-word query requires the whole substring in one field; it is not an implicit AND over separate words. Advanced query syntax is outside the first release. Tags use explicit chips/pickers rather than interpreting text input as a tag expression.

Use one versioned server normalization profile for query text and searchable field copies: Unicode NFKC, then locale-independent Unicode lowercase, then NFC. Preserve accents; do not perform transliteration, stemming, kana conversion, or full Unicode case folding. Thus width variants normalize, while unrelated homophones or German sharp-s versus `ss` are not promised equivalent. Normalize only derived search values, never original display text, file paths, tag IDs, or metadata keys. Pin the server runtime/profile and cover its Unicode behavior with fixtures before enabling the index.

One- and two-character Chinese/Japanese queries follow the same substring rule as longer queries. No minimum word length, whitespace segmentation, or tokenizer-dependent omission is permitted. Search replies and highlighting preserve original strings; normalized offsets cannot be directly applied to original strings because normalization can change length. First release may show field-level match labels without substring highlighting.

## Tag Aliases and Filters

The tag picker searches canonical names/namespaces and available translated aliases using the same normalized substring profile. It returns canonical tag identities with namespace and original text, plus an alias label. Ambiguous aliases show all candidates for explicit selection; never silently choose the first or turn an alias into a new tag ID. The initial picker draws from tags known to the current library, including its local tags, rather than loading the whole remote tag universe into the client.

Filter tags against effective tags `(source minus suppressions) union local additions`. Hidden source tags do not match merely because they remain in the raw snapshot. Removing a source tag does not remove a local addition. Translation updates change picker aliases, not existing chip identities or result membership for a selected tag.

| Filter | Semantics |
| --- | --- |
| Included tags | Entry must contain every selected canonical tag |
| Excluded tags | Entry must contain none of the selected canonical tags |
| Language, category, storage root | OR within a selected group; AND between groups; language comes from effective language tags |
| Binding status | Bound or unbound; a bound gallery with failed metadata is still bound |
| Opened status | Server-accepted open-event count greater than zero, or equal to zero |
| Identity and server availability | Separate filters for accepted/pending/detached and present/missing/inaccessible/unknown |
| Scan scope | Included or excluded by the server's scan policy; not a claim about file accessibility |

Combining the same tag in both include/exclude is a visible invalid query; do not silently discard one choice. Unknown IDs, unsupported filter values, or malformed cursors produce validation errors, not a broadened unfiltered search. Multi-valued language entries match any selected language; offer an explicit Unknown/none value where source/effective metadata is absent. A missing category is not equivalent to any particular EH category.

Default library browsing includes entries with current claims, regardless of server availability, and shows pending/excluded badges. Detached entries require an explicit include-detached view/filter. Staged discoveries without accepted entries belong in the scan/review workflow, not ordinary library search. Server-side search cannot filter by a client's current NAS accessibility; clients may display local access results separately without pretending the server measured them.

## Sorting and Statistics

Default order is date added descending, then entry ID ascending. Date added is assigned when an entry is first accepted, retained across relocation/metadata changes, and distinct from file modification time or EH publication time.

| Sort | Comparison value |
| --- | --- |
| Date added | Server-recorded entry creation timestamp |
| Title | Normalized effective display title under the EH precedence rule; explicit empty override uses an empty key, not the localized Untitled label |
| EH publication time | Validated source UTC timestamp |
| Site rating | Validated numeric source rating, never lexical ordering of raw response strings |
| Open count | Number of server-accepted unique open events for the entry |
| Last opened | Maximum occurrence time among those accepted events; unknown for no events |

All sorts support ascending/descending order of the primary key. An explicit empty title is a real string key sorted by binary comparison, not a missing value. Missing values sort last in either direction, followed by entry ID ascending as the deterministic tie-breaker. Title keys use binary comparison of normalized UTF-8 strings; no locale-dependent collation or natural-number order is promised for titles. Source fields with no successful snapshot remain unknown.

Pending local events do not change server sort/filter results. Device clock skew can affect Last opened because it is an occurrence-time statistic, not receipt order. [External reading](external-reading.md) must expose the time distinction; this topic does not silently clamp or rewrite timestamps. Repeated delivery of one event cannot alter counts, while a new intentional Open can.

## Pagination and Concurrent Changes

Execute filtering, projection, and the page query in one short server read transaction. Use keyset pagination with an opaque cursor containing the normalized query/filter/sort identity (including direction), library/server scope, normalization profile, last primary key including nullness, and entry ID. The API validates bounded cursor contents and uses parameterized queries; it never executes cursor text as SQL. Changing query, filter, sort, server, or normalization profile starts a fresh page sequence.

With unchanged data, pagination has deterministic order and no missing/duplicate entries. Pages are live queries, not a retained cross-request database snapshot. Concurrent inserts, edits, or changes to open counts can move entries across the cursor boundary; results may repeat or be skipped until refreshed. Persistence owns a per-library change revision, advanced transactionally whenever accepted mutations affect searchable membership, ordering, or returned entry projections (including metadata, lifecycle, scan policy/status, and open-event aggregates). Read that revision in the same page transaction. It is a change signal, not an entry edit precondition or snapshot token; restore/reset semantics belong to synchronization. Return this library change revision with each page, and show that the view changed when revisions differ. Clients deduplicate appended entries by ID and offer refresh from the first page. Do not hold a database transaction open while a user scrolls or promise snapshot-complete results under mutation.

Selections are explicit entry IDs, independent of row positions. A later bulk action resolves those IDs with its own current revisions; pagination does not authorize silently adding newly matched entries. First-release Select all means the loaded selection scope shown by the UI, not an unbounded hidden query snapshot. [UI](user-interface.md) and [API contracts](api-and-tasks.md) specify controls and cursor/error schemas against these rules.

Each response includes `has_more` and the next cursor when applicable. Exact whole-query totals are not required for normal browsing; do not block the first page on a full count. If a count is offered, label its request-time scope and compute it consistently with that request, not as a permanent total. Pagination size is bounded by the API contract and not controlled by arbitrary client SQL limits.

## SQLite Query Direction

The correctness baseline is relational SQLite queries over current bindings, source fields, local overrides, accepted entries, and event aggregates, with normalized text copies maintained in the same transactions as their source fields. Use parameterized substring predicates such as `instr(normalized_field, normalized_query) > 0`; absent fields are handled explicitly. Tag membership uses indexed associations and the effective-tag rule, never concatenated tag text. Derived normalized values and aggregates are rebuildable; their source associations and unique event IDs are authoritative.

[SQLite's scalar-function documentation](https://www.sqlite.org/lang_corefunc.html) documents `instr` substring lookup and the ASCII-only behavior of built-in `lower`. Henshin's Unicode normalization therefore happens in its versioned server profile. [FTS5 documentation](https://www.sqlite.org/fts5.html) describes trigram substring indexing and the limitations of full-text queries shorter than three Unicode characters. These docs were inspected on 2026-10-18; no benchmark was run.

Start with the literal-substring baseline for behavior validation. Before Phase 2 implementation, benchmark representative short/long CJK and combined-filter queries. Add a trigram accelerator only if required by measured targets and only after demonstrating equivalent membership to the baseline, including short queries, punctuation, aliases, and Unicode cases. An accelerator cannot define user syntax or silently lose one-/two-character matches. Choose its exact schema/build strategy at that gate; no speculative second search service is required.

Binding/override changes must affect subsequent query membership and display together. A stale derived row cannot leak old-gallery tags into a rebound entry. Query current authoritative relationships or rebuild a verified projection before treating it as current. If a future accelerator is rebuilding or behind, retain a correctness-preserving baseline path or report search temporarily updating; do not present stale or silently incomplete results as complete. Persisted query caches, if added later, must include source/projection/profile versions rather than relying on stable entry IDs alone.

## Acceptance Fixtures and Gates

| Scenario | Required result |
| --- | --- |
| One-/two-character Chinese or Japanese substring | Same matching rule as longer text, including within an unspaced title |
| Width variants, case changes, retained accents, sharp-s versus `ss` | Follow the exact normalization profile, not host locale or accidental FTS behavior |
| `%`, `_`, quotes, boolean words, or literal spaces | Literal substring semantics; no query injection or undocumented syntax |
| Query suffix appears only by concatenating two fields | No match |
| Two selected roots and languages plus included/excluded tags | OR within each root/language group, AND across groups and all included tags, no excluded tags; a tag in both sets is invalid |
| Hidden source tag, retained local addition, ambiguous translated alias | Effective-tag filtering and explicit alias selection; no canonical identity change |
| Rebinding while search runs | Each response uses a coherent read view; later responses cannot apply old source tags to the new binding |
| Empty title override or missing rating/publication time | Defined empty-key/null ordering and deterministic entry-ID ties |
| Several entries share every primary sort value | Stable pagination under unchanged data |
| Open events or metadata changes arrive between pages | Live-page limitation is visible; duplicate IDs are suppressed; refresh restores a current sequence |
| Root is offline but the server and indexed data remain available | Search remains server-data based; no implication that the client can or cannot open files |
| Normalization/index rebuild or invalid cursor | Restart with clear state/error; never broaden a malformed query or silently drop valid short-query matches |

Before implementation, pin normalization fixtures, cursor encoding/limits, needed relational indexes, and measurable latency/memory targets on a representative library. Measure first-page latency and later pages separately from scans and metadata jobs. Library size is currently unknown, so no throughput claim or full-library disconnected-search guarantee is made. [Persistence](data-model.md) owns transactional storage and migrations; [delivery](delivery-and-validation.md) owns measured acceptance.

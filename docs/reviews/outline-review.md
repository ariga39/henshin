# Outline Review and Revision

## Baseline and Method

Both reviewers independently reviewed commit `f0acdd43115696202226311769ff237acad10ec0`, using the same [review brief](outline-review-brief.md), requirement summary, six dimensions, and output criteria. Both were instructed to read the complete baseline, remain read-only, and avoid the other reviewer's findings. Findings below refer to baseline line numbers; the revised files have different line numbers.

| Reviewer | Execution | Findings |
| --- | --- | --- |
| Sol | New Codex task using `gpt-6.1-sol` | Two medium findings; no high findings |
| DeepSeek | New OpenCode session using `opencode-go/deepseek-v4-pro`, launched through Herdr in Plan mode | Three medium and three low findings; no high findings |

The primary agent checked each finding against the baseline and user requirements. Seven findings resulted in corrections or clarifications, sometimes with a different remedy from the reviewer's proposal. One claimed sequencing defect was not accepted. This review does not establish that runtime integrations or platform behavior have been tested.

## Shared Dimension Coverage

| Dimension | Sol | DeepSeek |
| --- | --- | --- |
| Requirements and scope | No material finding | No major scope finding; D6 identifies readiness wording |
| Domain and document consistency | S1 | D1, D2 |
| Technical feasibility and boundaries | No material finding; adapters remain unvalidated | D5 |
| Data integrity and failure behavior | S1, S2 | D2 |
| Complexity and sequencing | S2 | D3, D4 |
| Readiness and verification | No additional finding | D6 |

An empty cell of findings does not imply experimental verification. Both reviewers treated acknowledged detailed-design questions as legitimate unless they conflicted with a commitment or prerequisite.

## Findings and Disposition

### S1 Same-path Replacement and Entry Identity

**Reported severity: medium. Accepted.** Baseline `docs/design/file-indexing.md:11` and `:13` describe reanalysis and entry updates, while `docs/design/data-model.md:14` and `CONTEXT.md:13` distinguish editions. Replacing an archive at the same path could incorrectly transfer a previous edition's binding, overrides, and open history.

The [data model](../design/data-model.md) and [indexing design](../design/file-indexing.md) now distinguish verified same-edition representation changes, distinct editions, and uncertain replacements. Previous records must not be silently reassigned. Current location uniqueness is distinguished from historical locations. Detailed evidence, resolution UX, and Open behavior during uncertainty are gates before the first file-update implementation. [Phase 1 acceptance](../design/delivery-and-validation.md) now includes same-path replacement.

### S2 Revision Checks Must Accompany Metadata Editing

**Reported severity: medium. Accepted.** Baseline `docs/design/delivery-and-validation.md:23` introduces editing in Phase 2, but `:34` and `:39` postpone concurrent-edit handling to Phase 3 despite multiple-client access and the revision rule in `docs/design/synchronization.md:17`.

[Phase 2](../design/delivery-and-validation.md) now includes revision protection and stale-edit acceptance for local overrides and binding corrections. Phase 3 extends reconnection and notification coverage instead of introducing the protection for the first time.

### D1 Library and Storage-root Relationships

**Reported severity: medium. Accepted as a model clarification.** Baseline `docs/design/data-model.md:13` combines Library and Storage Root in one row, leaving their ownership and ID scope implicit despite separate glossary definitions.

The [data model](../design/data-model.md) now separates the two: a library can have multiple roots, each root belongs to one library, and root IDs are unique within the server instance. The [glossary](../../CONTEXT.md) and [mapping rules](../design/path-mapping.md) agree. Whether the UI exposes one library or several remains a product decision; this clarification does not add a multi-library management feature or user accounts.

### D2 Migration and Clone Identity

**Reported severity: medium. Concern accepted; proposed remedy adjusted.** Baseline `docs/design/synchronization.md:13` promises migration identity preservation, while `:24` groups restore and clone identity into an open question. Mappings and pending events already depend on that identity. The distinction needs to be explicit before implementation, although an open question alone is not a contradiction.

The reviewer suggested giving a relocated host a new identity. That is unnecessary for a sole-successor migration and would conflict with the existing preservation goal. The [revised lifecycle](../design/synchronization.md) instead distinguishes:

- Migration: stop the old authority, preserve instance and entry identities, and explicitly reconnect to the authenticated successor.
- Independent clone: assign a new instance identity and do not silently inherit client mappings or pending events.
- Restore: retain identity for the sole authority, but acknowledge the backup point and specify cache refresh and reconciliation before implementation.

Instance identity is a namespace, not authentication. Copying the database does not authorize running two authorities with the same identity.

### D3 Search Validation Timing

**Reported severity: medium. Accepted as a gate clarification.** Baseline `docs/design/search.md:15` requires CJK search validation, while the explicit short-query measurement appears only in Phase 4 at `docs/design/delivery-and-validation.md:53`. This did not prove that tokenizer selection was intentionally deferred, but the milestone wording left its prerequisite unclear.

The [search design](../design/search.md) and [delivery plan](../design/delivery-and-validation.md) now require expected short-query semantics and representative tokenizer/substring evaluation before Phase 2 search implementation. Functional short-query acceptance is in Phase 2; Phase 4 retains scale and performance validation.

### D4 Design Refinement Order Versus Implementation Phases

**Reported severity: low. Not accepted as a defect.** The reviewer compared design refinement step 4 in `docs/design.md:36` with implementation Phase 1 in `docs/design/delivery-and-validation.md:11`. These are different sequences. Defining UI journeys before finalizing contracts does not imply writing UI or server code before those contracts exist.

The design order remains unchanged. [Delivery gates](../design/delivery-and-validation.md) now explicitly distinguish refinement from implementation and require the necessary minimal contracts before dependent application code. This clarification also addresses D6.

### D5 Async Scanning Versus Blocking Workers

**Reported severity: low. Accepted.** Baseline `docs/design/api-and-tasks.md:28` assigns all scanning to background workers, while `docs/design/application-logic.md:57` distinguishes Effect concurrency from worker execution for blocking work.

[Background execution](../design/api-and-tasks.md) now uses bounded Effect work for asynchronous enumeration and I/O. Workers or subprocesses handle CPU-heavy or synchronous decoding, hashing, image processing, and blocking adapters. Persistent tasks remain separate from fibers and in-memory queues.

### D6 Prototypes and Adapter Selection

**Reported severity: low. Accepted; remedy narrowed.** Baseline `docs/design/delivery-and-validation.md:61` requires adapter pinning before implementation, while `:63` says the unresolved choices do not prevent the minimal workflow.

[Delivery gates](../design/delivery-and-validation.md) now allow exploratory prototypes with provisional adapters, then require validation and pinning before dependent application implementation. They do not treat an unvalidated prototype as a completed Phase 1 deliverable or defer dependency resolution until after production features depend on it.

## Product Decisions Retained for Detailed Design

- The one-user, one-authoritative-server model remains an explicitly proposed default. No speculative user-account schema was added.
- The number of user-visible libraries is still open; multiple storage roots and their relationship to a library are now explicit.
- Replacement resolution evidence and interaction need detailed design before implementation. Record preservation and non-transfer to an unrelated edition are already required.

Migration versus clone semantics now follow the existing single-authority model. The operator workflow and restored-state reconciliation still need specification before those features are implemented.

## Next Design Topics

Start with entry identity, directory boundaries, same-path replacement, relocation, and root mapping. Then refine metadata ownership and revision-protected edits, reader/event delivery and instance lifecycle, and search semantics. UI journeys, concrete schemas/contracts, and task transitions should be developed against these rules, with focused Effect and platform prototypes resolving technical uncertainty.

## Verification

The revisions were checked against both reports and the original requirements. Document validation covers local links, topic indexing, English-only prose, Markdown fences and spacing, and Git whitespace checks. No application tests, NAS access tests, Effect integration tests, or packaging tests were run because this change contains design documents only. The revised outline remains a working design, not a finished implementation specification.

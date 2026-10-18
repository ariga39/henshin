# Outline Review and Revision

## Baseline and Method

The requested comparison is Codex Sol and OpenCode Go DeepSeek V4.1 Flash. The initial DeepSeek session mistakenly used V4 Pro. After the user corrected the model, a fresh Flash session reviewed the same baseline independently; the V4 Pro report remains historical evidence and is not relabeled as Flash output.

All three sessions reviewed commit `f0acdd43115696202226311769ff237acad10ec0`, using the same [review brief](outline-review-brief.md), requirement summary, six dimensions, output criteria, and task prompt. Each was instructed to read the complete baseline, remain read-only, and avoid other reviewers' findings. Findings below refer to baseline line numbers; the revised files have different line numbers.

| Reviewer | Execution | Findings |
| --- | --- | --- |
| Sol | New Codex task using `gpt-6.1-sol` | Two medium findings; no high findings |
| DeepSeek V4 Pro (mistaken initial selection) | New OpenCode session using `opencode-go/deepseek-v4-pro`, launched through Herdr in Plan mode | Three medium and three low findings; no high findings |
| DeepSeek V4.1 Flash (requested model) | Fresh OpenCode session using `opencode-go/deepseek-v4.1-flash`, launched through Herdr in Plan mode | Four medium, one reported as medium-low, and two low findings; no high findings |

The initial Sol/V4 Pro pass produced eight findings: seven corrections or clarifications and one rejected sequencing claim. The corrective Flash pass produced seven findings: four led to narrow clarifications or acceptance changes, and three were not accepted as outline defects. Earlier justified revisions remain in place. This review does not establish that runtime integrations or platform behavior have been tested.

For the corrective pass, both the model listing and the active OpenCode UI verified DeepSeek V4.1 Flash through OpenCode Go before submission. Session: `ses_eb355230effeIQVg2hTcZfLdB4`. Flash explicitly reviewed the original 17 documents and excluded the then-current revision `8fe13b3` as evidence.

## Shared Dimension Coverage

| Dimension | Sol | V4 Pro (historical) | V4.1 Flash |
| --- | --- | --- | --- |
| Requirements and scope | No material finding | No major scope finding; D6 identifies readiness wording | F5, F7 |
| Domain and document consistency | S1 | D1, D2 | F1, F2, F3 |
| Technical feasibility and boundaries | No material finding; adapters remain unvalidated | D5 | F6 |
| Data integrity and failure behavior | S1, S2 | D2 | No separate material finding |
| Complexity and sequencing | S2 | D3, D4 | F4 |
| Readiness and verification | No additional finding | D6 | F5 |

No finding does not imply experimental verification. The common brief excludes acknowledged detailed-design questions unless they conflict with a commitment or prerequisite; the primary-agent dispositions below apply that standard to all reports.

## Initial Sol and V4 Pro Findings and Disposition

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

## Corrective V4.1 Flash Findings and Disposition

### F1 Revision Ownership

**Reported severity: medium. Accepted as a narrow ownership clarification.** Baseline `docs/design/data-model.md:43` assigns revision semantics to synchronization, while `docs/design/synchronization.md:28` says the data model owns revisions. This is not necessarily contradictory: stored revisions and the conflict protocol are different responsibilities. However, explicit ownership helps topic refinement. The data model now owns revision granularity, storage, and atomic advancement; synchronization owns submission and conflict responses. The open granularity question has moved to the data model. No concrete revision schema is selected yet.

### F2 Persisted Operational State

**Reported severity: medium. Not accepted as an outline defect; retained as detailed-design input.** The reviewer compared root offline/scan-error behavior in `docs/design/file-indexing.md:9,14` and retained EH errors in `docs/design/eh-metadata.md:19` with the abbreviated entity fields at `docs/design/data-model.md:13,15`. The table explicitly lists main fields and defers concrete schemas; background tasks also have persisted errors. Omitted columns do not establish that the state cannot be represented or recovered. When specifying persistence, account for retained EH errors and scan observations without treating a persisted last-known root status as proof of current reachability. No additional fields or persistence mechanism are imposed at outline stage.

### F3 Search Sort and Filter Fields

**Reported severity: medium. Not accepted as an outline defect; retained as detailed-design input.** Baseline `docs/design/search.md:9,11` defines filters and ordering, while the abbreviated entry/gallery rows at `docs/design/data-model.md:14,15` omit explicit added-time, publication-time, and rating fields. The same model preserves raw source responses and requires schema/index design before persistence. There is no commitment to implement an exhaustive schema from that table alone. Detailed schema design must map the required query keys to stored or derived values and specify missing-value ordering; no new outline-level field list is needed.

### F4 Phase 1 Authentication and Startup Prerequisites

**Reported severity: medium. Accepted in part.** Baseline `docs/design/delivery-and-validation.md:16` accepts LAN use, and `docs/design/architecture.md:43` requires authentication and HTTPS, but Phase 1 lacks corresponding acceptance. The delivery plan now explicitly requires local credentials, authenticated remote HTTPS, rejected unauthenticated access, and independent/local-managed server startup with native dependencies in the development build.

The claim that Phase 1 requires final installer packaging is not accepted: development startup can be verified before distribution packaging. Final installers remain Phase 4 work. The previous integration gates already moved dependency validation before dependent implementation. LAN support is retained because it is a core user scenario.

### F5 Metadata Export Delivery Coverage

**Reported severity: medium-low (outside the brief's three severity labels); treated as low. Accepted.** Baseline `docs/design/product-scope.md:40`, `docs/design/api-and-tasks.md:20`, and `docs/design/user-interface.md:16` include metadata export, but `docs/design/delivery-and-validation.md:46,52` only assigns and validates backup/restore. Phase 4 now explicitly includes metadata export and a representative artifact check against a format/field contract specified before implementation. Credentials are excluded, and export does not imply backup equivalence or re-import support. The reviewer called this a confirmed user requirement; more precisely, it is part of the proposed release scope already documented in the outline.

### F6 Effect Stack and a Preselected Fallback

**Reported severity: low. Not accepted as a defect or a reason to select a fallback framework now.** Baseline `docs/design/application-logic.md:41,45` identifies a preferred, unpinned direction; `:63-67` already specifies shared-schema endpoint, lifecycle, error, interruption, and packaging checks. The claim that the contract is already pinned contradicts that wording. Previous delivery revisions also make integration validation a prerequisite. A failed required check must be resolved before dependent implementation; it does not justify choosing another framework before observing a concrete limitation. No runtime or package claim was independently tested in this review.

### F7 Docker Scope

**Reported severity: low. Accepted as a scope clarification.** Baseline `docs/design/architecture.md:37` says the independent server can run directly or through Docker. This is a deployment option, not necessarily a mandatory deliverable, but the wording could be read as a commitment. Architecture now explicitly marks Docker as optional. Independent server execution remains required; no container implementation is added.

### Flash Product Questions

Flash also raised first-run server selection, maintenance scope, and library-versus-instance cardinality. These remain detailed-design inputs rather than newly confirmed requirements. The UI already requires selecting a local or remote connection; refinement should explain that a new independent server does not share another server's records. The existing proposal retains backup/restore and export, with Docker now explicitly optional. Earlier revisions already separate libraries and roots, scope root IDs within an instance, and leave the number of user-visible libraries open; they do not equate a library with a server instance.

## Product Decisions Retained for Detailed Design

- The one-user, one-authoritative-server model remains an explicitly proposed default. No speculative user-account schema was added.
- The number of user-visible libraries is still open; multiple storage roots and their relationship to a library are now explicit.
- Replacement resolution evidence and interaction need detailed design before implementation. Record preservation and non-transfer to an unrelated edition are already required.

Migration versus clone semantics now follow the existing single-authority model. The operator workflow and restored-state reconciliation still need specification before those features are implemented.

## Next Design Topics

Start with entry identity, directory boundaries, same-path replacement, relocation, and root mapping. Then refine metadata ownership and revision-protected edits, reader/event delivery and instance lifecycle, and search semantics. UI journeys, concrete schemas/contracts, and task transitions should be developed against these rules, with focused Effect and platform prototypes resolving technical uncertainty.

## Verification

The initial revisions were checked against the Sol and V4 Pro reports and the original requirements. The corrective pass checked all seven Flash findings against the same baseline and the revised outline. Document validation covers local links, topic indexing, English-only prose, Markdown fences and spacing, and Git whitespace checks. No application tests, NAS access tests, Effect integration tests, or packaging tests were run because this change contains design documents only. The revised outline remains a working design, not a finished implementation specification.

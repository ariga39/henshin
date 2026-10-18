# Detailed Design Progress

Each topic follows the [shared review protocol](topic-review-brief.md). A topic is complete only when both independent reviewers have no remaining material finding on its final design revision. Runtime validation remains separate. Later topics may revise earlier decisions and must record affected contracts in their PR and review record.

| Order | Topic | Status | Branch / base |
| --- | --- | --- | --- |
| 1 | Entry identity and file lifecycle | [Both reviewers PASS](entry-identity-review.md) on `b2a9362`; [PR #1](https://github.com/ariga39/henshin/pull/1) | `design/01-entry-identity` / `main` |
| 2 | Storage roots and device path mappings | [Both reviewers PASS](path-mapping-review.md) on `d5cbbc2`; [PR #2](https://github.com/ariga39/henshin/pull/2) | `design/02-path-mapping` / `design/01-entry-identity` |
| 3 | File indexing and thumbnails | [Both reviewers PASS](file-indexing-review.md) on `2efcc0b`; [PR #3](https://github.com/ariga39/henshin/pull/3) | `design/03-file-indexing` / `design/02-path-mapping` |
| 4 | EH metadata, bindings, and overrides | [Both reviewers PASS](eh-metadata-review.md) on `e65a922`; [PR #4](https://github.com/ariga39/henshin/pull/4) | `design/04-eh-metadata` / `design/03-file-indexing` |
| 5 | Search semantics and filtering | [Both reviewers PASS](search-review.md) on `393e29f`; [PR #5](https://github.com/ariga39/henshin/pull/5) | `design/05-search` / `design/04-eh-metadata` |
| 6 | External readers and open events | Pending | After topic 5 |
| 7 | Cross-device consistency and instance lifecycle | Pending | After topic 6 |
| 8 | Product scope and release scenarios | Pending | After topic 7 |
| 9 | UI journeys and interaction | Pending | After topic 8 |
| 10 | Persistence schemas and transactions | Pending | After topic 9 |
| 11 | API, IPC, and background-task contracts | Pending | After topic 10 |
| 12 | Effect runtime and application composition | Pending | After topic 11 |
| 13 | Deployment, authentication, and packaging | Pending | After topic 12 |
| 14 | Delivery gates and validation plan | Pending | After topic 13 |

This order follows behavioral dependencies. Existing outline decisions constrain each topic throughout; security and integrity prerequisites cannot be postponed merely because their full topic appears later. Product scope and UI receive separate documents, reviews, and PRs. Technical claims requiring platform or dependency experiments must remain marked unverified until those experiments actually run.

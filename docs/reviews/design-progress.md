# Detailed Design Progress

Each topic follows the [shared review protocol](topic-review-brief.md). A topic is complete only when both independent reviewers have no remaining material finding on its final design revision. Runtime validation remains separate. Later topics may revise earlier decisions and must record affected contracts in their PR and review record.

| Order | Topic | Status | Branch / base |
| --- | --- | --- | --- |
| 1 | Entry identity and file lifecycle | [Both reviewers PASS](entry-identity-review.md) on `b2a9362`; [PR #1](https://github.com/ariga39/henshin/pull/1) | `design/01-entry-identity` / `main` |
| 2 | Storage roots and device path mappings | Pending | After topic 1 |
| 3 | File indexing and thumbnails | Pending | After topic 2 |
| 4 | EH metadata, bindings, and overrides | Pending | After topic 3 |
| 5 | Search semantics and filtering | Pending | After topic 4 |
| 6 | External readers and open events | Pending | After topic 5 |
| 7 | Cross-device consistency and instance lifecycle | Pending | After topic 6 |
| 8 | Product scope and UI journeys | Pending | After topic 7 |
| 9 | Persistence schemas and transactions | Pending | After topic 8 |
| 10 | API, IPC, and background-task contracts | Pending | After topic 9 |
| 11 | Effect runtime and application composition | Pending | After topic 10 |
| 12 | Deployment, authentication, and packaging | Pending | After topic 11 |
| 13 | Delivery gates and validation plan | Pending | After topic 12 |

This order follows behavioral dependencies. Existing outline decisions constrain each topic throughout; security and integrity prerequisites cannot be postponed merely because their full topic appears later. Product scope and UI remain separate source documents, even where reviewed together. Technical claims requiring platform or dependency experiments must remain marked unverified until those experiments actually run.

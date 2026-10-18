# Detailed Design Progress

Each topic follows the [shared review protocol](topic-review-brief.md). A topic is complete only when both independent reviewers have no remaining material finding on its final design revision. Runtime validation remains separate. Later topics may revise earlier decisions and must record affected contracts in their PR and review record.

| Order | Topic | Status | Branch / base |
| --- | --- | --- | --- |
| 1 | Entry identity and file lifecycle | [Both reviewers PASS](entry-identity-review.md) on `b2a9362`; [PR #1](https://github.com/ariga39/henshin/pull/1) | `design/01-entry-identity` / `main` |
| 2 | Storage roots and device path mappings | [Both reviewers PASS](path-mapping-review.md) on `d5cbbc2`; [PR #2](https://github.com/ariga39/henshin/pull/2) | `design/02-path-mapping` / `design/01-entry-identity` |
| 3 | File indexing and thumbnails | [Both reviewers PASS](file-indexing-review.md) on `2efcc0b`; [PR #3](https://github.com/ariga39/henshin/pull/3) | `design/03-file-indexing` / `design/02-path-mapping` |
| 4 | EH metadata, bindings, and overrides | [Both reviewers PASS](eh-metadata-review.md) on `e65a922`; [PR #4](https://github.com/ariga39/henshin/pull/4) | `design/04-eh-metadata` / `design/03-file-indexing` |
| 5 | Search semantics and filtering | [Both reviewers PASS](search-review.md) on `393e29f`; [PR #5](https://github.com/ariga39/henshin/pull/5) | `design/05-search` / `design/04-eh-metadata` |
| 6 | External readers and open events | [Both reviewers PASS](external-reading-review.md) on `2fba5b4`; [PR #6](https://github.com/ariga39/henshin/pull/6) | `design/06-external-reading` / `design/05-search` |
| 7 | Cross-device consistency and instance lifecycle | [Both reviewers PASS](synchronization-review.md) on `174af0a`; [PR #7](https://github.com/ariga39/henshin/pull/7) | `design/07-synchronization` / `design/06-external-reading` |
| 8 | Product scope and release scenarios | [Both reviewers PASS](product-scope-review.md) on `a149c17`; [PR #8](https://github.com/ariga39/henshin/pull/8) | `design/08-product-scope` / `design/07-synchronization` |
| 9 | UI journeys and interaction | [Both reviewers PASS](user-interface-review.md) on `b8bd349`; [PR #9](https://github.com/ariga39/henshin/pull/9) | `design/09-user-interface` / `design/08-product-scope` |
| 10 | Persistence schemas and transactions | [Both reviewers PASS](persistence-review.md) on `ba6b050`; [PR #10](https://github.com/ariga39/henshin/pull/10) | `design/10-persistence` / `design/09-user-interface` |
| 11 | API, IPC, and background-task contracts | [Both reviewers PASS](api-and-tasks-review.md) on `c7bec1d`; [PR #11](https://github.com/ariga39/henshin/pull/11) | `design/11-api-and-tasks` / `design/10-persistence` |
| 12 | Effect runtime and application composition | [Both reviewers PASS](effect-composition-review.md) on `b4a9262`; [PR #12](https://github.com/ariga39/henshin/pull/12) | `design/12-effect-composition` / `design/11-api-and-tasks` |
| 13 | Deployment, authentication, and packaging | [Both reviewers PASS](deployment-review.md) on `14f5787`; [PR #13](https://github.com/ariga39/henshin/pull/13) | `design/13-deployment` / `design/12-effect-composition` |
| 14 | Delivery gates and validation plan | Pending | After topic 13 |

This order follows behavioral dependencies. Existing outline decisions constrain each topic throughout; security and integrity prerequisites cannot be postponed merely because their full topic appears later. Product scope and UI receive separate documents, reviews, and PRs. Technical claims requiring platform or dependency experiments must remain marked unverified until those experiments actually run.

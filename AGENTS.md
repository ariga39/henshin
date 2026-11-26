# Documentation

Write and maintain repository documentation in English.

Keep the repository focused on current design and implementation. Do not commit review briefs, review reports, verdict logs, or historical progress records. Keep review feedback and verification summaries in pull requests; incorporate accepted decisions into the current design documents.

# Pull request review

Use the online review attached to the GitHub pull request for independent review. This applies to delegated implementers as well. Run local tests for the behavior being changed.

# Stacked pull requests

Follow the [GitHub stacked pull request workflow](https://docs.github.com/en/pull-requests/how-tos/stacked-pull-requests) for dependent PRs. Keep each PR focused on one reviewable change and target the branch directly below it. Use `gh stack submit` to publish or update the stack.

When the base or a lower layer changes, use `gh stack rebase` or `gh stack sync` to rebase the dependent branches in order. Do not create merge commits to sync `main` or a parent branch into a stack branch. After a lower PR lands, let GitHub rebase and retarget the remaining PRs, then sync the local stack.

# Product position and constraints

Henshin is a personal desktop application for one household, used on a trusted home LAN to manage a comic collection stored on a NAS or another user-managed location. The desktop connects to a separately hosted Rust service. Reading happens in an external reader on each device.

Treat collection files as read-only. Keep collection storage independent from server placement, and let each device use its own local or mounted path to open a file. Keep application state and backups separate from collection files. Do not add multi-user administration, public-internet hosting requirements, a built-in reader, downloading, or file streaming without a demonstrated user need.

An ordinary `mode:auto` lookup binds its first candidate automatically and labels the binding as auto-matched. Explicit title and cover searches return preview candidates without binding. Return the candidate list so the user can confirm an auto-match, choose another gallery, or bind a direct URL; those user decisions are recorded as manual. Searching alternatives for an already bound entry must not replace its current binding automatically. Never run gallery lookup during collection scans.

Prefer direct designs that give the user a concrete benefit. Reject complexity that adds no actual user value, including complexity proposed only to satisfy a review comment. Address review feedback when it identifies a real user-facing risk or requirement; explain the tradeoff when a requested change would make the product more complex without improving the user's outcome.

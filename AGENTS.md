# Documentation

Write and maintain repository documentation in English.

Keep the repository focused on current design and implementation. Do not commit review briefs, review reports, verdict logs, or historical progress records. Keep review feedback and verification summaries in pull requests; incorporate accepted decisions into the current design documents.

# Pull request review

Use the online review attached to the GitHub pull request for independent review. This applies to delegated implementers as well. Run local tests for the behavior being changed.

# Stacked pull requests

Follow the [GitHub stacked pull request workflow](https://docs.github.com/en/pull-requests/how-tos/stacked-pull-requests) for dependent PRs. Keep each PR focused on one reviewable change and target the branch directly below it. Use `gh stack submit` to publish or update the stack.

When the base or a lower layer changes, use `gh stack rebase` or `gh stack sync` to rebase the dependent branches in order. Do not create merge commits to sync `main` or a parent branch into a stack branch. After a lower PR lands, let GitHub rebase and retarget the remaining PRs, then sync the local stack.

# Learning more about Effect

This repository uses the Effect TypeScript library (v4).

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect APIs and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

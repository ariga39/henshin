import type { SourceDiscoveryCoverage } from "./NativeSourceBoundary"

export const discoveryCoverageView = (coverage: SourceDiscoveryCoverage) => ({
  status: coverage.status,
  directories_visited: coverage.directoriesVisited,
  entries_observed: coverage.entriesObserved,
  candidate_count: coverage.candidateCount,
  candidate_sample_truncated: coverage.candidateSampleTruncated,
  excluded_links: coverage.excludedLinks,
  excluded_link_count: coverage.excludedLinkCount,
  unsupported_names: coverage.unsupportedNames,
  unsupported_name_count: coverage.unsupportedNameCount,
  unsupported_directories: coverage.unsupportedDirectories,
  unsupported_directory_count: coverage.unsupportedDirectoryCount,
  issues: coverage.issues.map(({ code, relativePath }) =>
    relativePath === undefined ? { code } : { code, relative_path: relativePath }),
  issue_count: coverage.issueCount
})

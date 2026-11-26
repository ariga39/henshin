export type LibraryFilters = {
  q: string;
  includeTags: string[];
  excludeTags: string[];
  rootId: string;
  status: string;
  sort: string;
  limit: number;
  offset: number;
};

export function libraryQuery(filters: LibraryFilters): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim());
  for (const tag of filters.includeTags) params.append('includeTags', tag);
  for (const tag of filters.excludeTags) params.append('excludeTags', tag);
  if (filters.rootId) params.set('rootId', filters.rootId);
  params.set('status', filters.status);
  params.set('sort', filters.sort);
  params.set('limit', String(filters.limit));
  params.set('offset', String(filters.offset));
  return params.toString();
}

export type EntryDraft = {
  entryId: string;
  customTitle: string;
  note: string;
  localTags: string[];
  hiddenTags: string[];
  dirty: boolean;
};

export function entryDraft(entry: {
  id: string;
  customTitle?: string;
  note?: string;
  localTags?: string[];
  hiddenTags?: string[];
}): EntryDraft {
  return {
    entryId: entry.id,
    customTitle: entry.customTitle ?? '',
    note: entry.note ?? '',
    localTags: entry.localTags ?? [],
    hiddenTags: entry.hiddenTags ?? [],
    dirty: false,
  };
}

export function effectiveTitle(entry: {
  customTitle?: string;
  ehTitleJpn?: string;
  ehTitle?: string;
  title: string;
}): string {
  return entry.customTitle || entry.ehTitleJpn || entry.ehTitle || entry.title;
}

export function effectiveTagOrigins(input: {
  ehTags: string[];
  localTags: string[];
  hiddenTags: string[];
}): { eh: string[]; local: string[] } {
  return {
    eh: input.ehTags.filter((tag) => !input.hiddenTags.includes(tag)),
    local: input.localTags.filter((tag) => !input.hiddenTags.includes(tag)),
  };
}

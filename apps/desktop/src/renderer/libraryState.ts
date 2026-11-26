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

export type EntryPersonalFields = {
  customTitle: string;
  note: string;
  localTags: string[];
  hiddenTags: string[];
};

export type EntryDraft = EntryPersonalFields & {
  entryId: string;
  baseline: EntryPersonalFields;
  dirty: boolean;
};

export function isCurrentSelection(
  requestedEntryId: string,
  currentEntryId: string | null,
  requestedGeneration: number,
  currentGeneration: number,
): boolean {
  return requestedEntryId === currentEntryId && requestedGeneration === currentGeneration;
}

export function entryPath(entryId: string): string {
  return `/api/entries/${encodeURIComponent(entryId)}`;
}

const sameTags = (left: string[], right: string[]) =>
  left.length === right.length && left.every((tag, index) => tag === right[index]);

export function updateEntryDraft(draft: EntryDraft, changes: Partial<EntryPersonalFields>): EntryDraft {
  const updated = { ...draft, ...changes };
  updated.dirty = updated.customTitle !== updated.baseline.customTitle
    || updated.note !== updated.baseline.note
    || !sameTags(updated.localTags, updated.baseline.localTags)
    || !sameTags(updated.hiddenTags, updated.baseline.hiddenTags);
  return updated;
}

export function entryPatch(draft: EntryDraft): Partial<EntryPersonalFields> {
  const patch: Partial<EntryPersonalFields> = {};
  if (draft.customTitle !== draft.baseline.customTitle) patch.customTitle = draft.customTitle;
  if (draft.note !== draft.baseline.note) patch.note = draft.note;
  if (!sameTags(draft.localTags, draft.baseline.localTags)) patch.localTags = draft.localTags;
  if (!sameTags(draft.hiddenTags, draft.baseline.hiddenTags)) patch.hiddenTags = draft.hiddenTags;
  return patch;
}

export function entryDraft(entry: {
  id: string;
  customTitle?: string;
  note?: string;
  localTags?: string[];
  hiddenTags?: string[];
}): EntryDraft {
  const fields: EntryPersonalFields = {
    customTitle: entry.customTitle ?? '',
    note: entry.note ?? '',
    localTags: [...(entry.localTags ?? [])],
    hiddenTags: [...(entry.hiddenTags ?? [])],
  };
  return {
    ...fields,
    entryId: entry.id,
    baseline: {
      ...fields,
      localTags: [...fields.localTags],
      hiddenTags: [...fields.hiddenTags],
    },
    dirty: false,
  };
}

export function refreshEntryDraft(
  draft: EntryDraft | null,
  refreshed: Parameters<typeof entryDraft>[0],
): EntryDraft | null {
  if (!draft || draft.entryId !== refreshed.id || draft.dirty) return draft;
  return entryDraft(refreshed);
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

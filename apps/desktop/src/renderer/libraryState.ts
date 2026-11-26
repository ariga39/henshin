export type LibraryFilters = {
  q: string;
  includeTags: string[];
  excludeTags: string[];
  rootId: string;
  status: string;
  sort: string;
  limit: number;
  offset: number;
  ehBindSource?: 'auto';
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
  if (filters.ehBindSource) params.set('ehBindSource', filters.ehBindSource);
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

export function sameServerOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function isComposingEnter(key: string, isComposing: boolean, keyCode: number): boolean {
  return key === 'Enter' && (isComposing || keyCode === 229);
}

export function entryPath(entryId: string): string {
  return `/api/entries/${encodeURIComponent(entryId)}`;
}

export function ehLookupBody(
  mode: 'auto' | 'title' | 'cover',
  query: string,
  site: string,
  hasBinding: boolean,
  includeExpunged?: boolean,
): { mode: 'auto' | 'title' | 'cover'; autoBind?: false; query?: string; site?: string; includeExpunged?: boolean } {
  return {
    mode,
    ...(hasBinding ? { autoBind: false as const } : {}),
    ...(mode === 'title' && query.trim() ? { query: query.trim() } : {}),
    ...(mode !== 'auto' && site ? { site } : {}),
    ...(mode === 'title' && includeExpunged !== undefined ? { includeExpunged } : {}),
  };
}

export function ehBatchLookupBody(): { mode: 'auto'; autoBind: true } {
  return { mode: 'auto', autoBind: true };
}

export function ehLookupMessage(autoBound: boolean | undefined, candidateCount: number): string {
  if (candidateCount === 0) return 'No matching galleries found.';
  return autoBound === true
    ? 'Auto-matched the first candidate. Confirm it or choose another gallery.'
    : '';
}

export function shouldRemoveFromAutoFilter(
  filter: '' | 'auto',
  visibleEntryIds: string[],
  entryId: string,
  nextBindSource: 'auto' | 'manual' | null | undefined,
): boolean {
  return filter === 'auto' && nextBindSource !== 'auto' && visibleEntryIds.includes(entryId);
}

export type EhBatchResponse = {
  entry?: { ehError?: string | null; ehBindSource?: 'auto' | 'manual' | null };
  candidates: unknown[];
  autoBound?: boolean;
  refreshedBinding?: boolean;
};

export type EhBatchResult<T> = {
  item: T;
  kind: 'matched' | 'refreshed' | 'no-match' | 'failed';
  message?: string;
  response?: EhBatchResponse;
  blocked: boolean;
};

export function isEhAccessOrRateBlock(message: string): boolean {
  const text = message.toLowerCase();
  return [
    'temporarily banned', 'rate limiting', 'rate limit', 'access denied', 'login wall',
    'non-html response', 'http 401', 'http 403', 'http 429', 'credentials are not configured',
  ].some((marker) => text.includes(marker));
}

export async function runEhLookupBatch<T>(
  items: T[],
  intervalSeconds: number,
  lookup: (item: T) => Promise<EhBatchResponse>,
  wait: (milliseconds: number) => Promise<void>,
  isCancelled: () => boolean,
  onStart: (item: T, index: number) => void,
  onResult: (result: EhBatchResult<T>) => void,
): Promise<{ processed: number; cancelled: boolean; blocked: boolean }> {
  let processed = 0;
  let blocked = false;
  for (let index = 0; index < items.length; index += 1) {
    if (isCancelled()) break;
    const item = items[index]!;
    onStart(item, index);
    let result: EhBatchResult<T>;
    try {
      const response = await lookup(item);
      const message = response.entry?.ehError || undefined;
      const isBlocked = message ? isEhAccessOrRateBlock(message) : false;
      result = {
        item,
        kind: message ? 'failed' : response.autoBound ? 'matched' : response.refreshedBinding ? 'refreshed' : response.candidates.length ? 'matched' : 'no-match',
        ...(message ? { message } : {}),
        response,
        blocked: isBlocked,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isBlocked = isEhAccessOrRateBlock(message);
      result = { item, kind: 'failed', message, blocked: isBlocked };
    }
    onResult(result);
    processed += 1;
    if (result.blocked) {
      blocked = true;
      break;
    }
    if (isCancelled() || index === items.length - 1 || intervalSeconds <= 0) continue;
    await wait(intervalSeconds * 1000);
    if (isCancelled()) break;
  }
  return { processed, cancelled: isCancelled() && processed < items.length && !blocked, blocked };
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
  ehDisplayTitle?: string;
  ehTitleJpn?: string;
  ehTitle?: string;
  title: string;
}): string {
  return entry.customTitle || entry.ehDisplayTitle || entry.ehTitleJpn || entry.ehTitle || entry.title;
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

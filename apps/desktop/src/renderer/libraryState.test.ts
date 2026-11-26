import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveTagOrigins, effectiveTitle, ehBatchLookupBody, ehBatchResultMessage, ehLookupBody, ehLookupMessage, ehSettingsUpdateBody, entryDraft, entryPatch, entryPath, isComposingEnter, isCurrentSelection, libraryQuery, rebaseEhSettingsDraft, refreshEntryDraft, runEhLookupBatch, sameServerOrigin, shouldRemoveFromAutoFilter, updateEntryDraft } from './libraryState.js';
import type { EhSettingsValues } from './libraryState.js';

test('library query preserves repeated tag filters and all list controls', () => {
  const query = new URLSearchParams(libraryQuery({
    q: '猫', includeTags: ['artist:foo', 'language:japanese'], excludeTags: ['female:sole female'],
    rootId: 'root/1', status: 'missing', sort: 'lastOpened', limit: 25, offset: 50,
  }));
  assert.equal(query.get('q'), '猫');
  assert.deepEqual(query.getAll('includeTags'), ['artist:foo', 'language:japanese']);
  assert.deepEqual(query.getAll('excludeTags'), ['female:sole female']);
  assert.equal(query.get('rootId'), 'root/1');
  assert.equal(query.get('status'), 'missing');
  assert.equal(query.get('sort'), 'lastOpened');
  assert.equal(query.get('limit'), '25');
  assert.equal(query.get('offset'), '50');
});

test('library query can restrict results to auto-matched galleries', () => {
  const query = new URLSearchParams(libraryQuery({
    q: '', includeTags: [], excludeTags: [], rootId: '', status: 'active', sort: 'added',
    limit: 100, offset: 0, ehBindSource: 'auto',
  }));
  assert.equal(query.get('ehBindSource'), 'auto');
});

test('ordinary lookup uses server preferences and bound entries request alternatives', () => {
  assert.deepEqual(ehLookupBody('auto', '', '', false), { mode: 'auto' });
  assert.deepEqual(ehLookupBody('auto', '', 'exhentai.org', true), {
    mode: 'auto', autoBind: false,
  });
  assert.deepEqual(ehLookupBody('title', '  手動検索  ', 'e-hentai.org', true, true), {
    mode: 'title', autoBind: false, query: '手動検索', site: 'e-hentai.org', includeExpunged: true,
  });
  assert.deepEqual(ehLookupBody('title', '', '', false, false), {
    mode: 'title', includeExpunged: false,
  });
  assert.deepEqual(ehLookupBody('cover', '', 'exhentai.org', false, true), {
    mode: 'cover', site: 'exhentai.org',
  });
});

test('batch requests auto-lookup and let the server refresh existing bindings', () => {
  assert.deepEqual(ehBatchLookupBody(), { mode: 'auto', autoBind: true });
});

test('EH settings saves send changed fields only and clear credentials separately', () => {
  const baseline: EhSettingsValues = {
    site: 'e-hentai.org', language: '', useThumbnails: false, searchGid: false,
    preferOriginalTitle: false, additionalTags: false, includeExpunged: false,
    interval: 4, sendCookiesToEHentai: false,
  };
  const draft: EhSettingsValues = { ...baseline, site: 'exhentai.org', interval: 7 };
  assert.deepEqual(ehSettingsUpdateBody(draft, baseline), { site: 'exhentai.org', interval: 7 });
  assert.deepEqual(ehSettingsUpdateBody(draft, baseline, true, 'unsaved cookie draft'), { clearCredentials: true });
});

test('rebasing settings adopts remote changes while preserving unsaved preference drafts', () => {
  const baseline: EhSettingsValues = {
    site: 'e-hentai.org', language: '', useThumbnails: false, searchGid: false,
    preferOriginalTitle: false, additionalTags: false, includeExpunged: false,
    interval: 4, sendCookiesToEHentai: false,
  };
  const draft: EhSettingsValues = { ...baseline, includeExpunged: true };
  const current: EhSettingsValues = { ...baseline, site: 'exhentai.org', interval: 8 };
  assert.deepEqual(rebaseEhSettingsDraft(draft, baseline, current), {
    ...current,
    includeExpunged: true,
  });
});

test('previewing an existing auto-match does not announce a new match', () => {
  assert.equal(ehLookupMessage(true, 1), 'Auto-matched the first candidate. Confirm it or choose another gallery.');
  assert.equal(ehLookupMessage(false, 1), '');
  assert.equal(ehLookupMessage(undefined, 0), 'No matching galleries found.');
});

test('manual confirmation removes auto-bound entries from the auto-only filter', () => {
  assert.equal(shouldRemoveFromAutoFilter('auto', ['book'], 'book', 'manual'), true);
  assert.equal(shouldRemoveFromAutoFilter('auto', ['book'], 'book', 'auto'), false);
  assert.equal(shouldRemoveFromAutoFilter('', ['book'], 'book', 'manual'), false);
  assert.equal(shouldRemoveFromAutoFilter('auto', [], 'book', 'manual'), false);
});

test('batch lookup is sequential, waits after nonterminal failures, and skips the final wait', async () => {
  const events: string[] = [];
  const results: Array<{ kind: string; item: string }> = [];
  let settingsReads = 0;
  const summary = await runEhLookupBatch(
    ['matched', 'failed', 'none'],
    async () => { settingsReads += 1; return 2; },
    async (item) => {
      events.push(`lookup:${item}`);
      if (item === 'failed') throw new Error('temporary connection failure');
      return item === 'matched'
        ? { candidates: [{ gid: '1' }], autoBound: true }
        : { candidates: [] };
    },
    async (milliseconds) => { events.push(`wait:${milliseconds}`); },
    () => false,
    (item) => { events.push(`start:${item}`); },
    (result) => { results.push({ item: result.item, kind: result.kind }); },
  );

  assert.deepEqual(events, [
    'start:matched', 'lookup:matched', 'wait:2000',
    'start:failed', 'lookup:failed', 'wait:2000',
    'start:none', 'lookup:none',
  ]);
  assert.equal(settingsReads, 1);
  assert.deepEqual(results, [
    { item: 'matched', kind: 'matched' },
    { item: 'failed', kind: 'failed' },
    { item: 'none', kind: 'no-match' },
  ]);
  assert.deepEqual(summary, { processed: 3, cancelled: false, blocked: false });
});

test('batch reports a new binding with metadata error and does not call it a refresh', async () => {
  const results: Array<{ kind: string; message?: string }> = [];
  await runEhLookupBatch(
    ['new', 'existing'],
    0,
    async (item) => item === 'new'
      ? { entry: { ehBindSource: 'auto', ehError: 'gdata unavailable' }, candidates: [], autoBound: true }
      : { entry: { ehBindSource: 'manual', ehError: 'gdata unavailable' }, candidates: [], refreshedBinding: true },
    async () => assert.fail('zero interval must not wait'),
    () => false,
    () => undefined,
    (result) => results.push({ kind: result.kind, message: ehBatchResultMessage(result) }),
  );
  assert.deepEqual(results, [
    { kind: 'matched', message: 'Auto-matched; metadata error: gdata unavailable' },
    { kind: 'refreshed', message: 'Gallery remains bound; metadata refresh failed: gdata unavailable' },
  ]);
});

test('batch refreshes bound entries without changing their binding provenance', async () => {
  const provenance: Array<[string, string | null | undefined]> = [];
  await runEhLookupBatch(
    [
      { id: 'manual', source: 'manual' as const },
      { id: 'auto', source: 'auto' as const },
      { id: 'unbound', source: null },
    ],
    0,
    async (item) => item.source
      ? { entry: { ehBindSource: item.source }, candidates: [], refreshedBinding: true }
      : { entry: { ehBindSource: 'auto' }, candidates: [{ gid: '1' }], autoBound: true },
    async () => assert.fail('zero interval must not wait'),
    () => false,
    () => undefined,
    (result) => provenance.push([result.item.id, result.response?.entry?.ehBindSource]),
  );
  assert.deepEqual(provenance, [['manual', 'manual'], ['auto', 'auto'], ['unbound', 'auto']]);
});

test('batch cancel ends the wait and prevents future lookup calls', async () => {
  const events: string[] = [];
  let cancelled = false;
  const summary = await runEhLookupBatch(
    ['first', 'second'],
    4,
    async (item) => { events.push(`lookup:${item}`); return { candidates: [] }; },
    async () => { events.push('wait'); cancelled = true; },
    () => cancelled,
    () => undefined,
    (result) => { events.push(`result:${result.item}`); },
  );
  assert.deepEqual(events, ['lookup:first', 'result:first', 'wait']);
  assert.deepEqual(summary, { processed: 1, cancelled: true, blocked: false });
});

test('batch stops immediately on an explicit upstream access or rate block', async () => {
  const events: string[] = [];
  const results: string[] = [];
  const summary = await runEhLookupBatch(
    ['first', 'second'],
    4,
    async (item) => { events.push(`lookup:${item}`); throw new Error('E-Hentai temporarily banned this IP for excessive requests'); },
    async () => { events.push('wait'); },
    () => false,
    () => undefined,
    (result) => { results.push(`${result.kind}:${result.blocked}`); },
  );
  assert.deepEqual(events, ['lookup:first']);
  assert.deepEqual(results, ['failed:true']);
  assert.deepEqual(summary, { processed: 1, cancelled: false, blocked: true });
});

test('entry draft starts isolated from subsequent server snapshots', () => {
  const draft = updateEntryDraft(
    entryDraft({ id: 'entry', customTitle: 'Personal', note: 'Note', localTags: ['local:x'] }),
    { customTitle: 'Unsaved', note: 'Unsaved note' },
  );
  const refreshed = { id: 'entry', customTitle: 'Server value', note: '', openCount: 9 };
  assert.equal(refreshed.openCount, 9);
  assert.equal(draft.customTitle, 'Unsaved');
  assert.equal(draft.note, 'Unsaved note');
  assert.equal(draft.dirty, true);
});

test('late selection and save responses are ignored after another entry is selected', () => {
  const selectionA = { entryId: 'A', generation: 1 };
  const selectionB = { entryId: 'B', generation: 2 };

  assert.equal(isCurrentSelection(selectionA.entryId, selectionB.entryId, selectionA.generation, selectionB.generation), false);
  assert.equal(isCurrentSelection(selectionA.entryId, selectionA.entryId, selectionA.generation, selectionB.generation), false);
  assert.equal(isCurrentSelection(selectionB.entryId, selectionB.entryId, selectionB.generation, selectionB.generation), true);

  const draft = entryDraft({ id: 'B', note: 'B note' });
  assert.equal(draft.entryId, 'B');
  assert.equal(entryPath(draft.entryId), '/api/entries/B');
});

test('same-server connection checks preserve the selected library and IME Enter is ignored', () => {
  assert.equal(sameServerOrigin('http://library.local:4317', 'http://library.local:4317/'), true);
  assert.equal(sameServerOrigin('http://library.local:4317', 'http://other.local:4317'), false);
  assert.equal(isComposingEnter('Enter', true, 13), true);
  assert.equal(isComposingEnter('Enter', false, 229), true);
  assert.equal(isComposingEnter('Enter', false, 13), false);
  assert.equal(isComposingEnter('a', true, 65), false);
});

test('refresh updates selected entry facts without replacing its personal draft fields', () => {
  const refreshed = {
    id: 'B', title: 'Updated source title', customTitle: 'Older saved title', note: 'Older saved note',
    localTags: ['local:old'], hiddenTags: [], openCount: 3,
  };
  const cleanDraft = entryDraft({ id: 'B', customTitle: 'Personal title', note: 'Old note' });
  const dirtyDraft = updateEntryDraft(cleanDraft, { note: 'Unsaved note' });

  assert.equal(refreshEntryDraft(cleanDraft, refreshed)?.customTitle, 'Older saved title');
  assert.equal(refreshEntryDraft(cleanDraft, refreshed)?.note, 'Older saved note');
  assert.equal(refreshEntryDraft(dirtyDraft, refreshed), dirtyDraft);
  assert.equal(dirtyDraft.note, 'Unsaved note');
});

test('two desktop edits to different personal fields produce non-overlapping patches', () => {
  const initial = { id: 'B', customTitle: 'Old title', note: 'Old note', localTags: ['local:a'], hiddenTags: [] };
  const firstPatch = entryPatch(updateEntryDraft(entryDraft(initial), { note: 'Note from desktop A' }));
  assert.deepEqual(firstPatch, { note: 'Note from desktop A' });
  assert.deepEqual(entryPatch(updateEntryDraft(
    updateEntryDraft(entryDraft(initial), { note: 'Temporary edit' }),
    { note: 'Old note' },
  )), {});

  const afterDesktopA = { ...initial, ...firstPatch };
  const secondPatch = entryPatch(updateEntryDraft(entryDraft(afterDesktopA), { customTitle: 'Title from desktop B' }));
  assert.deepEqual(secondPatch, { customTitle: 'Title from desktop B' });
  assert.deepEqual({ ...afterDesktopA, ...secondPatch }, {
    ...initial, note: 'Note from desktop A', customTitle: 'Title from desktop B',
  });
});

test('personal title precedence and effective tag origins are preserved', () => {
  assert.equal(effectiveTitle({ customTitle: 'Personal', ehTitleJpn: 'Japanese', ehTitle: 'English', title: 'Filename' }), 'Personal');
  assert.equal(effectiveTitle({ ehDisplayTitle: 'Server preferred', ehTitleJpn: 'Japanese', ehTitle: 'English', title: 'Filename' }), 'Server preferred');
  assert.equal(effectiveTitle({ ehTitleJpn: 'Japanese', ehTitle: 'English', title: 'Filename' }), 'Japanese');
  assert.equal(effectiveTitle({ ehTitle: 'English', title: 'Filename' }), 'English');
  assert.equal(effectiveTitle({ title: 'Filename' }), 'Filename');
  assert.deepEqual(effectiveTagOrigins({ ehTags: ['eh:keep', 'eh:hidden'], localTags: ['local:keep', 'eh:hidden'], hiddenTags: ['eh:hidden'] }), {
    eh: ['eh:keep'], local: ['local:keep'],
  });
});

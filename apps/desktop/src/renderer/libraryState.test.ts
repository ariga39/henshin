import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveTagOrigins, effectiveTitle, entryDraft, entryPatch, entryPath, isCurrentSelection, libraryQuery, refreshEntryDraft, updateEntryDraft } from './libraryState.js';

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
  assert.equal(effectiveTitle({ ehTitleJpn: 'Japanese', ehTitle: 'English', title: 'Filename' }), 'Japanese');
  assert.equal(effectiveTitle({ ehTitle: 'English', title: 'Filename' }), 'English');
  assert.equal(effectiveTitle({ title: 'Filename' }), 'Filename');
  assert.deepEqual(effectiveTagOrigins({ ehTags: ['eh:keep', 'eh:hidden'], localTags: ['local:keep', 'eh:hidden'], hiddenTags: ['eh:hidden'] }), {
    eh: ['eh:keep'], local: ['local:keep'],
  });
});

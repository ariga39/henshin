import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveTagOrigins, effectiveTitle, entryDraft, libraryQuery } from './libraryState.js';

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
  const draft = entryDraft({ id: 'entry', customTitle: 'Personal', note: 'Note', localTags: ['local:x'] });
  draft.customTitle = 'Unsaved';
  draft.note = 'Unsaved note';
  draft.dirty = true;
  const refreshed = { id: 'entry', customTitle: 'Server value', note: '', openCount: 9 };
  assert.equal(refreshed.openCount, 9);
  assert.equal(draft.customTitle, 'Unsaved');
  assert.equal(draft.note, 'Unsaved note');
  assert.equal(draft.dirty, true);
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

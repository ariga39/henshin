import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { relativePathParts, resolveLocalPath } from './paths.js';

test('relative path syntax follows platform filename rules', () => {
  assert.deepEqual(
    relativePathParts('C:comic\\chapter.zip', 'darwin'),
    ['C:comic\\chapter.zip'],
  );
  assert.throws(() => relativePathParts('C:comic\\chapter.zip', 'win32'));
  assert.throws(() => relativePathParts('folder/../outside.zip', 'win32'));
  assert.throws(() => relativePathParts('folder/C:outside.zip', 'win32'));
});

test('resolves files inside a mapped root and rejects traversal and symlink escape', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'henshin-path-'));
  const root = path.join(base, 'root'); await mkdir(root); await writeFile(path.join(root, 'book (1).zip'), 'zip');
  await writeFile(path.join(base, 'outside.zip'), 'outside'); await symlink(path.join(base, 'outside.zip'), path.join(root, 'link.zip'));
  try {
    assert.equal(await resolveLocalPath({ r: root }, 'r', 'book (1).zip'), path.join(await realpath(root), 'book (1).zip'));
    for (const bad of ['../outside.zip','/etc/passwd','','a//b','./x']) await assert.rejects(resolveLocalPath({ r: root }, 'r', bad));
    if (process.platform === 'win32') {
      for (const bad of ['C:\\Windows', 'a\\b']) await assert.rejects(resolveLocalPath({ r: root }, 'r', bad));
    } else {
      const unixName = 'C:comic\\chapter.zip';
      await writeFile(path.join(root, unixName), 'zip');
      assert.equal(
        await resolveLocalPath({ r: root }, 'r', unixName),
        path.join(await realpath(root), unixName),
      );
    }
    await assert.rejects(resolveLocalPath({ r: root }, 'r', 'link.zip'), /outside/);
    await assert.rejects(resolveLocalPath({}, 'r', 'book.zip'), /mapping/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveLocalPath } from './paths.js';

test('resolves files inside a mapped root and rejects traversal and symlink escape', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'henshin-path-'));
  const root = path.join(base, 'root'); await mkdir(root); await writeFile(path.join(root, 'book (1).zip'), 'zip');
  await writeFile(path.join(base, 'outside.zip'), 'outside'); await symlink(path.join(base, 'outside.zip'), path.join(root, 'link.zip'));
  try {
    assert.equal(await resolveLocalPath({ r: root }, 'r', 'book (1).zip'), path.join(await realpath(root), 'book (1).zip'));
    for (const bad of ['../outside.zip','/etc/passwd','C:\\Windows','a\\b','','a//b','./x']) await assert.rejects(resolveLocalPath({ r: root }, 'r', bad));
    await assert.rejects(resolveLocalPath({ r: root }, 'r', 'link.zip'), /outside/);
    await assert.rejects(resolveLocalPath({}, 'r', 'book.zip'), /mapping/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

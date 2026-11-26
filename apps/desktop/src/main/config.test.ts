import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectionForSave, readConfig, writeConfig } from './config.js';

test('connection save keeps a blank token only for the same server origin', () => {
  const current = { url: 'http://library.local:4317/api', token: 'saved-token' };
  assert.deepEqual(
    connectionForSave(current, { url: 'http://library.local:4317', token: '' }),
    { url: 'http://library.local:4317', token: 'saved-token' },
  );
  assert.deepEqual(
    connectionForSave(current, { url: 'http://other-library.local:4317', token: '' }),
    { url: 'http://other-library.local:4317', token: '' },
  );
  assert.deepEqual(
    connectionForSave(current, { url: 'http://other-library.local:4317', token: 'new-token' }),
    { url: 'http://other-library.local:4317', token: 'new-token' },
  );
});

test('config persists token, mappings, and readers with private Unix permissions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'henshin-config-'));
  try {
    const value = await readConfig(dir); value.connection={url:'http://localhost:4317',token:'secret'}; value.mappings.r='/books'; value.readers=[{id:'a',name:'Reader',mode:'system',args:[],isDefault:true}];
    await writeConfig(dir,value); const reread=await readConfig(dir); assert.deepEqual(reread,value); assert.equal(JSON.parse(await readFile(path.join(dir,'desktop-config.json'),'utf8')).connection.token,'secret');
    if(process.platform!=='win32') assert.equal((await stat(path.join(dir,'desktop-config.json'))).mode & 0o777,0o600);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('parallel config writes serialize and preserve the last requested settings', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'henshin-config-'));
  try {
    const first = {
      connection: { url: 'http://first.local', token: 'first-token' },
      mappings: { first: '/first' },
      readers: [],
    };
    const last = {
      connection: { url: 'http://last.local', token: 'last-token' },
      mappings: { last: '/last' },
      readers: [],
    };

    await Promise.all([writeConfig(dir, first), writeConfig(dir, last)]);

    assert.deepEqual(await readConfig(dir), last);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('missing config falls back cleanly and malformed config reports an error', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'henshin-config-'));
  try { assert.deepEqual(await readConfig(dir),{connection:{url:'',token:''},mappings:{},readers:[]}); await writeFile(path.join(dir,'desktop-config.json'),'{'); await assert.rejects(readConfig(dir),/Could not read desktop-config/); } finally { await rm(dir,{recursive:true,force:true}); }
});

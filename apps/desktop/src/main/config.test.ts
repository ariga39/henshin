import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readConfig, writeConfig } from './config.js';

test('config persists token, mappings, and readers with private Unix permissions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'henshin-config-'));
  try {
    const value = await readConfig(dir); value.connection={url:'http://localhost:4317',token:'secret'}; value.mappings.r='/books'; value.readers=[{id:'a',name:'Reader',mode:'system',args:[],isDefault:true}];
    await writeConfig(dir,value); const reread=await readConfig(dir); assert.deepEqual(reread,value); assert.equal(JSON.parse(await readFile(path.join(dir,'desktop-config.json'),'utf8')).connection.token,'secret');
    if(process.platform!=='win32') assert.equal((await stat(path.join(dir,'desktop-config.json'))).mode & 0o777,0o600);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('missing config falls back cleanly and malformed config reports an error', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'henshin-config-'));
  try { assert.deepEqual(await readConfig(dir),{connection:{url:'',token:''},mappings:{},readers:[]}); await writeFile(path.join(dir,'desktop-config.json'),'{'); await assert.rejects(readConfig(dir),/Could not read desktop-config/); } finally { await rm(dir,{recursive:true,force:true}); }
});

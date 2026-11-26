import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from './api.js';

test('API bridge sends bearer authorization and converts common statuses to readable errors', async()=>{
  const original=globalThis.fetch;let seen:RequestInit|undefined;let url='';
  try {
    globalThis.fetch=(async(input,init)=>{url=String(input);seen=init;return new Response(JSON.stringify({serverId:'local',version:'1'}),{status:200});}) as typeof fetch;
    const health=await request<{serverId:string}>({url:'http://127.0.0.1:4317',token:'private-token'},'/api/health');
    assert.equal(health.serverId,'local');assert.equal(url,'http://127.0.0.1:4317/api/health');assert.equal((seen?.headers as Record<string,string>).Authorization,'Bearer private-token');
    for(const [status,pattern] of [[401,/rejected/],[409,/already running/],[404,/not found/],[503,/HTTP 503/]] as const){globalThis.fetch=(async()=>new Response('{}',{status})) as typeof fetch;await assert.rejects(request({url:'http://server',token:'t'},'/api/test'),pattern);}
    globalThis.fetch=(async()=>{throw new Error('secret details');}) as typeof fetch;await assert.rejects(request({url:'http://server',token:'t'},'/api/test'),/Could not reach/);
  }finally{globalThis.fetch=original;}
});

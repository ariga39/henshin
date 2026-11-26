import test from 'node:test';
import assert from 'node:assert/strict';
import { launchReader } from './reader.js';

test('system mode delegates to OS association and reports failure', async()=>{
  let got=''; await launchReader({id:'s',name:'',mode:'system',args:[],isDefault:true},'/books/a.zip',async file=>{got=file;return '';}); assert.equal(got,'/books/a.zip');
  await assert.rejects(launchReader({id:'s',name:'',mode:'system',args:[],isDefault:true},'/x',async()=> 'no app'),/no app/);
});
test('executable mode uses argument boundaries and shell false',async()=>{
  const child={unref(){},once(event:string,callback:(error?:Error)=>void){if(event==='spawn')setImmediate(()=>callback());return this;}};
  const mock=(...args:any[])=>{assert.deepEqual(args,['/reader',['-a','/Applications/Reader.app','--label=value with spaces','/books/[name] $(x);.zip'],{detached:true,stdio:'ignore',shell:false}]);return child as any;};
  await launchReader({id:'a',name:'',mode:'executable',executable:'/reader',args:['-a','/Applications/Reader.app','--label=value with spaces'],isDefault:true},'/books/[name] $(x);.zip',async()=> '',mock as any);
});

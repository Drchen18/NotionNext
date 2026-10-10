import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/server.js';

test('local HTTP app: origin/session/CSRF guards, note pagination, key confidentiality and idempotent trading',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'chain-arb-http-')), app=createApplication(dir), port=await app.listen();
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});app.engine.stop();
  const base=`http://127.0.0.1:${port}`;
  assert.equal((await fetch(base+'/api/state')).status,401);
  assert.equal((await fetch(base+'/',{headers:{Origin:'https://evil.example'}})).status,403);
  const root=await fetch(base+'/');assert.equal(root.status,200);assert.match(await root.text(),/ChainDesk/);const cookie=root.headers.get('set-cookie').split(';')[0];
  const state=await(await fetch(base+'/api/state',{headers:{Cookie:cookie}})).json();const csrf=state.csrf;
  const post=(path,input,extra={})=>fetch(base+'/api/'+path,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf,...extra},body:JSON.stringify(input)});
  assert.equal((await post('notes/save',{text:'must fail'},{'X-CSRF-Token':'invalid'})).status,403);
  for(let i=0;i<9;i++)assert.equal((await post('notes/save',{text:`测试备忘录 ${i}`})).status,201);
  const notes=await(await fetch(base+'/api/notes?page=2',{headers:{Cookie:cookie}})).json();assert.equal(notes.total,9);assert.equal(notes.items.length,1);assert.ok(notes.items[0].created);
  const wallet=await(await post('wallet/import',{chain:'bnb',type:'private',privateKey:'1'.repeat(64),password:'strong-local-password'})).json();assert.ok(wallet.address);assert.equal(wallet.privateKey,undefined);assert.equal(wallet.encrypted,undefined);
  const output=await(await fetch(base+'/api/state',{headers:{Cookie:cookie}})).text();assert.ok(!output.includes('1'.repeat(64)));assert.ok(!output.includes('strong-local-password'));
  await app.engine.tick(true);
  const key='idempotent-test-key';assert.equal((await post('arbitrage',{}, {'Idempotency-Key':key})).status,202);
  assert.equal((await post('arbitrage',{}, {'Idempotency-Key':key})).status,202);
  while(app.engine.busy)await new Promise(r=>setTimeout(r,30));
  assert.equal(app.store.list().total,1);assert.equal(app.store.job(key).state,'COMPLETED');assert.equal(app.store.limits('paper').executions,1);
});

test('standalone entry starts through a symlink and prints a usable local URL',async t=>{
  const {spawn}=await import('node:child_process');
  const {symlinkSync}=await import('node:fs');
  const {fileURLToPath}=await import('node:url');
  const dir=mkdtempSync(join(tmpdir(),'chain-arb-start-'));
  const original=fileURLToPath(new URL('../src/start.js',import.meta.url));
  const entry=process.platform==='win32'?original:join(dir,'entry.js');
  if(process.platform!=='win32')symlinkSync(original,entry);
  const child=spawn(process.execPath,[entry],{env:{...process.env,ARB_DATA_DIR:join(dir,'data'),PORT:'0'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}rmSync(dir,{recursive:true,force:true});});
  const url=await new Promise((resolve,reject)=>{
    let output='',errors='';const timer=setTimeout(()=>reject(new Error('Startup timeout: '+output+errors)),10000);
    child.stderr.on('data',data=>{errors+=data.toString();});
    child.stdout.on('data',data=>{output+=data.toString();const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Startup exited: '+code+' '+output+errors));});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  const response=await fetch(url);assert.equal(response.status,200);assert.match(await response.text(),/ChainDesk/);
});

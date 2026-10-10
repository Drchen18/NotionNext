import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, Interface } from 'ethers';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Store } from '../src/store.js';
import { Vault } from '../src/vault.js';
import { PaperAdapter } from '../src/adapters.js';
import { Engine } from '../src/engine.js';
import { Chains, translate } from '../src/chains.js';
import { mergeConfig } from '../src/config.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'chain-arb-test-')), store=new Store(dir), vault=new Vault(store), adapter=new PaperAdapter(store,()=>store.get('config')), engine=new Engine(store,vault,{paper:adapter});
  t.after(()=>{engine.stop();store.close();rmSync(dir,{recursive:true,force:true});}); return {dir,store,vault,adapter,engine};
}
test('sequential arbitrage waits for confirmation and sells actual received quantity',async t=>{
  const {engine,adapter,store}=fixture(t), calls=[]; const execute=adapter.execute.bind(adapter);
  adapter.execute=async(q,hook)=>{calls.push({side:q.side,raw:q.amountRaw,state:engine.active?store.job(engine.active).state:null});return execute(q,hook);};
  const job=await engine.runArbitrage(); assert.equal(job.state,'COMPLETED'); assert.equal(calls.length,2); assert.equal(calls[0].side,'buy'); assert.equal(calls[1].side,'sell');
  assert.equal(calls[1].state,'SELL_PREPARING'); assert.equal(calls[1].raw,job.buyResult.outputRaw); assert.ok(job.events.findIndex(e=>e.state==='BUY_CONFIRMED')<job.events.findIndex(e=>e.state==='SELL_PREPARING'));
  assert.ok(job.result.profit>0); assert.equal(job.result.output-job.result.input-job.result.gasUsd-job.result.rentUsd,job.result.profit); assert.equal(store.limits('paper').executions,1);
});
test('unconfirmed or failed buy cannot cause a sell; failure pauses all automation',async t=>{
  const {engine,adapter,store}=fixture(t); let sells=0;
  store.set('automation',{arbitrage:true,rebalance:true});
  adapter.execute=async(q,hook)=>{if(q.side==='sell')sells++;await hook({phase:'SUBMITTED',hash:'pending-hash',chain:q.chain,tag:'swap'});throw new Error('确认超时');};
  await assert.rejects(engine.runArbitrage(),/确认超时/); assert.equal(sells,0); assert.equal(store.list().items[0].state,'RECOVERY_REQUIRED'); assert.ok(store.get('pause')); assert.deepEqual(store.get('automation'),{arbitrage:false,rebalance:false});
});
test('sell failure leaves a confirmed buy archived and pauses with no retry',async t=>{
  const {engine,adapter,store}=fixture(t); const execute=adapter.execute.bind(adapter);
  adapter.execute=(q,hook)=>q.side==='sell'?Promise.reject(new Error('卖出失败')):execute(q,hook);
  await assert.rejects(engine.runArbitrage(),/卖出失败/); const j=store.list().items[0];assert.ok(j.buyResult);assert.equal(j.state,'RECOVERY_REQUIRED');assert.ok(store.get('pause'));
});
test('execution count and cumulative amount cannot be bypassed',async t=>{
  const {store,engine}=fixture(t);store.set('limits:paper',{executions:20,total:100});
  await assert.rejects(engine.runArbitrage(),/执行次数上限/); assert.equal(store.list().total,0);
  assert.throws(()=>mergeConfig(store.get('config'),{risk:{amount:11}}),/1–10/);
});
test('inventory shortage blocks buy before any broadcast',async t=>{
  const {store,engine}=fixture(t), b=store.get('paper:balances');b.sol.tokens=0;store.set('paper:balances',b);
  await assert.rejects(engine.runArbitrage(),/库存不足/);assert.equal(store.list().total,0);
});
test('rebalance only below 5U; net arrivals achieve 60/40 and cooldown blocks repeat',async t=>{
  const {store,engine}=fixture(t);const c=store.get('config');c.bridge.maxWearUsd=2;c.bridge.maxWearPct=3;store.set('config',c);
  const b=store.get('paper:balances');b.sol.cash=4;b.bnb.cash=96;store.set('paper:balances',b);engine.snapshot=await engine.adapter().refresh();
  const plan=await engine.rebalancePlan();assert.equal(plan.eligible,true);assert.equal(plan.to,'sol');
  const j=await engine.runBridge(plan.from,plan.amount,true);assert.equal(j.state,'COMPLETED');const after=store.get('paper:balances');assert.ok(Math.abs(after.sol.cash/(after.sol.cash+after.bnb.cash)-0.6)<0.001);
  after.sol.cash=4;store.set('paper:balances',after);engine.snapshot=await engine.adapter().refresh();assert.match((await engine.rebalancePlan()).reason,/冷却/);
  store.set('rebalance:paper',null);after.sol.cash=5;store.set('paper:balances',after);engine.snapshot=await engine.adapter().refresh();assert.equal((await engine.rebalancePlan()).eligible,false);
});
test('bridge has no arbitrary per-transfer cap, but wear and gas still constrain it',async t=>{
  const {store,engine}=fixture(t);const c=store.get('config');c.bridge.maxWearUsd=10000;c.bridge.maxWearPct=10;store.set('config',c);const b=store.get('paper:balances');b.bnb.cash=100000;b.sol.cash=20;store.set('paper:balances',b);
  const q=await engine.bridgePreview('bnb',50000);assert.equal(q.reasons.length,0);
  c.bridge.maxWearUsd=0.01;store.set('config',c);assert.ok((await engine.bridgePreview('bnb',50000)).reasons.includes('跨链美元磨损超过上限'));
});
test('wallets are separately encrypted; public API shape contains no secrets; restart requires password',t=>{
  const {store,vault,dir}=fixture(t), privateKey=Wallet.createRandom().privateKey, sol=Keypair.generate(), password='test-password-strong';
  vault.importWallet('bnb',{type:'private',privateKey,password});vault.importWallet('sol',{type:'private',privateKey:bs58.encode(sol.secretKey),password});
  const publicData=JSON.stringify([vault.publicWallet('bnb'),vault.publicWallet('sol')]);assert.ok(!publicData.includes(privateKey));assert.ok(!JSON.stringify(store.get('wallet:bnb')).includes(privateKey));assert.ok(!readFileSync(join(dir,'archive.sqlite')).includes(Buffer.from(privateKey)));
  vault.lock();const restarted=new Vault(store);assert.equal(restarted.publicWallet('bnb').unlocked,false);assert.throws(()=>restarted.unlock('bnb','incorrect-password'),/密码错误/);restarted.unlock('bnb',password);assert.equal(restarted.publicWallet('bnb').unlocked,true);assert.equal(restarted.publicWallet('sol').unlocked,false);
});
test('restart journals unresolved work and disarms automation',()=>{
  const dir=mkdtempSync(join(tmpdir(),'chain-arb-restart-'));let store=new Store(dir);const j=store.create('arbitrage',{mode:'live'});store.transition(j.id,'BUY_SWAP_SUBMITTED',{hash:'known-hash'});store.set('automation',{arbitrage:true,rebalance:true});store.close();store=new Store(dir);
  assert.equal(store.job(j.id).state,'RECOVERY_REQUIRED');assert.equal(store.job(j.id).events[1].detail.hash,'known-hash');assert.ok(store.get('pause'));assert.equal(store.get('automation').arbitrage,false);store.close();rmSync(dir,{recursive:true,force:true});
});
test('token quantities translate with bigint precision and only truncate unsellable dust',()=>{
  assert.equal(translate('123456789012345678901234',18,9),'123456789012345');assert.equal(translate('123456789',6,18),'123456789000000000000');
});
test('BNB reconciliation derives actual net transfers and gas from logs',t=>{
  const {vault,store}=fixture(t), chains=new Chains({},vault,()=>store.get('config')), iface=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const owner=Wallet.createRandom().address, router=Wallet.createRandom().address, stable=Wallet.createRandom().address, token=Wallet.createRandom().address;
  const log=(address,from,to,value)=>({address,...iface.encodeEventLog(iface.getEvent('Transfer'),[from,to,value])});
  const receipt={from:owner,logs:[log(stable,owner,router,500n),log(token,router,owner,1000n),log(token,owner,router,2n)],gasUsed:'0x5208',effectiveGasPrice:'0x3b9aca00'};
  const r=chains.reconcile('bnb',receipt,stable,token,owner);assert.equal(r.inputRaw,'500');assert.equal(r.outputRaw,'998');assert.equal(r.feeNative,0.000021);
});
test('Solana receipt reconciliation separates fee, rent and exact token delta',t=>{
  const {vault,store}=fixture(t), chains=new Chains({},vault,()=>store.get('config')), owner=Keypair.generate().publicKey.toBase58();
  const b=(mint,amount)=>({owner,mint,uiTokenAmount:{amount}}); const receipt={transaction:{message:{accountKeys:[{pubkey:owner}]}},meta:{fee:5000,preBalances:[1000000000],postBalances:[997955720],preTokenBalances:[b('stable','10000'),b('token','100')],postTokenBalances:[b('stable','5000'),b('token','1098')]}};
  const r=chains.reconcile('sol',receipt,'stable','token',owner);assert.equal(r.inputRaw,'5000');assert.equal(r.outputRaw,'998');assert.equal(r.feeNative,0.000005);assert.ok(Math.abs(r.rentNative-0.00203928)<1e-12);
});
test('recipient-only Solana cross-chain receipt proves token credit without attributing relayer fees',t=>{
  const {vault,store}=fixture(t),chains=new Chains({},vault,()=>store.get('config')),owner=Keypair.generate().publicKey.toBase58(),relayer=Keypair.generate().publicKey.toBase58();
  const receipt={transaction:{message:{accountKeys:[{pubkey:relayer}]}},meta:{fee:5000,preBalances:[1000000],postBalances:[995000],preTokenBalances:[],postTokenBalances:[{owner,mint:'usdc',uiTokenAmount:{amount:'123456'}}]}};
  const r=chains.reconcile('sol',receipt,'usdc','usdc',owner);assert.equal(r.outputRaw,'123456');assert.equal(r.feeNative,0);assert.equal(r.rentNative,0);
});
test('pause during preparation prevents a new broadcast',async t=>{
  const {engine,adapter,store}=fixture(t);const execute=adapter.execute.bind(adapter);adapter.execute=async(q,hook)=>{engine.pause('人工暂停');return execute(q,hook);};
  await assert.rejects(engine.runArbitrage(),/暂停指令/);const j=store.list().items[0];assert.equal(j.state,'RECOVERY_REQUIRED');assert.ok(!j.events.some(e=>e.state.endsWith('SUBMITTED')));
});
test('a data directory cannot be opened by two simultaneous trading instances',t=>{
  const {dir}=fixture(t);assert.throws(()=>new Store(dir),/已有运行实例/);
});

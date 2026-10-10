import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Interface, Wallet } from 'ethers';
import { Keypair, TransactionMessage, VersionedTransaction, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { RpcPool } from '../src/network.js';
import { Chains } from '../src/chains.js';
import { pancakeQuote, PANCAKE_ROUTER } from '../src/pancake.js';
import { defaults } from '../src/config.js';

test('RPC rotates successful calls, fails over failed endpoints, and rejects wrong networks',async t=>{
  let broken=true, first=0, second=0;
  const make=handler=>http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const q=JSON.parse(Buffer.concat(chunks));handler(q,res);});
  const a=make((q,res)=>{first++;if(broken){res.writeHead(503);res.end();return;}res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:q.method==='eth_chainId'?'0x38':'0x1'}));});
  const b=make((q,res)=>{second++;res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:q.method==='eth_chainId'?'0x38':'0x2'}));});
  await Promise.all([a,b].map(s=>new Promise(r=>s.listen(0,'127.0.0.1',r))));t.after(async()=>{await Promise.all([a,b].map(s=>new Promise(r=>s.close(r))));});
  const pool=new RpcPool(()=>({bnb:{rpc:[`http://127.0.0.1:${a.address().port}`,`http://127.0.0.1:${b.address().port}`]}}));
  assert.equal(await pool.call('bnb','eth_gasPrice'),'0x2');assert.equal(pool.status.bnb.index,2);broken=false;
  assert.equal(await pool.call('bnb','eth_gasPrice'),'0x1');assert.equal(pool.status.bnb.index,1);assert.equal(await pool.call('bnb','eth_gasPrice'),'0x2');assert.ok(first>1&&second>1);
  const wrong=make((q,res)=>res.end(JSON.stringify({result:'0x1'})));await new Promise(r=>wrong.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>wrong.close(r)));
  await assert.rejects(new RpcPool(()=>({bnb:{rpc:[`http://127.0.0.1:${wrong.address().port}`]}})).call('bnb','eth_gasPrice'),/网络错误/);
});
test('Pancake direct quote binds pool identity, exact input, minimum output, recipient and deadline',async()=>{
  const c=structuredClone(defaults), owner=Wallet.createRandom().address, token=Wallet.createRandom().address, stable=Wallet.createRandom().address, pool=Wallet.createRandom().address;
  Object.assign(c.bnb,{token,stable,pool}); const factory='0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
  const abi=new Interface(['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function getReserves() view returns(uint112,uint112,uint32)','function getPair(address,address) view returns(address)','function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)']);
  const results={token0:[stable],token1:[token],factory:[factory],getReserves:[100000n*10n**18n,100000n*10n**9n,0],getPair:[pool]};
  const adapter={config:()=>c,vault:{publicWallet:()=>({address:owner})},rpc:{call:async(_chain,_method,[request])=>{const parsed=abi.parseTransaction({data:request.data});return abi.encodeFunctionResult(parsed.name,results[parsed.name]);}},chains:{decimals:async(_chain,t)=>t===stable?18:9,gas:async()=>({native:0.0001,usd:0.06,fee:0.0001,rent:0})}};
  const q=await pancakeQuote(adapter,'bnb','buy','5000000000000000000',{bnb:{nativePrice:600}}), decoded=abi.parseTransaction({data:q.route.tx.data});
  assert.equal(q.spender,PANCAKE_ROUTER);assert.equal(q.route.pool,pool);assert.equal(decoded.args[0],5000000000000000000n);assert.ok(decoded.args[1]<BigInt(q.outRaw));assert.deepEqual([...decoded.args[2]],[stable,token]);assert.equal(decoded.args[3],owner);assert.ok(Number(decoded.args[4])>Date.now()/1000);
  results.getPair=[Wallet.createRandom().address];await assert.rejects(pancakeQuote(adapter,'bnb','buy','5000000000000000000',{bnb:{nativePrice:600}}),/指定池必须/);
});
test('Solana strict pool proof resolves actual instruction accounts and rejects a different pool',async()=>{
  const signer=Keypair.generate(),pool=Keypair.generate().publicKey,program=Keypair.generate().publicKey;
  const instruction=new TransactionInstruction({programId:program,keys:[{pubkey:pool,isSigner:false,isWritable:true}],data:Buffer.from([1])});
  const message=new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[instruction]}).compileToV0Message();
  const tx=new VersionedTransaction(message), data=bs58.encode(tx.serialize()), chains=new Chains({}, {},()=>defaults);
  await chains.verifySolPool(data,pool.toBase58());await assert.rejects(chains.verifySolPool(data,Keypair.generate().publicKey.toBase58()),/指定交易池/);
});

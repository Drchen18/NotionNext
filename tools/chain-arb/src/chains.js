import { Interface, parseUnits, formatUnits, keccak256, isAddress } from 'ethers';
import { VersionedTransaction, Transaction, AddressLookupTableAccount, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { waitFor } from './network.js';

const abi = new Interface(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
export const units = (value, decimals) => parseUnits(Number(value).toFixed(Math.min(decimals, 18)), decimals).toString();
export const display = (raw, decimals) => Number(formatUnits(BigInt(raw), decimals));
export function translate(raw, fromDecimals, toDecimals) {
  const n = BigInt(raw); return (toDecimals >= fromDecimals ? n * 10n ** BigInt(toDecimals - fromDecimals) : n / 10n ** BigInt(fromDecimals - toDecimals)).toString();
}
const hex = n => `0x${BigInt(n).toString(16)}`;
export class Chains {
  constructor(rpc, vault, config) { this.rpc = rpc; this.vault = vault; this.config = config; this.decimalCache = new Map(); }
  async read(token, fn, args = []) { const r = await this.rpc.call('bnb', 'eth_call', [{ to: token, data: abi.encodeFunctionData(fn, args) }, 'latest']); return abi.decodeFunctionResult(fn, r)[0]; }
  async decimals(chain, token) {
    const key = `${chain}:${token}`; if (this.decimalCache.has(key)) return this.decimalCache.get(key);
    let d;
    if (chain === 'bnb') d = Number(await this.read(token, 'decimals'));
    else { const r = await this.rpc.call('sol', 'getAccountInfo', [token, { encoding: 'jsonParsed', commitment: 'finalized' }]); if (r?.value?.data?.parsed?.type !== 'mint') throw new Error('Solana 代币地址不是 Mint'); d = r.value.data.parsed.info.decimals; }
    if (!Number.isInteger(d) || d < 0 || d > 30) throw new Error('不支持的代币精度'); this.decimalCache.set(key, d); return d;
  }
  async rawBalance(chain, token, addr) {
    if (chain === 'bnb') return (await this.read(token, 'balanceOf', [addr])).toString();
    const r = await this.rpc.call('sol', 'getTokenAccountsByOwner', [addr, { mint: token }, { encoding: 'jsonParsed', commitment: 'finalized' }]);
    return r.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n).toString();
  }
  async balances(chain) {
    const c = this.config()[chain], w = this.vault.publicWallet(chain); if (!w.address) throw new Error('钱包未导入');
    const nativeRaw = chain === 'bnb' ? await this.rpc.call(chain, 'eth_getBalance', [w.address, 'latest']) : (await this.rpc.call(chain, 'getBalance', [w.address, { commitment: 'finalized' }])).value;
    const stableDecimals = await this.decimals(chain, c.stable);
    const tokenDecimals = c.token ? await this.decimals(chain, c.token) : null;
    const stableRaw = await this.rawBalance(chain, c.stable, w.address), tokenRaw = c.token ? await this.rawBalance(chain, c.token, w.address) : '0';
    return { cash: display(stableRaw, stableDecimals), tokens: tokenDecimals === null ? 0 : display(tokenRaw, tokenDecimals), stableRaw, tokenRaw, stableDecimals, tokenDecimals, native: display(String(nativeRaw), chain === 'bnb' ? 18 : 9), at: new Date().toISOString() };
  }
  decodeSol(data) {
    if (typeof data !== 'string') throw new Error('缺少 Solana 交易');
    let raw; try { raw = bs58.decode(data); } catch { throw new Error('OKX Solana 交易编码无效'); }
    try { return VersionedTransaction.deserialize(raw); } catch { return Transaction.from(raw); }
  }
  async verifySolPool(data, pool) {
    const tx = this.decodeSol(data), msg = tx instanceof VersionedTransaction ? tx.message : tx.compileMessage();
    let keys;
    if (tx instanceof VersionedTransaction) {
      const tables = await Promise.all(msg.addressTableLookups.map(async lookup => {
        const r = await this.rpc.call('sol','getAccountInfo',[lookup.accountKey.toBase58(),{encoding:'base64',commitment:'confirmed'}]);
        if (!r.value?.data?.[0]) throw new Error('无法解析 Solana 路由地址查找表');
        return new AddressLookupTableAccount({key:lookup.accountKey,state:AddressLookupTableAccount.deserialize(Buffer.from(r.value.data[0],'base64'))});
      }));
      const resolved = msg.getAccountKeys({addressLookupTableAccounts:tables}); keys = Array.from({length:resolved.length},(_,i)=>resolved.get(i).toBase58());
    } else keys = msg.accountKeys.map(k=>k.toBase58());
    const index=keys.indexOf(pool), instructions=msg.compiledInstructions || msg.instructions;
    if (index < 0 || !instructions.some(ix=>Array.from(ix.accountKeyIndexes || ix.accounts).includes(index))) throw new Error('Solana 路由没有使用指定交易池，严格池模式阻止执行');
  }
  async gas(chain, tx, market) {
    if (!tx?.data) throw new Error('路由缺少交易数据');
    if (chain === 'bnb') {
      const price = BigInt(await this.rpc.call(chain, 'eth_gasPrice'));
      const gasLimit = BigInt(tx.gas || tx.gasLimit || 0); if (gasLimit <= 0n) throw new Error('OKX 未提供 BNB Gas limit');
      const limit = gasLimit * 12n / 10n;
      const native = display((limit * price + 240000n * price).toString(), 18);
      return { native, fee: native, rent: 0, usd: native * market.nativePrice, gasPrice: price.toString(), gasLimit: limit.toString() };
    }
    const decoded = this.decodeSol(tx.data), message = decoded instanceof VersionedTransaction ? decoded.message : decoded.compileMessage();
    const fee = await this.rpc.call(chain, 'getFeeForMessage', [Buffer.from(message.serialize()).toString('base64'), { commitment: 'confirmed' }]);
    if (!Number.isFinite(fee.value) || fee.value <= 0) throw new Error('Solana 报价 blockhash 过期或费用不可计算');
    const rent = Number(await this.rpc.call(chain, 'getMinimumBalanceForRentExemption', [165])) * 2 / 1e9;
    return { native: fee.value / 1e9 + rent, fee: fee.value / 1e9, rent, usd: (fee.value / 1e9 + rent) * market.nativePrice };
  }
  async wait(chain, hash) {
    if (chain === 'bnb') return waitFor(async () => {
      const r = await this.rpc.call(chain, 'eth_getTransactionReceipt', [hash]); if (!r) return null;
      if (r.status !== '0x1') { const error=new Error('BNB 链上交易回滚');error.receipt=r;throw error; }
      const tip = BigInt(await this.rpc.call(chain, 'eth_blockNumber'));
      if (tip - BigInt(r.blockNumber) + 1n < BigInt(this.config().bnb.confirmations)) return null;
      const block = await this.rpc.call(chain, 'eth_getBlockByNumber', [r.blockNumber, false]); if (block?.hash !== r.blockHash) return null;
      return r;
    });
    return waitFor(async () => {
      const r = await this.rpc.call(chain, 'getSignatureStatuses', [[hash], { searchTransactionHistory: true }]); const s = r?.value?.[0];
      if (s?.err) throw new Error('Solana 链上交易失败'); if (s?.confirmationStatus !== 'finalized') return null;
      const t = await this.rpc.call(chain, 'getTransaction', [hash, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]); if (!t) return null; if (t.meta?.err) throw new Error('Solana 链上交易失败'); return t;
    });
  }
  reconcile(chain, receipt, fromToken, toToken, addr) {
    let input = 0n, output = 0n, fee, rent = 0;
    if (chain === 'bnb') {
      for (const log of receipt.logs || []) {
        try { const t = abi.parseLog(log); if (t?.name !== 'Transfer') continue; const owner = addr.toLowerCase(), from = t.args.from.toLowerCase(), to = t.args.to.toLowerCase();
          if (log.address.toLowerCase() === fromToken.toLowerCase()) input += (from === owner ? t.args.value : 0n) - (to === owner ? t.args.value : 0n);
          if (log.address.toLowerCase() === toToken.toLowerCase()) output += (to === owner ? t.args.value : 0n) - (from === owner ? t.args.value : 0n);
        } catch { /* unrelated log */ }
      }
      fee = receipt.from?.toLowerCase() === addr.toLowerCase() ? display((BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString(), 18) : 0;
    } else {
      const sums = (balances, mint) => (balances || []).filter(b => b.owner === addr && b.mint === mint).reduce((n,b) => n + BigInt(b.uiTokenAmount.amount), 0n);
      input = sums(receipt.meta.preTokenBalances, fromToken) - sums(receipt.meta.postTokenBalances, fromToken);
      output = sums(receipt.meta.postTokenBalances, toToken) - sums(receipt.meta.preTokenBalances, toToken);
      const keys = receipt.transaction.message.accountKeys.map(k => typeof k === 'string' ? k : k.pubkey); const index = keys.indexOf(addr);
      fee = index === 0 ? receipt.meta.fee / 1e9 : 0;
      rent = index < 0 ? 0 : (receipt.meta.preBalances[index] - receipt.meta.postBalances[index]) / 1e9 - fee;
    }
    return { inputRaw: input.toString(), outputRaw: output.toString(), feeNative: fee, rentNative: rent, receipt };
  }
  async sendEvm(tx, gas, hook, tag = 'swap') {
    const signer = this.vault.unlocked.get('bnb'); if (!signer) throw new Error('BNB 钱包已锁定');
    if (!isAddress(tx.to) || !/^0x[0-9a-f]+$/i.test(tx.data) || BigInt(tx.value || 0) !== 0n) throw new Error('仅允许配置 ERC20 的零原生币 value 交易');
    if (tx.from && tx.from.toLowerCase() !== signer.address.toLowerCase()) throw new Error('BNB 发送钱包不匹配');
    const request = { to: tx.to, data: tx.data, value: 0n, chainId: 56, type: 0, nonce: Number(BigInt(await this.rpc.call('bnb', 'eth_getTransactionCount', [signer.address, 'pending']))), gasPrice: BigInt(gas.gasPrice), gasLimit: BigInt(gas.gasLimit) };
    const maximumFee = display((request.gasPrice * request.gasLimit).toString(), 18);
    if (maximumFee + (gas.usedNative || 0) > this.config().risk.maxBnbGas) throw new Error('BNB 广播前总 Gas 预算超限');
    const nativeBalance = display(await this.rpc.call('bnb', 'eth_getBalance', [signer.address, 'pending']), 18);
    if (nativeBalance < this.config().bnb.reserve + maximumFee) throw new Error('BNB 广播前 Gas 保留不足');
    await this.rpc.call('bnb', 'eth_call', [{ from: signer.address, to: request.to, data: request.data, value: '0x0' }, 'latest']);
    if(tag==='swap' && gas.quoteAt && Date.now()-Date.parse(gas.quoteAt)>this.config().risk.quoteTtlSeconds*1000)throw new Error('授权/模拟完成后报价已过期，禁止广播兑换');
    const signed = await signer.signTransaction(request), hash = keccak256(signed);
    await hook({ phase: 'SUBMITTING', hash, chain: 'bnb', tag });
    const returned = await this.rpc.call('bnb', 'eth_sendRawTransaction', [signed]); if (returned.toLowerCase() !== hash.toLowerCase()) throw new Error('RPC 返回哈希不匹配');
    await hook({ phase: 'SUBMITTED', hash, chain: 'bnb', tag }); let receipt;
    try{receipt=await this.wait('bnb',hash);}catch(e){await hook({phase:'CONFIRMATION_FAILED',hash,chain:'bnb',tag,receipt:e.receipt||null,reason:e.constructor===Error?e.message:'确认失败'});throw e;}
    await hook({ phase: 'CONFIRMED', hash, chain: 'bnb', tag, receipt }); return receipt;
  }
  async execute(chain, route, fromToken, toToken, amount, gas, hook, spender) {
    if (chain === 'bnb') {
      const signer = this.vault.unlocked.get(chain); if (!signer) throw new Error('BNB 钱包未解锁');
      const receipts = []; let approvalFee = 0;
      if (!isAddress(spender)) throw new Error('没有可信授权目标');
      const allowance = await this.read(fromToken, 'allowance', [signer.address, spender]);
      if (allowance < BigInt(amount)) {
        // Some ERC20s require allowance to be cleared before changing it.
        for (const value of allowance > 0n ? [0n, BigInt(amount)] : [BigInt(amount)]) {
          const data = abi.encodeFunctionData('approve', [spender, value]);
          const needed = BigInt(await this.rpc.call(chain, 'eth_estimateGas', [{ from: signer.address, to: fromToken, data }]));
          const r = await this.sendEvm({ to: fromToken, data, value: '0' }, { ...gas, usedNative: approvalFee, gasLimit: (needed * 12n / 10n).toString() }, hook, 'approval');
          receipts.push(r); approvalFee += display((BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice)).toString(), 18);
        }
      }
      const receipt = await this.sendEvm(route.tx, { ...gas, usedNative: approvalFee }, hook);
      const r = this.reconcile(chain, receipt, fromToken, toToken, signer.address); r.approvalReceipts = receipts; r.feeNative += approvalFee; return r;
    }
    const signer = this.vault.unlocked.get(chain); if (!signer) throw new Error('Solana 钱包未解锁');
    const tx = this.decodeSol(route.tx.data); let hash;
    if (tx instanceof VersionedTransaction) {
      if (tx.message.staticAccountKeys[0].toBase58() !== signer.publicKey.toBase58() || tx.message.header.numRequiredSignatures !== 1) throw new Error('Solana 路由费支付者或签名者不匹配');
      tx.sign([signer]); hash = bs58.encode(tx.signatures[0]);
    } else {
      if (tx.feePayer?.toBase58() !== signer.publicKey.toBase58() || tx.signatures.length > 1) throw new Error('Solana 路由签名者不匹配'); tx.sign(signer); hash = bs58.encode(tx.signature);
    }
    const raw = Buffer.from(tx.serialize()).toString('base64');
    const msg = tx instanceof VersionedTransaction ? tx.message : tx.compileMessage();
    const fee = await this.rpc.call(chain, 'getFeeForMessage', [Buffer.from(msg.serialize()).toString('base64'), {commitment:'confirmed'}]);
    if (!Number.isFinite(fee.value) || fee.value / 1e9 > this.config().risk.maxSolFee) throw new Error('Solana 广播前网络费超限或 blockhash 过期');
    const sim = await this.rpc.call(chain, 'simulateTransaction', [raw, { encoding: 'base64', sigVerify: true, commitment: 'confirmed', accounts:{encoding:'base64', addresses:[signer.publicKey.toBase58()]} }]); if (sim.value.err) throw new Error('Solana 交易模拟失败');
    if (!Number.isFinite(sim.value.accounts?.[0]?.lamports) || sim.value.accounts[0].lamports / 1e9 < this.config().sol.reserve) throw new Error('Solana 模拟后 Gas 保留不足（含租金）');
    if(gas.quoteAt && Date.now()-Date.parse(gas.quoteAt)>this.config().risk.quoteTtlSeconds*1000)throw new Error('Solana 模拟完成后报价已过期，禁止广播');
    await hook({ phase: 'SUBMITTING', hash, chain, tag: 'swap' });
    const returned = await this.rpc.call(chain, 'sendTransaction', [raw, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 2 }]); if (returned !== hash) throw new Error('Solana 签名返回值不匹配');
    await hook({ phase: 'SUBMITTED', hash, chain, tag: 'swap' }); let receipt;
    try{receipt=await this.wait(chain,hash);}catch(e){await hook({phase:'CONFIRMATION_FAILED',hash,chain,tag:'swap',receipt:e.receipt||null,reason:e.constructor===Error?e.message:'确认失败'});throw e;}
    await hook({ phase: 'CONFIRMED', hash, chain, tag: 'swap', receipt }); return this.reconcile(chain, receipt, fromToken, toToken, signer.publicKey.toBase58());
  }
}

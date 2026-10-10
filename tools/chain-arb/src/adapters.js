import { randomUUID } from 'node:crypto';
import { units, display, translate } from './chains.js';
import { market } from './network.js';
import { sleep, sameAddress } from './config.js';
import { pancakeQuote } from './pancake.js';

const other = c => c === 'bnb' ? 'sol' : 'bnb';
export class PaperAdapter {
  constructor(store, config) { this.store = store; this.config = config; this.reset(false); }
  reset(force = true) {
    if (!force && this.store.get('paper:balances')) return;
    const c = this.config().paper;
    this.store.set('paper:balances', { bnb: { cash: c.bnbCash, tokens: c.bnbTokens, native: 1 }, sol: { cash: c.solCash, tokens: c.solTokens, native: 1 } });
    if (force) this.store.set('limits:paper', { executions: 0, total: 0 });
  }
  async refresh() {
    const p = this.config().paper, balances = this.store.get('paper:balances'), now = new Date().toISOString();
    return Object.fromEntries(['bnb','sol'].map(c => [c, { price: p[`${c}Price`], liquidity: p[`${c}Liquidity`], nativePrice: c === 'bnb' ? 600 : 150, stablePrice:1, source: '模拟行情 · 非实时', connected: true, at: now, rpc: { connected: true, endpoint: '模拟网络', index: 1 }, balance: { ...balances[c], cashUsd:balances[c].cash, stableDecimals: c === 'bnb' ? 18 : 6, tokenDecimals: 9, tokenRaw: units(balances[c].tokens, 9), at: now } }]));
  }
  async quote(chain, side, amountRaw, snapshot) {
    const m = snapshot[chain], inputDecimals = side === 'buy' ? m.balance.stableDecimals : 9, outputDecimals = side === 'buy' ? 9 : m.balance.stableDecimals;
    const input = display(amountRaw, inputDecimals), notional = side === 'buy' ? input : input * m.price;
    const impact = m.liquidity ? notional / m.liquidity * 200 : 100;
    const out = (side === 'buy' ? input / m.price : input * m.price) * (1 - 0.003 - impact / 100);
    const fee = chain === 'bnb' ? 0.000025 : 0.00005;
    return { chain, side, amountRaw, outRaw: units(Math.max(0, out), outputDecimals), inDecimals: inputDecimals, outDecimals: outputDecimals, impact, gas: { native: fee, fee, rent: 0, usd: fee * m.nativePrice }, at: new Date().toISOString(), route: { simulated: true, venue: '模拟 AMM', price: m.price } };
  }
  async execute(quote, hook) {
    const hash = `paper-${randomUUID()}`; await hook({ phase: 'SUBMITTING', chain: quote.chain, hash, tag: 'swap' });
    await hook({ phase: 'SUBMITTED', chain: quote.chain, hash, tag: 'swap' }); await sleep(650);
    const outputRaw = (BigInt(quote.outRaw) * 999n / 1000n).toString();
    const b = this.store.get('paper:balances'), input = display(quote.amountRaw, quote.inDecimals), output = display(outputRaw, quote.outDecimals), wallet = b[quote.chain];
    if (quote.side === 'buy') { if (wallet.cash + 1e-9 < input) throw new Error('模拟稳定币不足'); wallet.cash -= input; wallet.tokens += output; }
    else { if (wallet.tokens + 1e-9 < input) throw new Error('模拟代币库存不足'); wallet.tokens -= input; wallet.cash += output; }
    wallet.native -= quote.gas.native; this.store.set('paper:balances', b);
    const receipt = { simulated: true, hash, status: 'confirmed', inputRaw: quote.amountRaw, outputRaw, feeNative: quote.gas.fee, rentNative: 0 };
    await hook({ phase: 'CONFIRMED', chain: quote.chain, hash, tag: 'swap', receipt }); return { ...receipt, receipt };
  }
  async bridgeQuote(from, amount, snapshot) {
    const to = other(from), fee = snapshot[from].nativePrice * (from === 'bnb' ? 0.000025 : 0.00005), output = amount * 0.998 - 0.15;
    if (output <= 0) throw new Error('跨链金额不足以支付模拟费用');
    return { from, to, amount, output, fromUsd: amount, toUsd: output, wear: amount - output + fee, wearPct: (amount - output + fee) / amount * 100, sourceGas: { native: from === 'bnb' ? 0.000025 : 0.00005, fee: from === 'bnb' ? 0.000025 : 0.00005, rent: 0, usd: fee }, destinationFeeUsd: 0, impact: 0.2, at: new Date().toISOString(), route: { simulated: true, bridgeId: 'paper', note: '模拟跨链；不请求 OKX、不签名' } };
  }
  async bridgeExecute(q, hook) {
    const hash = `paper-bridge-${randomUUID()}`; await hook({ phase: 'SUBMITTING', hash, chain: q.from, tag: 'bridge' });
    await hook({ phase: 'SUBMITTED', hash, chain: q.from, tag: 'bridge' }); await sleep(650);
    const b = this.store.get('paper:balances'); if (b[q.from].cash < q.amount) throw new Error('模拟源链资金不足');
    b[q.from].cash -= q.amount; b[q.from].native -= q.sourceGas.native; this.store.set('paper:balances', b);
    await hook({ phase: 'CONFIRMED', hash, chain: q.from, tag: 'bridge', receipt: { simulated: true, sourceConfirmed: true } });
    await sleep(650); b[q.to].cash += q.output; this.store.set('paper:balances', b);
    const receipt = { simulated: true, hash: `${hash}-dest`, destinationConfirmed: true, output: q.output };
    await hook({ phase: 'DESTINATION_CONFIRMED', hash: receipt.hash, chain: q.to, tag: 'bridge', receipt });
    return { output: q.output, wear: q.wear, wearPct: q.wearPct, sourceFeeUsd: q.sourceGas.usd, destinationFeeUsd: 0, rentUsd: 0, sourceHash: hash, destinationHash: receipt.hash, receipt };
  }
}
export class LiveAdapter {
  constructor(chains, rpc, okx, vault, config) { Object.assign(this, { chains, rpc, okx, vault, config }); }
  async refresh() {
    const config = this.config(), output = {};
    await Promise.all(['bnb','sol'].map(async chain => {
      const [m, balance] = await Promise.allSettled([market(chain, config), this.chains.balances(chain)]);
      output[chain] = { ...(m.status === 'fulfilled' ? m.value : { connected: false, error: m.reason.constructor === Error ? m.reason.message : '行情连接失败' }), balance: balance.status === 'fulfilled' ? balance.value : null, balanceError: balance.status === 'rejected' ? (balance.reason.constructor === Error ? balance.reason.message : '余额连接失败') : null, rpc: this.rpc.status[chain] || { connected: false } };
      if(output[chain].balance && output[chain].stablePrice) output[chain].balance.cashUsd=output[chain].balance.cash*output[chain].stablePrice;
    })); return output;
  }
  async quote(chain, side, amountRaw, snapshot) {
    const config = this.config(), c = config[chain], from = side === 'buy' ? c.stable : c.token, to = side === 'buy' ? c.token : c.stable;
    if (chain === 'bnb' && c.execution === 'pancake-v2') return pancakeQuote(this,chain,side,amountRaw,snapshot);
    const wallet = this.vault.publicWallet(chain).address; if (!wallet) throw new Error('请导入两侧钱包以获取可执行路由');
    const route = await this.okx.swap(chain, from, to, amountRaw, wallet, config), q = route.routerResult;
    if (c.strictPool) {
      if (chain === 'sol') await this.chains.verifySolPool(route.tx?.data,c.pool);
      else {
        const poolFound=JSON.stringify(q || {}).toLowerCase().includes(c.pool.toLowerCase());
        if (!poolFound) throw new Error('OKX BNB 聚合路由无法核验指定池；使用 Pancake V2 直接池，或显式关闭严格池模式');
      }
    }
    if (!q || !q.toTokenAmount || q.fromTokenAmount !== String(amountRaw)) throw new Error('OKX 报价金额不匹配');
    if (!sameAddress(chain, q.fromToken?.tokenContractAddress, from) || !sameAddress(chain, q.toToken?.tokenContractAddress, to)) throw new Error('OKX 报价代币身份不匹配');
    const inDecimals = await this.chains.decimals(chain, from), outDecimals = await this.chains.decimals(chain, to);
    if (Number(q.fromToken.decimal) !== inDecimals || Number(q.toToken.decimal) !== outDecimals) throw new Error('OKX 精度与链上 Mint/合约不匹配');
    const impact = Math.abs(Number(q.priceImpactPercent)); if (!Number.isFinite(impact)) throw new Error('OKX 报价没有价格冲击');
    const gas = await this.chains.gas(chain, route.tx, snapshot[chain]);
    const spender = chain === 'bnb' ? (await this.okx.approve(from, amountRaw)).dexContractAddress : null;
    return { chain, side, amountRaw, outRaw: String(q.toTokenAmount), inDecimals, outDecimals, impact, gas, route, spender, at: new Date().toISOString(), fromToken: from, toToken: to };
  }
  async execute(q, hook) {
    const config = this.config();
    const balance = await this.chains.balances(q.chain);
    if (balance.native < config[q.chain].reserve + q.gas.native) throw new Error('执行前余额检查：Gas 保留不足');
    return this.chains.execute(q.chain, q.route, q.fromToken, q.toToken, q.amountRaw, {...q.gas,quoteAt:q.at}, hook, q.spender);
  }
  async bridgeQuote(from, amount, snapshot) {
    const config = this.config(), to = other(from), b = snapshot[from].balance;
    const params = this.okx.bridgeParams(from, units(amount, b.stableDecimals), config, this.vault.publicWallet(from).address, this.vault.publicWallet(to).address);
    const quote = await this.okx.bridgeQuote(params), built = await this.okx.bridgeBuild(params, quote);
    const route = built.tx ? built : built.routerResult?.tx ? { ...built, tx: built.routerResult.tx } : built;
    const outputRaw = quote.toTokenAmount || built.toTokenAmount;
    if (!outputRaw || !/^\d+$/.test(outputRaw)) throw new Error('OKX 跨链返回结构没有可验证的目标到账数量');
    const fromPrice = Number(quote.fromToken?.tokenUnitPrice), toPrice = Number(quote.toToken?.tokenUnitPrice);
    if (!(fromPrice > 0) || !(toPrice > 0)) throw new Error('跨链报价缺少稳定币美元价格，无法计算磨损');
    const output = display(outputRaw, snapshot[to].balance.stableDecimals), sourceGas = await this.chains.gas(from, route.tx, snapshot[from]);
    // Budget destination fees conservatively; receipts later attribute only wallet-paid costs.
    const destinationFeeUsd = snapshot[to].nativePrice * (to === 'bnb' ? config.risk.maxBnbGas : config.risk.maxSolFee);
    const fromUsd = amount * fromPrice, toUsd = output * toPrice, wear = Math.max(0, fromUsd - toUsd + sourceGas.usd + destinationFeeUsd);
    const spender = from === 'bnb' ? (await this.okx.approve(config[from].stable, params.amount)).dexContractAddress : null;
    const impact = Math.abs(Number(quote.priceImpactPercentage ?? quote.priceImpactPercent));
    if (!Number.isFinite(impact)) throw new Error('跨链报价缺少价格冲击数据');
    return { from, to, amount, output, outputRaw, fromUsd, toUsd, fromPrice, toPrice, wear, wearPct: wear / fromUsd * 100, sourceGas, destinationFeeUsd, impact, params, route, spender, at: new Date().toISOString() };
  }
  async bridgeExecute(q, hook) {
    const config = this.config(), sourceAddr = this.vault.publicWallet(q.from).address, destinationAddr = this.vault.publicWallet(q.to).address;
    const balance=await this.chains.balances(q.from);
    if (balance.cash < q.amount || balance.native < config[q.from].reserve+q.sourceGas.native) throw new Error('跨链广播前余额或 Gas 保留不足');
    const source = await this.chains.execute(q.from, q.route, config[q.from].stable, config[q.to].stable, q.params.amount, {...q.sourceGas,quoteAt:q.at}, hook, q.spender);
    // Source receipt cannot prove destination credit. Track the bridge and independently verify destination receipt.
    const sourceHash = source.receipt.transactionHash || source.receipt.transaction?.signatures?.[0];
    if (!sourceHash) throw new Error('跨链源回执缺少哈希，须人工核对');
    let destinationHash = null;
    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
      const status = await this.okx.bridgeStatus(sourceHash, q.from);
      await hook({ phase: 'BRIDGE_TRACKING', chain: q.from, hash: sourceHash, tag: 'bridge', bridgeStatus: status });
      destinationHash = status.toTxHash || status.toChainTxHash || status.destinationTxHash;
      if (destinationHash) break; await sleep(10000);
    }
    if (!destinationHash) throw new Error('跨链目标确认超时，请核对 OKX 桥状态，禁止自动重发');
    const receipt = await this.chains.wait(q.to, destinationHash);
    const actual = this.chains.reconcile(q.to, receipt, config[q.to].stable, config[q.to].stable, destinationAddr);
    if (BigInt(actual.outputRaw) <= 0n) throw new Error('目标回执没有钱包稳定币到账记录');
    const output = display(actual.outputRaw, await this.chains.decimals(q.to, config[q.to].stable));
    const input = display(source.inputRaw, await this.chains.decimals(q.from, config[q.from].stable));
    if (!(input > 0)) throw new Error('源回执无法复核实际稳定币扣款');
    const sourceFeeUsd = source.feeNative * q.sourceGas.usd / q.sourceGas.native, destinationFeeUsd = actual.feeNative * (this.lastSnapshot?.[q.to]?.nativePrice || q.destinationFeeUsd / (q.to === 'bnb' ? config.risk.maxBnbGas : config.risk.maxSolFee));
    const rentUsd = source.rentNative * q.sourceGas.usd / q.sourceGas.native + actual.rentNative * (q.to === 'bnb' ? q.destinationFeeUsd / config.risk.maxBnbGas : q.destinationFeeUsd / config.risk.maxSolFee);
    const wear = input * q.fromPrice - output * q.toPrice + sourceFeeUsd + destinationFeeUsd + rentUsd;
    await hook({ phase: 'DESTINATION_CONFIRMED', chain: q.to, hash: destinationHash, tag: 'bridge', receipt });
    return { output, input, wear, wearPct: wear / (input * q.fromPrice) * 100, sourceFeeUsd, destinationFeeUsd, rentUsd, sourceHash, destinationHash, source, receipt };
  }
}

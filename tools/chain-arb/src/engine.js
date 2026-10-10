import { randomUUID } from 'node:crypto';
import { safeError } from './config.js';
import { units, display, translate } from './chains.js';

const other = c => c === 'bnb' ? 'sol' : 'bnb';
const floorSlippage = (raw, pct) => (BigInt(raw) * BigInt(Math.floor((100 - pct) * 10000)) / 1000000n).toString();
export class Engine {
  constructor(store, vault, adapters) { Object.assign(this, { store, vault, adapters }); this.snapshot = {}; this.opportunity = { reasons: ['正在读取行情'] }; this.busy = false; this.polling = false; this.active = null; this.timer = null; this.generation=0; }
  invalidate() { this.generation++; this.lastPoll=0; this.opportunity={reasons:['配置或凭据已更新，等待重新检查']}; }
  config() { return this.store.get('config'); }
  adapter() { return this.adapters[this.config().mode]; }
  start() { this.timer = setInterval(() => this.tick().catch(() => {}), 1000); this.tick().catch(() => {}); }
  stop() { clearInterval(this.timer); }
  async tick(force = false) {
    const config = this.config(); if (this.polling || this.busy || (!force && Date.now() - (this.lastPoll || 0) < config.pollSeconds * 1000)) return;
    this.polling = true; const generation=this.generation;
    try {
      const snapshot=await this.adapter().refresh(); if(generation!==this.generation)return;
      this.snapshot=snapshot; const opportunity=await this.evaluate(this.snapshot); if(generation!==this.generation)return;
      this.opportunity=opportunity; this.lastPoll = Date.now();
    } catch (e) { this.opportunity = { reasons: [safeError(e)], at: new Date().toISOString() }; this.lastPoll = Date.now(); }
    finally { this.polling = false; }
    const automation = this.store.get('automation');
    if (!this.store.get('pause') && !this.busy) {
      if (automation.rebalance) {
        this.polling=true; let plan;try{plan=await this.rebalancePlan();}finally{this.polling=false;}
        if(generation!==this.generation)return;
        if (plan.eligible && this.store.get('automation').rebalance && !this.store.get('pause')) { this.runBridge(plan.from, plan.amount, true).catch(() => {}); return; }
      }
      if (this.store.get('automation').arbitrage && !this.store.get('pause') && !this.opportunity.reasons?.length) this.runArbitrage().catch(() => {});
    }
  }
  walletReasons() {
    if (this.config().mode === 'paper') return [];
    return ['bnb','sol'].flatMap(c => { const w = this.vault.publicWallet(c); return w.type !== 'private' || !w.unlocked ? [`${c.toUpperCase()} 钱包未解锁或为只读钱包`] : []; });
  }
  gasReasons(chain, gas, balance) {
    const c = this.config(), reasons = [];
    if (!gas || !Number.isFinite(gas.native) || !Number.isFinite(gas.usd)) return ['Gas 报价缺失'];
    if ((chain === 'bnb' ? gas.native : gas.fee) > (chain === 'bnb' ? c.risk.maxBnbGas : c.risk.maxSolFee)) reasons.push(`${chain.toUpperCase()} 网络费超过上限`);
    if (!balance || balance.native < c[chain].reserve + gas.native) reasons.push(`${chain.toUpperCase()} Gas 保留资金不足`);
    return reasons;
  }
  async evaluate(snapshot) {
    const c = this.config(), r = c.risk, reasons = [], limits = this.store.limits(c.mode);
    if (this.store.get('pause')) reasons.push(`已暂停：${this.store.get('pause').reason}`);
    reasons.push(...this.walletReasons());
    if (c.mode === 'live' && !c.assetConfirmed) reasons.push('请确认两链地址代表同一经济资产');
    if (limits.executions >= r.maxExecutions) reasons.push('已达到执行次数上限'); if (limits.total + r.amount > r.maxTotal + 1e-9) reasons.push('将超过累计套利金额上限');
    for (const chain of ['bnb','sol']) {
      const m = snapshot[chain];
      if (!m?.connected || !m?.price || !m?.liquidity) reasons.push(`${chain.toUpperCase()} 行情不可用：${m?.error || '尚未连接'}`);
      if (m?.at && Date.now() - Date.parse(m.at) > r.quoteTtlSeconds * 1000) reasons.push(`${chain.toUpperCase()} 行情过期`);
      if (!m?.balance || !m?.rpc?.connected) reasons.push(`${chain.toUpperCase()} RPC/钱包余额不可用：${m?.balanceError || '未连接'}`);
    }
    if (!snapshot.bnb?.price || !snapshot.sol?.price || !snapshot.bnb?.balance || !snapshot.sol?.balance) return { reasons, at: new Date().toISOString() };
    const buy = snapshot.bnb.price <= snapshot.sol.price ? 'bnb' : 'sol', sell = other(buy), diff = snapshot[sell].price - snapshot[buy].price;
    const base = { buy, sell, amount: r.amount, diff, spreadPct: diff / snapshot[buy].price * 100, reasons, at: new Date().toISOString() };
    try {
      const adapter = this.adapter();
      const buyQuote = await adapter.quote(buy, 'buy', units(r.amount / snapshot[buy].stablePrice, snapshot[buy].balance.stableDecimals), snapshot);
      buyQuote.stablePrice=snapshot[buy].stablePrice;
      const conservativeBuyRaw = floorSlippage(buyQuote.outRaw, r.maxSlippagePct);
      const sellRaw = translate(conservativeBuyRaw, buyQuote.outDecimals, snapshot[sell].balance.tokenDecimals);
      if (BigInt(sellRaw) <= 0n) throw new Error('到账数量低于高价链最小精度');
      const sellQuote = await adapter.quote(sell, 'sell', sellRaw, snapshot);
      sellQuote.stablePrice=snapshot[sell].stablePrice;
      const expectedOutput = display(floorSlippage(sellQuote.outRaw, r.maxSlippagePct), sellQuote.outDecimals)*snapshot[sell].stablePrice;
      const gasUsd = buyQuote.gas.usd + sellQuote.gas.usd, profit = expectedOutput - r.amount - gasUsd;
      if (profit < r.minProfit) reasons.push('预计净收益低于利润门槛');
      if (snapshot[buy].balance.cashUsd < r.amount) reasons.push('低价链稳定币不足');
      const requiredStock = translate(buyQuote.outRaw, buyQuote.outDecimals, snapshot[sell].balance.tokenDecimals);
      if (BigInt(snapshot[sell].balance.tokenRaw) < BigInt(requiredStock)) reasons.push('高价链同币库存不足（跨链代币不会即时转移）');
      if (Math.max(buyQuote.impact, sellQuote.impact) > r.maxImpactPct) reasons.push('价格冲击超过上限');
      reasons.push(...this.gasReasons(buy, buyQuote.gas, snapshot[buy].balance), ...this.gasReasons(sell, sellQuote.gas, snapshot[sell].balance));
      return { ...base, buyQuote, sellQuote, quantity: display(sellRaw, sellQuote.inDecimals), expectedOutput, gasUsd, profit, slippagePct: r.maxSlippagePct, impactPct: Math.max(buyQuote.impact, sellQuote.impact), reasons };
    } catch (e) { return { ...base, reasons: [...reasons, safeError(e)] }; }
  }
  hook(id, leg) {
    return async detail => {
      if((leg==='BUY'||leg==='BRIDGE') && detail.phase==='SUBMITTING' && this.store.get('pause')) throw new Error('广播前收到暂停指令，取消未广播操作');
      this.store.transition(id, `${leg}_${detail.tag?.toUpperCase() || 'TX'}_${detail.phase}`, detail);
    };
  }
  fresh(q) { if (Date.now() - Date.parse(q.at) > this.config().risk.quoteTtlSeconds * 1000) throw new Error('报价已过期，禁止广播'); }
  pause(reason, job) { this.store.set('pause', { reason, job, at: new Date().toISOString() }); this.store.set('automation', { arbitrage: false, rebalance: false }); }
  async runArbitrage(id = randomUUID()) {
    if (this.busy || this.polling) throw new Error('已有交易或行情检查进行中'); this.busy = true;
    let job;
    try {
      const mode = this.config().mode, adapter = this.adapter(); this.snapshot = await adapter.refresh();
      const opportunity = await this.evaluate(this.snapshot); this.opportunity = opportunity;
      if (opportunity.reasons.length) throw new Error(opportunity.reasons.join('；'));
      const { buy, sell, buyQuote, amount } = opportunity;
      if(this.store.get('pause'))throw new Error('已收到暂停指令，禁止新买入');
      this.fresh(buyQuote);
      job = this.store.create('arbitrage', { mode, estimate: opportunity, config: this.config(), buy, sell, amount }, id); this.active = job.id;
      this.store.reserve(mode, amount); this.store.transition(id, 'BUY_PREPARING', { message: '先买入；确认及实际到账复核完成前禁止卖出' });
      const buyResult = await adapter.execute(buyQuote, this.hook(id, 'BUY'));
      if (BigInt(buyResult.outputRaw) <= 0n) throw new Error('买入回执没有实际到账，禁止卖出');
      // This checkpoint occurs only after the adapter independently confirms on-chain success.
      this.store.transition(id, 'BUY_CONFIRMED', { actualReceivedRaw: buyResult.outputRaw, message: '链上确认且到账已复核，可以重新报价卖出' }, { buyResult });
      if(BigInt(buyResult.outputRaw)<BigInt(floorSlippage(buyQuote.outRaw,this.config().risk.maxSlippagePct))) throw new Error('买入实际到账滑点超限，暂停核对单边仓位');
      if(buyResult.feeNative>(buy==='bnb'?this.config().risk.maxBnbGas:this.config().risk.maxSolFee)) throw new Error('买入实际网络费超限，暂停核对');
      this.snapshot = await adapter.refresh();
      const qty = translate(buyResult.outputRaw, buyQuote.outDecimals, this.snapshot[sell].balance.tokenDecimals);
      const sellQuote = await adapter.quote(sell, 'sell', qty, this.snapshot); this.fresh(sellQuote);
      const reasons = this.gasReasons(sell, sellQuote.gas, this.snapshot[sell].balance);
      if (BigInt(this.snapshot[sell].balance.tokenRaw) < BigInt(qty)) reasons.push('确认后发现高价链实际同币库存不足');
      if (sellQuote.impact > this.config().risk.maxImpactPct) reasons.push('确认后卖出价格冲击超过上限');
      const buyFee = (buyResult.feeNative + buyResult.rentNative) * this.snapshot[buy].nativePrice;
      const actualInput = display(buyResult.inputRaw, buyQuote.inDecimals)*buyQuote.stablePrice;
      if (!(actualInput > 0) || actualInput > amount + 1e-8) reasons.push('实际买入扣款与限额不一致');
      const conservativeProfit = display(floorSlippage(sellQuote.outRaw, this.config().risk.maxSlippagePct), sellQuote.outDecimals)*this.snapshot[sell].stablePrice - actualInput - buyFee - sellQuote.gas.usd;
      if (conservativeProfit < this.config().risk.minProfit) reasons.push('买入确认后重新报价低于利润门槛，需人工处理单边仓位');
      if (reasons.length) throw new Error(reasons.join('；'));
      this.store.transition(id, 'SELL_PREPARING', { sellRaw: qty, dustRaw: (BigInt(buyResult.outputRaw) - BigInt(translate(qty, sellQuote.inDecimals, buyQuote.outDecimals))).toString() }, { sellQuote });
      const sellResult = await adapter.execute(sellQuote, this.hook(id, 'SELL'));
      if (BigInt(sellResult.outputRaw) <= 0n || BigInt(sellResult.inputRaw) !== BigInt(qty)) throw new Error('卖出到账或实际卖出数量复核不一致');
      const output = display(sellResult.outputRaw, sellQuote.outDecimals)*this.snapshot[sell].stablePrice, sellFee = (sellResult.feeNative + sellResult.rentNative) * this.snapshot[sell].nativePrice;
      const result = { input: actualInput, output, receivedTokens: display(buyResult.outputRaw, buyQuote.outDecimals), soldTokens: display(qty, sellQuote.inDecimals), gasUsd: buyResult.feeNative * this.snapshot[buy].nativePrice + sellResult.feeNative * this.snapshot[sell].nativePrice, rentUsd: buyResult.rentNative * this.snapshot[buy].nativePrice + sellResult.rentNative * this.snapshot[sell].nativePrice, profit: output - actualInput - buyFee - sellFee, estimateProfit: opportunity.profit, buySlippagePct: (1 - display(buyResult.outputRaw, buyQuote.outDecimals) / display(buyQuote.outRaw, buyQuote.outDecimals)) * 100, sellSlippagePct: (1 - display(sellResult.outputRaw,sellQuote.outDecimals) / display(sellQuote.outRaw, sellQuote.outDecimals)) * 100, stableRates:{buy:buyQuote.stablePrice,sell:this.snapshot[sell].stablePrice}, nativeRates:{buy:this.snapshot[buy].nativePrice,sell:this.snapshot[sell].nativePrice} };
      result.difference = result.profit - result.estimateProfit;
      this.store.transition(id, 'COMPLETED', { message: '双链回执和实际数量已结算', result }, { sellResult, result });
      if (result.profit < 0 || Math.max(result.buySlippagePct, result.sellSlippagePct) > this.config().risk.maxSlippagePct || buyResult.feeNative > (buy === 'bnb' ? this.config().risk.maxBnbGas : this.config().risk.maxSolFee) || sellResult.feeNative > (sell === 'bnb' ? this.config().risk.maxBnbGas : this.config().risk.maxSolFee)) this.pause('实际结算超出风控限制，请核对档案', id);
      return this.store.job(id);
    } catch (e) {
      if (job) { this.store.transition(job.id, 'RECOVERY_REQUIRED', { reason: safeError(e), message: '停止自动执行；核对两侧余额及交易哈希，禁止自动重试' }, { failure: safeError(e) }); this.pause(safeError(e), job.id); }
      throw new Error(safeError(e));
    } finally { this.busy = false; this.active = null; this.lastPoll = 0; }
  }
  async bridgePreview(from, amount) {
    if (!['bnb','sol'].includes(from) || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > Number.MAX_SAFE_INTEGER) throw new Error('跨链金额必须为可精确表示的正数');
    const snapshot = await this.adapter().refresh();
    for(const chain of ['bnb','sol'])if(!snapshot[chain]?.balance || !(snapshot[chain].nativePrice>0))throw new Error(`${chain.toUpperCase()} 钱包余额或 Gas 美元价格不可用`);
    const q = await this.adapter().bridgeQuote(from, amount, snapshot), c = this.config(), reasons = this.walletReasons();
    if (this.store.get('pause')) reasons.push('任务已暂停，请先核对并解除暂停');
    if (!snapshot[from]?.balance || snapshot[from].balance.cash < amount) reasons.push('源链稳定币余额不足');
    reasons.push(...this.gasReasons(from, q.sourceGas, snapshot[from].balance));
    if (snapshot[q.to]?.balance?.native < c[q.to].reserve) reasons.push('目标链 Gas 保留不足');
    if (q.wear > c.bridge.maxWearUsd) reasons.push('跨链美元磨损超过上限');
    if (q.wearPct > c.bridge.maxWearPct) reasons.push('跨链磨损率超过上限');
    if (q.impact > c.risk.maxImpactPct) reasons.push('跨链价格冲击超过上限');
    return { ...q, reasons, snapshot };
  }
  async rebalancePlan(refresh = false) {
    if (this.busy) return {eligible:false, reason:'有资金操作正在结算，请等待完成'};
    if (refresh) this.snapshot = await this.adapter().refresh();
    const c = this.config(), b = this.snapshot.bnb?.balance, s = this.snapshot.sol?.balance;
    if (!b || !s) return { eligible: false, reason: '钱包余额不可用' };
    const bUsd=b.cashUsd??b.cash*this.snapshot.bnb.stablePrice, sUsd=s.cashUsd??s.cash*this.snapshot.sol.stablePrice;
    const low = bUsd < 5 ? 'bnb' : sUsd < 5 ? 'sol' : null;
    if (!low) return { eligible: false, reason: '两侧可用稳定币均不低于 5U' };
    if (bUsd < 5 && sUsd < 5) return { eligible: false, reason: '两侧均不足 5U，无法内部再平衡' };
    const total = bUsd + sUsd;
    if (total * 0.4 < 5) return { eligible: false, reason: '总资金无法保证再平衡后两侧至少 5U' };
    const last = this.store.get(`rebalance:${c.mode}`);
    if (last && Date.now() - last.at < c.bridge.cooldownMinutes * 60000) return { eligible: false, reason: '再平衡处于冷却期，避免反复跨链' };
    const from = other(low), lowUsd=low==='bnb'?bUsd:sUsd, highUsd=from==='bnb'?bUsd:sUsd;
    let amount = (total * 0.6 - lowUsd)/this.snapshot[from].stablePrice;
    // Solve the 60/40 target using net destination arrival rather than nominal transfer size.
    try {
      let q;
      for (let i = 0; i < 3; i++) { q = await this.bridgePreview(from, amount); const tokenLoss = q.fromUsd-q.toUsd; amount = (0.6 * total - lowUsd + 0.4 * tokenLoss)/(q.fromPrice||this.snapshot[from].stablePrice); }
      q = await this.bridgePreview(from, amount);
      if (q.reasons.length) return { eligible: false, reason: q.reasons.join('；'), from, amount };
      const lowAfter = lowUsd + q.toUsd, highAfter = highUsd - q.fromUsd;
      if (Math.min(lowAfter, highAfter) < 5 || Math.abs(lowAfter / (lowAfter + highAfter) - 0.6) > 0.01) return { eligible: false, reason: '净到账无法满足 60/40 或保留 5U' };
      return { eligible: true, from, to: low, amount, lowAfter, highAfter, reason: '不足侧补至 60%，另一侧保留 40%' };
    } catch(e) { return { eligible: false, reason: safeError(e) }; }
  }
  async runBridge(from, amount, rebalance = false, id = randomUUID()) {
    if (this.busy || this.polling) throw new Error('已有交易或行情检查进行中'); this.busy = true; let job;
    try {
      const q = await this.bridgePreview(from, amount); if (q.reasons.length) throw new Error(q.reasons.join('；')); this.fresh(q);
      if (rebalance) {
        const low = q.snapshot[q.to].balance.cashUsd, high = q.snapshot[from].balance.cashUsd;
        if (low >= 5 || high < 5) throw new Error('再平衡触发条件已改变');
        const a = low + q.toUsd, b = high - q.fromUsd;
        if (Math.min(a,b) < 5 || Math.abs(a / (a+b) - 0.6) > 0.01) throw new Error('净到账比例已变化，取消本次再平衡');
      }
      job = this.store.create('bridge', { mode: this.config().mode, rebalance, from, to: q.to, amount, estimate: q, config: this.config() }, id); this.active = id;
      this.store.transition(id, 'BRIDGE_PREPARING', { message: '单次及每日跨链不设金额上限，仍强制保留 Gas 并限制磨损' });
      const result = await this.adapter().bridgeExecute(q, this.hook(id, 'BRIDGE')); result.difference = result.wear - q.wear;
      this.store.transition(id, 'COMPLETED', { result }, { result });
      if (rebalance) this.store.set(`rebalance:${this.config().mode}`, { at: Date.now(), from, to: q.to, job: id });
      if (result.wear > this.config().bridge.maxWearUsd || result.wearPct > this.config().bridge.maxWearPct) this.pause('实际跨链磨损超限，请核对实际到账', id);
      return this.store.job(id);
    } catch (e) { if (job) { this.store.transition(id, 'RECOVERY_REQUIRED', { reason: safeError(e) }, { failure: safeError(e) }); this.pause(safeError(e), id); } throw new Error(safeError(e)); }
    finally { this.busy = false; this.active = null; this.lastPoll = 0; }
  }
  publicState() {
    const c = this.config(), q = this.opportunity;
    const { buyQuote, sellQuote, ...publicOpportunity } = q;
    return { config: c, mode: c.mode, markets: this.snapshot, opportunity: publicOpportunity, wallets: { bnb: this.vault.publicWallet('bnb'), sol: this.vault.publicWallet('sol') }, okx: this.vault.okxStatus(), automation: this.store.get('automation'), pause: this.store.get('pause'), busy: this.busy, polling: this.polling, active: this.active, limits: this.store.limits(c.mode), at: new Date().toISOString() };
  }
}

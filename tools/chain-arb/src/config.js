import { isAddress } from 'ethers';
import { PublicKey } from '@solana/web3.js';

export const defaults = {
  mode: 'paper', symbol: 'TOKEN', assetConfirmed: false, pollSeconds: 8,
  bnb: { token: '', pool: '', rpc: ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io'], stable: '0x55d398326f99059fF775485246999027B3197955', dexIds: '', reserve: 0.01, confirmations: 3, execution: 'pancake-v2', strictPool: true },
  sol: { token: '', pool: '', rpc: ['https://api.mainnet-beta.solana.com'], stable: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', dexIds: '', reserve: 0.05, strictPool: true },
  risk: { amount: 5, minProfit: 0.03, maxSlippagePct: 0.5, maxImpactPct: 1, maxBnbGas: 0.0005, maxSolFee: 0.003, maxExecutions: 20, maxTotal: 100, quoteTtlSeconds: 20 },
  bridge: { maxWearUsd: 1, maxWearPct: 1, cooldownMinutes: 60 },
  paper: { bnbPrice: 1, solPrice: 1.035, bnbCash: 50, solCash: 50, bnbTokens: 100, solTokens: 100, bnbLiquidity: 120000, solLiquidity: 180000 }
};
export function address(chain, value) {
  if (chain === 'bnb') { if (!isAddress(value)) throw new Error('BNB 地址格式错误'); }
  else { try { new PublicKey(value); } catch { throw new Error('Solana 地址格式错误'); } }
  return value;
}
function number(value, min, max, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} 必须在 ${min}–${max} 之间`);
}
export function validateConfig(c) {
  if (!['paper', 'live'].includes(c.mode)) throw new Error('无效运行模式');
  if (typeof c.symbol !== 'string' || c.symbol.length > 30 || typeof c.assetConfirmed !== 'boolean') throw new Error('代币配置错误');
  number(c.pollSeconds, 3, 300, '轮询秒数');
  for (const chain of ['bnb', 'sol']) {
    const v = c[chain];
    for (const key of ['token', 'pool', 'stable']) { if (typeof v[key] !== 'string') throw new Error('地址配置错误'); if (v[key]) address(chain, v[key]); }
    if (v.token && sameAddress(chain, v.token, v.stable)) throw new Error('套利币与计价币必须不同');
    if (!Array.isArray(v.rpc) || !v.rpc.length || v.rpc.length > 12) throw new Error('每链配置 1–12 个 RPC');
    for (const endpoint of v.rpc) { const u = new URL(endpoint); if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.hash) throw new Error('RPC 必须为无内嵌凭据的 HTTP(S) 地址'); }
    number(v.reserve, 0.000001, 100, `${chain} Gas 保留`);
    if (typeof v.dexIds !== 'string' || !/^[0-9,]*$/.test(v.dexIds)) throw new Error('DEX ID 使用数字及逗号');
    if (typeof v.strictPool !== 'boolean') throw new Error('严格交易池选项无效');
  }
  if (!['pancake-v2','okx'].includes(c.bnb.execution)) throw new Error('不支持的 BNB 成交路由');
  number(c.bnb.confirmations, 1, 100, 'BNB 确认数'); if (!Number.isInteger(c.bnb.confirmations)) throw new Error('确认数必须为整数');
  const r = c.risk;
  number(r.amount, 1, 10, '每次套利 U'); number(r.minProfit, 0, 1000, '利润门槛');
  number(r.maxSlippagePct, 0.01, 10, '滑点百分比'); number(r.maxImpactPct, 0.01, 20, '价格冲击百分比');
  number(r.maxBnbGas, 0.00000001, 10, 'BNB Gas 上限'); number(r.maxSolFee, 0.00000001, 10, 'SOL 费用上限');
  number(r.maxExecutions, 1, 1000000, '执行次数'); if (!Number.isInteger(r.maxExecutions)) throw new Error('执行次数必须为整数');
  number(r.maxTotal, 1, 100000000, '累计套利 U'); number(r.quoteTtlSeconds, 5, 120, '报价有效期');
  number(c.bridge.maxWearUsd, 0, Number.MAX_SAFE_INTEGER, '跨链美元磨损'); number(c.bridge.maxWearPct, 0, 100, '跨链磨损率'); number(c.bridge.cooldownMinutes, 1, 10080, '再平衡冷却分钟');
  for (const [key, val] of Object.entries(c.paper)) number(val, key.includes('Price') ? 0.0000000001 : 0, 1e12, key);
  return c;
}
export function mergeConfig(previous, patch) {
  const result = structuredClone(previous);
  for (const key of Object.keys(defaults)) if (Object.hasOwn(patch, key)) {
    if(typeof defaults[key] !== 'object') {result[key]=patch[key];continue;}
    if(!patch[key] || typeof patch[key]!=='object' || Array.isArray(patch[key]) || Object.keys(patch[key]).some(k=>!Object.hasOwn(defaults[key],k)))throw new Error('包含未知或无效设置字段');
    result[key]={...previous[key],...patch[key]};
  }
  return validateConfig(result);
}
export const chainId = c => c === 'bnb' ? '56' : '501';
export const sameAddress = (chain, a, b) => typeof a === 'string' && typeof b === 'string' && (chain === 'bnb' ? a.toLowerCase() === b.toLowerCase() : a === b);
export const json = v => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function safeError(e) {
  // SDK errors may contain signed payloads, requests or credentials. Persist only our own errors and codes.
  if (e?.constructor === Error) return String(e.message).slice(0, 400);
  return `外部服务失败 (${String(e?.code || e?.name || 'unknown').slice(0, 60)})`;
}

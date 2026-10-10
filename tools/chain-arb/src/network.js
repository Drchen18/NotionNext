import { createHmac } from 'node:crypto';
import { chainId, sleep, sameAddress } from './config.js';

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`外部服务 HTTP ${response.status}`);
  return response.json();
}
export class RpcPool {
  constructor(config) { this.config = config; this.cursor = { bnb: 0, sol: 0 }; this.status = {}; this.networks = new Set(); }
  async call(chain, method, params = []) {
    const endpoints = this.config()[chain].rpc;
    for (let attempt = 0; attempt < endpoints.length; attempt++) {
      const index = this.cursor[chain] % endpoints.length, endpoint = endpoints[index];
      try {
        const send = async (m, p) => { const r = await fetchJson(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); if (r.error) throw new Error(`RPC ${m} 失败，代码 ${r.error.code}`); return r.result; };
        const identity = `${chain}:${endpoint}`;
        if (!this.networks.has(identity)) {
          const network = await send(chain === 'bnb' ? 'eth_chainId' : 'getGenesisHash', []);
          if (network !== (chain === 'bnb' ? '0x38' : '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')) throw new Error('RPC 网络错误：仅支持 BNB/Solana 主网');
          this.networks.add(identity);
        }
        const result = await send(method, params);
        this.status[chain] = { connected: true, endpoint: new URL(endpoint).host, index: index + 1, at: new Date().toISOString() }; this.cursor[chain] = (index + 1) % endpoints.length; return result;
      } catch (e) { this.status[chain] = { connected: false, endpoint: new URL(endpoint).host, index: index + 1, at: new Date().toISOString(), error: e.constructor === Error ? e.message : 'RPC 网络不可用' }; this.cursor[chain] = (index + 1) % endpoints.length; }
    }
    throw new Error(`${chain.toUpperCase()} RPC 全部不可用：${this.status[chain]?.error}`);
  }
}
export class Okx {
  constructor(vault) { this.vault = vault; }
  async get(path, params) {
    const c = this.vault.unlocked.get('okx'); if (!c) throw new Error('OKX 凭据未配置或未解锁');
    const query = new URLSearchParams(Object.entries(params).filter(([,v]) => v !== undefined && v !== '').map(([k,v]) => [k, String(v)])).toString();
    const requestPath = path + (query ? `?${query}` : ''), timestamp = new Date().toISOString();
    const signature = createHmac('sha256', c.secretKey).update(timestamp + 'GET' + requestPath).digest('base64');
    const r = await fetchJson(`https://web3.okx.com${requestPath}`, { headers: { 'OK-ACCESS-KEY': c.apiKey, 'OK-ACCESS-SIGN': signature, 'OK-ACCESS-TIMESTAMP': timestamp, 'OK-ACCESS-PASSPHRASE': c.passphrase, 'OK-ACCESS-PROJECT': c.projectId } });
    if (String(r.code) !== '0' || !Array.isArray(r.data) || !r.data.length) throw new Error(`OKX 路由失败，代码 ${String(r.code).slice(0,30)}`);
    return r.data[0];
  }
  swap(chain, from, to, amount, wallet, config) {
    return this.get('/api/v6/dex/aggregator/swap', { chainIndex: chainId(chain), fromTokenAddress: from, toTokenAddress: to, amount, userWalletAddress: wallet, swapReceiverAddress: wallet, slippagePercent: config.risk.maxSlippagePct, priceImpactProtectionPercent: config.risk.maxImpactPct, dexIds: config[chain].dexIds, directRoute: config[chain].strictPool ? 'true' : undefined });
  }
  approve(token, amount) { return this.get('/api/v6/dex/aggregator/approve-transaction', { chainIndex: '56', tokenContractAddress: token, approveAmount: amount }); }
  bridgeParams(from, amount, config, fromAddress, toAddress) {
    const to = from === 'bnb' ? 'sol' : 'bnb';
    return { fromChainIndex: chainId(from), toChainIndex: chainId(to), fromChainId: chainId(from), toChainId: chainId(to), fromTokenAddress: config[from].stable, toTokenAddress: config[to].stable, amount, slippagePercent: config.risk.maxSlippagePct, priceImpactProtectionPercentage: config.risk.maxImpactPct, userWalletAddress: fromAddress, receiveAddress: toAddress };
  }
  bridgeQuote(params) { return this.get('/api/v5/dex/cross-chain/quote', params); }
  bridgeBuild(params, route) { return this.get('/api/v5/dex/cross-chain/build-tx', { ...params, bridgeId: route.bridgeId, routeId: route.routeId }); }
  bridgeStatus(hash, from) { return this.get('/api/v5/dex/cross-chain/status', { hash, chainId: chainId(from), chainIndex: chainId(from) }); }
}
export async function market(chain, config) {
  const c = config[chain]; if (!c.token || !c.pool) throw new Error('请配置代币地址及行情池');
  const name = chain === 'bnb' ? 'bsc' : 'solana';
  const r = await fetchJson(`https://api.dexscreener.com/latest/dex/pairs/${name}/${encodeURIComponent(c.pool)}`);
  const pair = r.pairs?.find(p => p.chainId === name && sameAddress(chain, p.pairAddress, c.pool));
  if (!pair || !sameAddress(chain, pair.baseToken.address, c.token)) throw new Error('交易池未收录，或配置代币不是池的 baseToken');
  const price = Number(pair.priceUsd), liquidity = Number(pair.liquidity?.usd);
  if (!(price > 0) || !(liquidity > 0)) throw new Error('交易池价格或流动性缺失');
  const native = chain === 'bnb' ? '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' : 'So11111111111111111111111111111111111111112';
  const nr = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/${name}/${native}`);
  const valid = Array.isArray(nr) ? nr.filter(p => sameAddress(chain, p.baseToken?.address, native) && Number(p.priceUsd) > 0).sort((a,b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0)) : [];
  const nativePrice = Number(valid[0]?.priceUsd); if (!(nativePrice > 0)) throw new Error('无法获取 Gas 代币美元价格');
  const stablePairs=await fetchJson(`https://api.dexscreener.com/token-pairs/v1/${name}/${c.stable}`);
  const stableValues=(Array.isArray(stablePairs)?stablePairs:[]).map(p=>({liquidity:Number(p.liquidity?.usd||0),price:sameAddress(chain,p.baseToken?.address,c.stable)?Number(p.priceUsd):sameAddress(chain,p.quoteToken?.address,c.stable)?Number(p.priceUsd)/Number(p.priceNative):NaN})).filter(p=>p.price>0&&Number.isFinite(p.price)).sort((a,b)=>b.liquidity-a.liquidity);
  const stablePrice=stableValues[0]?.price;
  if(!(stablePrice>0))throw new Error('计价币美元价格缺失，禁止按 1 美元假定成交');
  return { price, liquidity, nativePrice, stablePrice, at: new Date().toISOString(), source: 'Dexscreener · 行情参考池', pool: c.pool, dex: pair.dexId, connected: true };
}
export async function waitFor(fn, timeout = 180000, interval = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const r = await fn(); if (r) return r; await sleep(interval); }
  throw new Error('链上确认超时；可能仍在处理中，请核对哈希，不得重复发送');
}

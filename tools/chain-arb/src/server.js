import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from './store.js';
import { Vault } from './vault.js';
import { RpcPool, Okx } from './network.js';
import { Chains } from './chains.js';
import { LiveAdapter, PaperAdapter } from './adapters.js';
import { Engine } from './engine.js';
import { mergeConfig, safeError, json } from './config.js';

export function createApplication(dataDir) {
  const store = new Store(dataDir), vault = new Vault(store), config = () => store.get('config');
  const rpc = new RpcPool(config), okx = new Okx(vault), chains = new Chains(rpc, vault, config);
  const paper = new PaperAdapter(store, config), live = new LiveAdapter(chains, rpc, okx, vault, config);
  const engine = new Engine(store, vault, { paper, live });
  const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex'), pending = new Set(), unlockAttempts = [];
  const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const jobs = new Map(); let port;
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(json(body)); };
  const compare = s => typeof s === 'string' && s.length === token.length && timingSafeEqual(Buffer.from(s), Buffer.from(token));
  const idle = () => { if (engine.busy || pending.size) throw new Error('当前正在执行，请稍后操作'); };
  const disarm = () => { store.set('automation',{arbitrage:false,rebalance:false}); engine.invalidate(); };
  const page = u => { const n = Number(u.searchParams.get('page') || 1); if (!Number.isInteger(n) || n < 1 || n > 100000) throw new Error('分页参数错误'); return n; };
  async function body(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('只接受 JSON 请求');
    let bytes = 0, chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 128000) throw new Error('请求过大'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new Error('JSON 格式错误'); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(req.socket.remoteAddress)) return send(res, 403, { error: '只允许本机访问' });
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return send(res, 403, { error: 'Host 检查失败' });
      const origin = req.headers.origin;
      if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return send(res, 403, { error: '跨站请求被拒绝' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: '跨站请求被拒绝' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`), path = url.pathname;
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET') return send(res, 405, { error: '方法无效' });
        const names = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg' }, file = names[path];
        if (!file) return send(res, 404, { error: '不存在' });
        const data = readFileSync(join(assets, file)); if (path === '/') res.setHeader('Set-Cookie', `arb_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(200, { 'Content-Type': { html:'text/html', js:'text/javascript', css:'text/css', svg:'image/svg+xml' }[file.split('.').pop()] + '; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(data);
      }
      const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('arb_session='))?.slice(12);
      if (!compare(cookie)) return send(res, 401, { error: '请从本机首页建立会话' });
      if (req.method === 'GET') {
        if (path === '/api/state') return send(res, 200, { ...engine.publicState(), csrf });
        if (path === '/api/jobs') return send(res, 200, store.list(page(url)));
        if (path === '/api/notes') return send(res, 200, store.notes(page(url)));
        if (path === '/api/rebalance') return send(res, 200, await engine.rebalancePlan(true));
        if (path.startsWith('/api/jobs/')) { const job = store.job(path.slice(10)); return send(res, job ? 200 : 404, job || { error: '档案不存在' }); }
        return send(res, 404, { error: '接口不存在' });
      }
      if (req.method !== 'POST' || req.headers['x-csrf-token'] !== csrf) return send(res, 403, { error: 'CSRF 检查失败' });
      const input = await body(req);
      if (path === '/api/config') {
        idle(); const updated = mergeConfig(config(), input); disarm(); store.set('config', updated);
        return send(res, 200, { config: updated, message: '已保存；修改配置会停止自动执行' });
      }
      if (path === '/api/poll') { await engine.tick(true); return send(res, 200, engine.publicState()); }
      if (path === '/api/wallet/import') { idle(); disarm(); return send(res, 200, vault.importWallet(input.chain, input)); }
      if (path === '/api/wallet/unlock' || path === '/api/okx/unlock') {
        idle(); const now = Date.now(); while (unlockAttempts[0] < now - 60000) unlockAttempts.shift(); if (unlockAttempts.length >= 5) return send(res, 429, { error: '解锁尝试过多，请一分钟后再试' }); unlockAttempts.push(now);
        disarm(); const result = path.includes('/wallet/') ? vault.unlock(input.chain, input.password) : (vault.unlockOkx(input.password), vault.okxStatus()); return send(res, 200, result);
      }
      if (path === '/api/wallet/lock') { idle(); disarm(); vault.lock(); return send(res, 200, { locked:true }); }
      if (path === '/api/okx/save') { idle(); disarm(); vault.saveOkx(input); return send(res, 200, vault.okxStatus()); }
      if (path === '/api/automation') {
        if (typeof input.arbitrage !== 'boolean' || typeof input.rebalance !== 'boolean') throw new Error('自动化选项无效');
        if ((input.arbitrage || input.rebalance) && store.get('pause')) throw new Error('请先核对档案并解除暂停');
        const reasons = engine.walletReasons(); if ((input.arbitrage || input.rebalance) && reasons.length) throw new Error(reasons.join('；'));
        store.set('automation', { arbitrage:input.arbitrage, rebalance:input.rebalance }); return send(res, 200, store.get('automation'));
      }
      if (path === '/api/pause') { engine.pause('用户暂停新任务，已广播任务继续结算', engine.active); return send(res, 200, { paused:true }); }
      if (path === '/api/resume') {
        idle(); if (store.db.prepare("SELECT count(*) AS n FROM jobs WHERE state='RECOVERY_REQUIRED'").get().n) throw new Error('仍有待核对交易，请在档案中逐笔确认处理');
        store.set('pause', null); engine.lastPoll = 0; return send(res, 200, { resumed:true, message: '暂停已解除，自动化仍关闭' });
      }
      if (path === '/api/paper/reset') { idle(); if (config().mode !== 'paper') throw new Error('仅模拟模式可重置'); disarm(); paper.reset(); return send(res, 200, { reset:true }); }
      if (path === '/api/arbitrage' || path === '/api/bridge/execute') {
        const key = req.headers['idempotency-key']; if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(key)) throw new Error('需要有效的幂等键');
        if (jobs.has(key)) return send(res, 202, jobs.get(key));
        if (engine.busy || engine.polling || pending.size) throw new Error('已有任务进行中，请稍后');
        const existing = store.job(key); if (existing) return send(res, 200, { id:key, state:existing.state });
        const state = { id:key, state:'QUEUED' }; jobs.set(key, state); pending.add(key);
        const operation = path === '/api/arbitrage' ? engine.runArbitrage(key) : engine.runBridge(input.from, input.amount, !!input.rebalance, key);
        operation.then(() => { state.state = 'COMPLETED'; }).catch(e => { state.state = 'REJECTED'; state.error = safeError(e); if (!store.job(key)) { store.create('rejected', { mode:config().mode, failure:state.error }, key); store.transition(key, 'FAILED', { reason:state.error }); } }).finally(() => pending.delete(key));
        return send(res, 202, state);
      }
      if (path === '/api/bridge/quote') { if (engine.busy) throw new Error('已有交易进行中'); return send(res, 200, await engine.bridgePreview(input.from, input.amount)); }
      if (path === '/api/jobs/acknowledge') {
        idle(); const job = store.job(input.id); if (!job || job.state !== 'RECOVERY_REQUIRED') throw new Error('仅待核对任务可确认处理');
        if (input.reviewed !== true || typeof input.note !== 'string' || input.note.trim().length < 8) throw new Error('确认已核对余额及哈希，并填写至少 8 字的处理说明');
        store.transition(job.id, 'ACKNOWLEDGED', { note:input.note.slice(0,4000), message:'用户手动核对并接管，不代表交易成功或利润已验证' }); return send(res, 200, store.job(job.id));
      }
      if (path === '/api/jobs/recheck') {
        const job = store.job(input.id); if (!job || job.mode !== 'live') throw new Error('仅实盘交易支持链上复查');
        const unique = new Map(job.events.filter(e => e.detail?.hash && e.detail?.chain).map(e => [e.detail.hash, e.detail]));
        const result = [];
        for (const [hash, detail] of unique) {
          try {
            const receipt = await rpc.call(detail.chain, detail.chain === 'bnb' ? 'eth_getTransactionReceipt' : 'getTransaction', detail.chain === 'bnb' ? [hash] : [hash, {encoding:'jsonParsed', commitment:'finalized', maxSupportedTransactionVersion:0}]);
            result.push({ chain:detail.chain, hash, receipt, status:receipt ? (detail.chain === 'bnb' ? receipt.status === '0x1' : !receipt.meta?.err) ? 'ON_CHAIN_SUCCESS' : 'ON_CHAIN_FAILED' : 'NOT_FOUND_OR_PENDING' });
          } catch(e) { result.push({ chain:detail.chain, hash, error:safeError(e) }); }
        }
        store.transition(job.id, job.state, { recheck:result, message:'复查不自动重发、不触发卖出、不改变利润结算' }); return send(res, 200, result);
      }
      if (path === '/api/notes/save') return send(res, 201, { id:store.addNote(input.text) });
      if (path === '/api/notes/delete') { if (typeof input.id !== 'string') throw new Error('备忘录 ID 错误'); store.db.prepare('DELETE FROM notes WHERE id=?').run(input.id); return send(res, 200, { deleted:true }); }
      return send(res, 404, { error:'接口不存在' });
    } catch(e) { return send(res, 400, { error:safeError(e) }); }
  });
  return { server, store, vault, engine, async listen(requestedPort = 0) {
    await new Promise((resolve,reject) => { server.once('error', reject); server.listen(requestedPort, '127.0.0.1', resolve); }); port = server.address().port; engine.start(); return port;
  }, async close() { engine.stop(); vault.lock(); await new Promise(resolve => server.close(resolve)); store.close(); } };
}
export async function startLocalApplication() {
  const dir = process.env.ARB_DATA_DIR || join(homedir(), '.dualchain-arb');
  const app = createApplication(dir);
  const port = await app.listen(Number(process.env.PORT || 0));
  console.log(`双链同币套利 · 本机地址 http://127.0.0.1:${port}`);
  console.log(`数据目录：${dir}；默认模拟模式；重启后须重新解锁钱包并启用自动执行。`);
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => { app.engine.pause('进程退出，未结算任务重启后须核对', app.engine.active); app.engine.stop(); await new Promise(resolve => app.server.close(resolve)); app.vault.lock(); app.store.close(); process.exit(0); });
  return app;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await startLocalApplication();

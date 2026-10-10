const $ = id => document.getElementById(id);
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd = value => Number.isFinite(Number(value)) && value !== null && value !== undefined ? '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:4 }) : '—';
const num = (value, digits=4) => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', { maximumFractionDigits:digits }) : '—';
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12:false }) : '—';
const names = { bnb:'BNB Chain', sol:'Solana' };
const states = { CREATED:'已创建', BUY_PREPARING:'准备买入', BUY_CONFIRMED:'买入已确认', SELL_PREPARING:'准备卖出', BRIDGE_PREPARING:'准备跨链', COMPLETED:'已结算', RECOVERY_REQUIRED:'待核对 · 已暂停', ACKNOWLEDGED:'人工接管', FAILED:'未执行' };
let lastRebalanceCheck=0; let state, csrf, configLoaded=false, bridgeQuote, rebalance, currentJob, archivePage=1, notePage=1, activeTab='home', fetching=false;
const history = { bnb:[], sol:[] }; let toastTimer;
function toast(message, error=false) { const el=$('toast'); el.textContent=message; el.className=`show${error?' error':''}`; clearTimeout(toastTimer); toastTimer=setTimeout(() => {el.className='';}, error?7000:4000); }
async function api(path, input, key) {
  const options = input === undefined ? {} : { method:'POST', headers:{ 'Content-Type':'application/json', 'X-CSRF-Token':csrf, ...(key ? {'Idempotency-Key':key} : {}) }, body:JSON.stringify(input) };
  const response=await fetch(`/api/${path}`, options); const result=await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
}
function setText(id, text) { $(id).textContent=text; }
function switchTab(tab) {
  activeTab=tab;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.id===`tab-${tab}`));
  document.querySelectorAll('.nav').forEach(x => x.classList.toggle('active', x.dataset.tab===tab));
  setText('page-title', { home:'行情首页', settings:'设置与钱包', bridge:'OKX 跨链', archive:'交易档案', notes:'备忘录' }[tab]);
  if (tab==='archive') loadArchive().catch(e => toast(e.message,true));
  if (tab==='notes') loadNotes().catch(e => toast(e.message,true));
  if (tab==='bridge') checkRebalance().catch(e => toast(e.message,true));
}
function chart(chain, m) {
  if (!m?.price || !m.at) return;
  const points=history[chain]; if (points.at(-1)?.at!==m.at) points.push({ at:m.at, price:m.price }); if (points.length>40) points.shift();
  const prices=points.map(p=>p.price), min=Math.min(...prices), max=Math.max(...prices), range=Math.max(max-min, max*0.001);
  const coords=prices.map((v,i) => `${10+i/(Math.max(prices.length-1,1))*420},${55-(v-min)/range*45}`).join(' ');
  $(chain+'-chart').innerHTML=points.length>1?`<polyline points="${coords}"></polyline>`:'<circle cx="10" cy="55" r="2" fill="currentColor"></circle>';
}
function render(s) {
  state=s; csrf=s.csrf || csrf;
  const live=s.mode==='live'; $('mode-tag').className='pill'+(live?' live':''); setText('mode-tag',live?'实盘 · 主网':'模拟 · 非实时');
  setText('clock',new Date().toLocaleTimeString('zh-CN',{hour12:false})); setText('footer-mode',live?'实盘环境 · 仅在本机签名':'模拟环境 · 不使用真实资金');
  const pause=$('global-pause'); pause.classList.toggle('hidden',!s.pause); pause.textContent=s.pause ? `已暂停：${s.pause.reason}。请在交易档案核对余额、哈希和回执。` : '';
  setText('poll-status',s.polling?'刷新行情中…':s.busy?'交易结算中 · 暂停新报价':`每 ${s.config.pollSeconds} 秒轮询`);
  for (const chain of ['bnb','sol']) {
    const m=s.markets[chain] || {}, ok=m.connected && m.rpc?.connected;
    const badge=$(chain+'-status'); badge.className='connection '+(ok?'ok':'error'); badge.textContent=ok?'● 已连接':'● 未连接';
    setText(chain+'-source',m.source || m.error || '等待配置'); setText(chain+'-price',m.price ? '$'+num(m.price,8) : '—');
    setText(chain+'-liquidity',usd(m.liquidity)); setText(chain+'-cash',num(m.balance?.cashUsd)+' U'); setText(chain+'-tokens',num(m.balance?.tokens));
    setText(chain+'-at','更新 '+(m.at ? new Date(m.at).toLocaleTimeString('zh-CN',{hour12:false}) : '—'));
    setText(chain+'-rpc',m.rpc?.endpoint ? `RPC ${m.rpc.index} · ${m.rpc.endpoint}` : 'RPC 未连接'); chart(chain,m);
    const w=s.wallets[chain]; $(chain+'-wallet-summary').innerHTML=`<strong>${w.type==='missing'?'尚未导入钱包':w.type==='readonly'?'只读钱包':w.unlocked?'签名钱包 · 已解锁':'加密钱包 · 已锁定'}</strong>${h(w.address || '模拟模式不需要钱包')}<br>${m.balance ? 'Gas 余额：'+num(m.balance.native,6)+' '+(chain==='bnb'?'BNB':'SOL') : ''}`;
  }
  const q=s.opportunity || {}, ready=q.profit !== undefined && !q.reasons?.length && !s.busy && !s.polling;
  setText('buy-chain', q.buy ? names[q.buy]+' 买入' : '等待买入'); setText('sell-chain', q.sell ? names[q.sell]+' 卖出' : '等待卖出');
  setText('spread',q.spreadPct===undefined?'—':num(q.spreadPct,3)+'%'); setText('trade-amount',num(s.config.risk.amount)+' U');
  setText('slippage',num(s.config.risk.maxSlippagePct)+'%'); setText('impact',q.impactPct===undefined?'—':num(q.impactPct,3)+'%'); setText('gas-cost',usd(q.gasUsd)); setText('net-profit',usd(q.profit)); $('net-profit').className=q.profit<0?'negative':'positive';
  const reasons=$('reasons'); reasons.className='reasons'+(ready?' ready':''); reasons.innerHTML=q.reasons?.length ? `<ul>${q.reasons.map(r=>`<li>${h(r)}</li>`).join('')}</ul>` : s.busy?'交易进行中：确认及结算完成前禁止新任务。': s.polling?'正在检查新鲜报价。':'✓ 风控条件满足，可按顺序执行。';
  $('opportunity-tag').className='pill'+(ready?'':' neutral'); setText('opportunity-tag',ready?'满足执行条件':s.busy?'执行中':'等待条件');
  $('execute-arb').disabled=!ready; setText('execute-arb',s.busy?'等待链上确认…':live?'执行一次实盘套利':'执行一次模拟套利');
  $('auto-arb').checked=s.automation.arbitrage; $('auto-rebalance').checked=s.automation.rebalance;
  setText('run-status',s.busy?'交易执行中':s.pause?'暂停 · 需核对':s.automation.arbitrage||s.automation.rebalance?'自动监测中':'待命'); setText('run-sub',s.active ? '任务 '+s.active.slice(0,8) : s.pause?'自动化已关闭':live?'链上执行，逐步确认':'模拟执行，不发送链上交易'); $('run-orb').className='status-orb'+(s.pause?' paused':'');
  const r=s.config.risk; setText('execution-count',`${s.limits.executions} / ${r.maxExecutions}`); $('count-progress').max=r.maxExecutions; $('count-progress').value=s.limits.executions;
  setText('total-amount',`${num(s.limits.total)} / ${num(r.maxTotal)} U`); $('amount-progress').max=r.maxTotal; $('amount-progress').value=s.limits.total;
  setText('bnb-reserve',num(s.config.bnb.reserve,6)+' BNB'); setText('sol-reserve',num(s.config.sol.reserve,6)+' SOL'); $('resume-btn').classList.toggle('hidden',!s.pause);
  setText('okx-status',s.okx.configured ? s.okx.unlocked?'已配置 · 已解锁':'已加密 · 未解锁':'未配置');
  if (!configLoaded) fillConfig(s.config);
}
function fillConfig(config) {
  document.querySelectorAll('[data-config]').forEach(el => { const value=el.dataset.config.split('.').reduce((o,k)=>o?.[k],config); if(el.type==='checkbox') el.checked=value; else el.value=Array.isArray(value)?value.join('\n'):value??''; }); configLoaded=true;
}
function collectConfig() {
  const c=structuredClone(state.config); document.querySelectorAll('[data-config]').forEach(el => { const keys=el.dataset.config.split('.'), key=keys.pop(), target=keys.reduce((o,k)=>o[k],c); target[key]=el.type==='checkbox'?el.checked:el.type==='number'?Number(el.value):key==='rpc'?el.value.split('\n').map(s=>s.trim()).filter(Boolean):el.value.trim(); }); return c;
}
function jobTable(items) {
  if (!items.length) return '<div class="empty">还没有交易记录。执行后，报价与每一步状态都会显示在这里。</div>';
  return `<table><thead><tr><th>时间</th><th>类型 / 模式</th><th>方向</th><th>金额</th><th>实际净收益 / 磨损</th><th>状态</th><th></th></tr></thead><tbody>${items.map(j => { const done=j.state==='COMPLETED', value=j.kind==='bridge'?j.result?.wear:j.result?.profit;
    return `<tr><td>${h(time(j.created))}</td><td>${j.kind==='bridge'?'跨链'+(j.rebalance?' · 再平衡':''):j.kind==='rejected'?'未执行':'套利'}<br><span class="muted small">${j.mode==='live'?'实盘':'模拟'}</span></td><td>${h(names[j.buy || j.from] || '—')} → ${h(names[j.sell || j.to] || '—')}</td><td>${num(j.amount)} U</td><td class="${j.kind==='bridge'?'muted':value<0?'negative':'positive'}">${usd(value)}</td><td><span class="job-status ${done?'done':['RECOVERY_REQUIRED','FAILED'].includes(j.state)?'failed':''}">${h(states[j.state] || j.state)}</span></td><td><button class="link-button" data-job="${h(j.id)}">详情 →</button></td></tr>`; }).join('')}</tbody></table>`;
}
async function loadRecent() { const r=await api('jobs'); $('recent-jobs').innerHTML=jobTable(r.items.slice(0,5)); }
function pagination(id, page, total, size, type) { const pages=Math.max(1,Math.ceil(total/size)); $(id).innerHTML=`<button class="button" data-page="${type}:${page-1}" ${page<=1?'disabled':''}>上一页</button><span>${page} / ${pages} · 共 ${total} 条</span><button class="button" data-page="${type}:${page+1}" ${page>=pages?'disabled':''}>下一页</button>`; }
async function loadArchive() { const r=await api(`jobs?page=${archivePage}`); $('archive-jobs').innerHTML=jobTable(r.items); pagination('archive-pagination',archivePage,r.total,10,'archive'); }
async function loadNotes() { const r=await api(`notes?page=${notePage}`); $('notes-list').innerHTML=r.items.length?r.items.map(n=>`<article class="card note-card"><div class="card-top"><time>${h(time(n.created))}</time><button class="link-button" data-delete-note="${h(n.id)}">删除</button></div><p>${h(n.text)}</p></article>`).join(''):'<article class="card empty">还没有备忘录。从上方写下第一条记录。</article>'; pagination('notes-pagination',notePage,r.total,8,'notes'); }
async function showJob(id) {
  currentJob=await api('jobs/'+encodeURIComponent(id)); const j=currentJob;
  $('job-detail').innerHTML=`<div class="detail-summary"><span class="pill ${j.mode==='live'?'live':'neutral'}">${j.mode==='live'?'实盘':'模拟'}</span> <strong>${h(states[j.state] || j.state)}</strong><br>任务 ID：${h(j.id)}<br>创建：${h(time(j.created))}<br>${j.failure?'失败原因：'+h(j.failure):''}</div>
    ${j.result?`<div class="metric-grid">${Object.entries(j.result).filter(([,v])=>typeof v==='number').map(([k,v])=>`<div><span>${h({profit:'实际利润 / USD',difference:'与估算差异 / USD',wear:'实际磨损 / USD',wearPct:'实际磨损率 / %',input:'实际扣款',output:'实际到账',gasUsd:'实际 Gas / USD',rentUsd:'实际租金 / USD',receivedTokens:'实际买入数量',soldTokens:'实际卖出数量',estimateProfit:'估算利润 / USD',buySlippagePct:'买入滑点 / %',sellSlippagePct:'卖出滑点 / %',sourceFeeUsd:'源链费用 / USD',destinationFeeUsd:'目标链费用 / USD'}[k] || k)}</span><strong>${num(v,8)}</strong></div>`).join('')}</div>`:''}
    ${j.mode==='live'?'<button class="button" data-action="recheck-job">读取链上最新回执</button>':''}
    <div class="timeline">${j.events.map(e=>`<div class="event"><strong>${h(states[e.state] || e.state)}</strong><time>${h(time(e.at))}</time><pre>${h(JSON.stringify(e.detail,null,2))}</pre></div>`).join('')}</div>
    ${j.state==='RECOVERY_REQUIRED'?`<form id="ack-form" class="recovery-form"><h3>人工核对与接管</h3><p>核对所有哈希、两侧余额及单边仓位；此操作不宣称交易成功，不会自动补单。</p><label>处理说明<textarea name="note" minlength="8" maxlength="4000" rows="3" required placeholder="填写余额、哈希确认结果及仓位处理安排…"></textarea></label><label class="check"><input type="checkbox" name="reviewed" required>已核对两侧余额、交易哈希和单边仓位</label><button class="button" type="submit">保存人工处理记录</button></form>`:''}
    <details><summary>完整档案 · 报价 / 配置 / 回执</summary><pre>${h(JSON.stringify(j,null,2))}</pre></details>`;
  if (!$('job-dialog').open) $('job-dialog').showModal();
  const ack=$('ack-form'); if(ack) ack.addEventListener('submit',async e=>{e.preventDefault();try{ const f=new FormData(ack);await api('jobs/acknowledge',{id:j.id,note:f.get('note'),reviewed:f.get('reviewed')==='on'});toast('已记录人工接管；在首页解除暂停后可继续');await showJob(j.id);await refresh();}catch(e){toast(e.message,true);}});
}
async function checkRebalance() { lastRebalanceCheck=Date.now(); rebalance=await api('rebalance'); $('rebalance-status').textContent=rebalance.eligible?`${names[rebalance.from]} → ${names[rebalance.to]}，预计划转 ${num(rebalance.amount)} U。到账后两侧 ${num(rebalance.lowAfter)} / ${num(rebalance.highAfter)} U。`:rebalance.reason; $('rebalance-now').classList.toggle('hidden',!rebalance.eligible); }
async function refresh() { if(fetching)return;fetching=true;try{render(await api('state'));await loadRecent(); if(activeTab==='archive')await loadArchive();if(activeTab==='bridge' && Date.now()-lastRebalanceCheck>15000)await checkRebalance();}finally{fetching=false;} }
function quoteBridge(q) {
  bridgeQuote=q; $('bridge-quote').className='bridge-details'; $('bridge-quote').innerHTML=`<div><span>预计目标到账</span><strong>${num(q.output,6)} U</strong></div><div><span>源链 Gas + 租金</span><strong>${usd(q.sourceGas.usd)}</strong></div><div><span>目标链费用预算</span><strong>${usd(q.destinationFeeUsd)}</strong></div><div><span>预计美元磨损</span><strong>${usd(q.wear)}</strong></div><div><span>预计磨损率</span><strong>${num(q.wearPct,3)}%</strong></div><div><span>价格冲击</span><strong>${num(q.impact,3)}%</strong></div><div><span>报价时间</span><strong>${h(time(q.at))}</strong></div><div class="reasons ${q.reasons.length?'':'ready'}">${q.reasons.length?h(q.reasons.join('；')):'✓ Gas 保留及磨损条件满足'}</div>`;
  $('bridge-execute').classList.toggle('hidden',!!q.reasons.length); setText('bridge-execute',state.mode==='paper'?'执行模拟跨链':'执行实盘跨链');
}
async function action(name) {
  if(name==='refresh'){await api('poll',{});await refresh();}
  if(name==='pause'){await api('pause',{});toast('已暂停新任务，已广播任务继续结算');await refresh();}
  if(name==='resume'){await api('resume',{});toast('已解除暂停，自动化仍关闭');await refresh();}
  if(name==='lock-wallets'){await api('wallet/lock',{});toast('钱包与 OKX 凭据已锁定');await refresh();}
  if(name==='reset-paper'){await api('paper/reset',{});toast('模拟资金与模拟额度已重置');await refresh();}
  if(name==='execute-arb'){const r=await api('arbitrage',{},crypto.randomUUID());toast('套利检查已启动，任务 '+r.id.slice(0,8));await refresh();}
  if(name==='execute-bridge'){if(!bridgeQuote)throw new Error('请先获取报价');const r=await api('bridge/execute',{from:bridgeQuote.from,amount:bridgeQuote.amount},crypto.randomUUID());toast('跨链检查已启动，任务 '+r.id.slice(0,8));$('bridge-execute').classList.add('hidden');bridgeQuote=null;await refresh();}
  if(name==='check-rebalance')await checkRebalance();
  if(name==='rebalance-now'){if(!rebalance?.eligible)throw new Error('再平衡条件不满足');await api('bridge/execute',{from:rebalance.from,amount:rebalance.amount,rebalance:true},crypto.randomUUID());toast('再平衡检查已启动');await refresh();}
  if(name==='reload-archive')await loadArchive();
  if(name==='recheck-job'){await api('jobs/recheck',{id:currentJob.id});await showJob(currentJob.id);toast('已保存本次链上复查记录');}
}
document.addEventListener('click',async e=>{
  const tab=e.target.closest('[data-tab]'); if(tab)switchTab(tab.dataset.tab);
  const el=e.target.closest('[data-action]'); if(el){el.disabled=true;try{await action(el.dataset.action);}catch(e){toast(e.message,true);}finally{el.disabled=false;}}
  const job=e.target.closest('[data-job]'); if(job)try{await showJob(job.dataset.job);}catch(e){toast(e.message,true);}
  const p=e.target.closest('[data-page]'); if(p){const [type,n]=p.dataset.page.split(':');if(type==='archive'){archivePage=Number(n);await loadArchive();}else{notePage=Number(n);await loadNotes();}}
  const del=e.target.closest('[data-delete-note]'); if(del)try{await api('notes/delete',{id:del.dataset.deleteNote});await loadNotes();toast('备忘录已删除');}catch(e){toast(e.message,true);}
});
async function submit(form, fn) {
  form.addEventListener('submit',async e=>{e.preventDefault();const btn=form.querySelector('[type=submit]');btn.disabled=true;try{await fn();}catch(e){toast(e.message,true);}finally{btn.disabled=false;}});
}
submit($('config-form'),async()=>{ const result=await api('config',collectConfig());fillConfig(result.config);toast(result.message);bridgeQuote=null;$('bridge-execute').classList.add('hidden');await refresh();});
document.querySelectorAll('.wallet-form').forEach(form=>{
  form.elements.type.addEventListener('change',()=>{const privateWallet=form.elements.type.value==='private';form.querySelector('.private-fields').classList.toggle('hidden',!privateWallet);form.querySelector('.readonly-field').classList.toggle('hidden',privateWallet);});
  submit(form,async()=>{const values=Object.fromEntries(new FormData(form)), input={chain:form.dataset.chain,...values};try{await api('wallet/import',input);toast('钱包已导入');}finally{form.elements.privateKey.value='';form.elements.password.value='';}await refresh();});
});
document.querySelectorAll('.unlock-form').forEach(form=>submit(form,async()=>{try{await api('wallet/unlock',{chain:form.dataset.chain,password:form.elements.password.value});toast('钱包已解锁');}finally{form.elements.password.value='';}await refresh();}));
submit($('okx-form'),async()=>{const form=$('okx-form');try{await api('okx/save',Object.fromEntries(new FormData(form)));toast('OKX 凭据已加密保存');}finally{form.reset();}await refresh();});
submit($('okx-unlock'),async()=>{const f=$('okx-unlock');try{await api('okx/unlock',{password:f.elements.password.value});toast('OKX 已解锁');}finally{f.reset();}await refresh();});
for (const id of ['auto-arb','auto-rebalance']) $(id).addEventListener('change',async()=>{try{await api('automation',{arbitrage:$('auto-arb').checked,rebalance:$('auto-rebalance').checked});toast('自动化设置已更新');}catch(e){toast(e.message,true);}await refresh();});
submit($('bridge-form'),async()=>{quoteBridge(await api('bridge/quote',{from:$('bridge-from').value,amount:Number($('bridge-amount').value)}));});
for(const id of ['bridge-from','bridge-amount'])$(id).addEventListener('input',()=>{bridgeQuote=null;$('bridge-execute').classList.add('hidden');});
submit($('note-form'),async()=>{await api('notes/save',{text:$('note-text').value});$('note-text').value='';notePage=1;await loadNotes();toast('备忘录已保存');});
$('close-dialog').addEventListener('click',()=>$('job-dialog').close());
$('download-job').addEventListener('click',()=>{if(!currentJob)return;const url=URL.createObjectURL(new Blob([JSON.stringify(currentJob,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`chaindesk-${currentJob.id}.json`;a.click();URL.revokeObjectURL(url);});
refresh().catch(e=>toast(e.message,true)); setInterval(()=>refresh().catch(e=>toast(e.message,true)),2000);

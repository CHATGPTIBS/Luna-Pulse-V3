const qs = (s, root=document) => root.querySelector(s);
const qsa = (s, root=document) => [...root.querySelectorAll(s)];
const store = {
  token: localStorage.getItem('luna_web_token') || '',
  boot: null,
  discover: [],
  tokenIntel: null,
  tradeMode: 'paper',
  tradeSide: 'buy',
  tradeType: 'market',
  view: 'dashboard',
};

function esc(v='') {
  return String(v).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
}
function short(v='') { const s=String(v); return s.length>12 ? `${s.slice(0,5)}…${s.slice(-4)}` : s; }
function money(v) {
  const n=Number(v||0);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n)>=1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (Math.abs(n)>=1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (Math.abs(n)>=1e3) return `$${(n/1e3).toFixed(1)}K`;
  if (Math.abs(n)>=1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(4)}`;
}
function num(v,d=2){const n=Number(v);return Number.isFinite(n)?n.toFixed(d):'—'}
function sol(v,d=3){const n=Number(v);return Number.isFinite(n)?`${n.toFixed(d)} SOL`:'—'}
function pct(v,d=1){const n=Number(v);return Number.isFinite(n)?`${n>=0?'+':''}${n.toFixed(d)}%`:'—'}
function ago(value){
  const t=typeof value==='number' ? (value > 1e12 ? value : value*1000) : new Date(value||0).getTime();
  if(!t) return '—'; const s=Math.max(0,(Date.now()-t)/1000);
  if(s<60)return `${Math.round(s)}s`; if(s<3600)return `${Math.round(s/60)}m`; if(s<86400)return `${Math.round(s/3600)}h`; return `${Math.round(s/86400)}d`;
}
function pnlClass(v){return Number(v)>=0?'positive':'negative'}

function toast(message, type='success'){
  const el=document.createElement('div'); el.className=`toast ${type}`; el.textContent=message;
  qs('#toastHost').appendChild(el); setTimeout(()=>el.remove(),4200);
}

async function api(path, options={}){
  const headers={...(options.headers||{})};
  if(store.token) headers.Authorization=`Bearer ${store.token}`;
  if(options.body && !(options.body instanceof FormData)) headers['Content-Type']='application/json';
  const res=await fetch(path,{...options,headers});
  let data={}; try{data=await res.json()}catch{}
  if(!res.ok || data.ok===false) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showAuth(error=''){
  qs('#authGate').classList.remove('hidden');
  qs('#authError').textContent=error;
  qs('#authToken').value=store.token;
  setTimeout(()=>qs('#authToken').focus(),50);
}
function hideAuth(){qs('#authGate').classList.add('hidden');qs('#authError').textContent='';}

async function refreshAll({discover=true}={}){
  const data=await api('/api/bootstrap');
  store.boot=data;
  renderAll();
  if(discover) await loadDiscover();
  return data;
}

async function loadDiscover(){
  const data=await api('/api/discover?limit=18');
  store.discover=data.rows||[];
  renderDiscover();
  renderDashboardDiscovery();
}

function gotoView(name){
  store.view=name;
  qsa('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));
  qsa('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  window.scrollTo({top:0,behavior:'smooth'});
}

function renderAll(){
  if(!store.boot)return;
  const b=store.boot, p=b.portfolio||{}, s=b.stats||{};
  qs('#statEquity').textContent=sol(p.equitySol);
  qs('#statPnl').textContent=`PnL ${Number(p.totalPnlSol)>=0?'+':''}${num(p.totalPnlSol,3)} SOL`;
  qs('#statPnl').className=pnlClass(p.totalPnlSol);
  qs('#statWinRate').textContent=s.wins+s.losses?`${num(s.winRate,1)}%`:'—';
  qs('#statWins').textContent=`${s.wins||0}W / ${s.losses||0}L observed exits`;
  qs('#statWallets').textContent=`${s.activeLeaders||0}/${(b.leaders||[]).length}`;
  qs('#statOrders').textContent=String(s.openOrders||0);
  qs('#statSnipers').textContent=`${s.enabledSnipers||0} sniper setup${s.enabledSnipers===1?'':'s'}`;
  qs('#pauseText').textContent=b.settings?.paused?'PAUSED':'RUNNING';
  qs('#engineLabel').textContent=b.settings?.paused?'Engine paused':'Engine running';
  qs('#engineSub').textContent=s.heliusCoolingDown?`Helius cooldown · ${s.helius429s} 429s`:`${s.heliusRequests||0} Helius requests`;
  qs('#engineDot').className=`status-dot ${b.settings?.paused?'bad':'good'}`;
  qs('#liveFlag').textContent=s.liveTradingEnabled?'ENABLED':'DISABLED';
  qs('#liveFlag').className=s.liveTradingEnabled?'negative':'positive';
  renderMode();
  renderDashboardLeaders();
  renderDashboardPositions();
  renderSignals();
  renderLeaders();
  renderPositions();
  renderOrders();
  renderSnipers();
  renderHistory();
}

function renderMode(){
  qsa('#modeSwitch button').forEach(b=>b.classList.toggle('active',b.dataset.mode===store.tradeMode));
  qs('#tradeModeLabel').textContent=store.tradeMode.toUpperCase();
  updateExecuteLabel();
}

function renderDashboardDiscovery(){
  const root=qs('#dashboardDiscovery');
  if(!store.discover.length){root.innerHTML='<div class="empty-state">No discovery data loaded.</div>';return}
  const rows=store.discover.slice(0,7);
  root.innerHTML=`<table class="data-table"><thead><tr><th>Token</th><th>MCap</th><th>1h vol</th><th>1h</th><th>5m B/S</th><th></th></tr></thead><tbody>${rows.map(x=>`
    <tr><td>${esc(x.symbol||'TOKEN')}<div class="mono muted">${esc(short(x.mint))}</div></td><td>${money(x.marketCapUsd)}</td><td>${money(x.volume1h)}</td><td class="${pnlClass(x.priceChange1h)}">${pct(x.priceChange1h)}</td><td>${num(x.buys5m,0)}/${num(x.sells5m,0)}</td><td><button class="table-action token-open" data-mint="${esc(x.mint)}">Trade</button></td></tr>`).join('')}</tbody></table>`;
}

function renderDashboardLeaders(){
  const root=qs('#dashboardLeaders'), rows=(store.boot?.leaders||[]).slice(0,6);
  root.innerHTML=rows.length?rows.map(l=>`<div class="stack-item">
    <span class="pill ${l.enabled!==false?'green':'red'}">${l.enabled!==false?'ON':'PAUSED'}</span>
    <div class="grow"><b>${esc(l.label||short(l.address))}</b><small>${esc(short(l.address))} · Tier ${esc(l.tier||'B')} · ${esc((l.copyMode||'track').toUpperCase())}</small></div>
    <span class="pill purple">${l.lastActivityAt?ago(l.lastActivityAt):'idle'}</span>
  </div>`).join(''):'<div class="empty-state">No wallets tracked yet.</div>';
}

function renderDashboardPositions(){
  const rows=(store.boot?.portfolio?.positions||[]).slice(0,6), root=qs('#dashboardPositions');
  root.innerHTML=rows.length?rows.map(x=>`<div class="stack-item">
    <div class="grow"><b>${esc(short(x.mint))}</b><small>${sol(x.valueSol)} · ${esc(x.leaderLabel||x.leaderAddress||'Manual')}</small></div>
    <b class="${pnlClass(x.pnlSol)}">${Number(x.pnlSol)>=0?'+':''}${num(x.pnlSol,3)} SOL</b>
  </div>`).join(''):'<div class="empty-state">No open paper positions.</div>';
}

function renderSignals(){
  const rows=(store.boot?.signals||[]).slice(0,7), root=qs('#dashboardSignals');
  root.innerHTML=rows.length?rows.map(x=>`<div class="stack-item"><span class="pill green">BUY</span><div class="grow"><b>${esc(short(x.mint))}</b><small>${num(x.walletCount,0)} wallets · weight ${num(x.totalWeight,2)} · ${ago(x.at)} ago</small></div></div>`).join(''):'<div class="empty-state">No qualified signals yet.</div>';
}

function sortedDiscover(){
  const filter=String(qs('#discoverFilter')?.value||'').toLowerCase();
  const sort=qs('#discoverSort')?.value||'volume';
  const rows=store.discover.filter(x=>`${x.symbol||''} ${x.name||''} ${x.mint||''}`.toLowerCase().includes(filter));
  const key={volume:'volume1h',liquidity:'liquidityUsd',mcap:'marketCapUsd',change:'priceChange1h'}[sort];
  return [...rows].sort((a,b)=>Number(b[key]||0)-Number(a[key]||0));
}
function renderDiscover(){
  const root=qs('#discoverTable'); if(!root)return;
  const rows=sortedDiscover();
  root.innerHTML=rows.length?`<table class="data-table"><thead><tr><th>#</th><th>Token</th><th>Price</th><th>Liquidity</th><th>MCap</th><th>1h Volume</th><th>1h</th><th>5m Buys/Sells</th><th></th></tr></thead><tbody>${rows.map((x,i)=>`
    <tr><td class="muted">${i+1}</td><td><b>${esc(x.symbol||'TOKEN')}</b><div class="mono muted">${esc(short(x.mint))}</div></td><td>${money(x.priceUsd)}</td><td>${money(x.liquidityUsd)}</td><td>${money(x.marketCapUsd)}</td><td>${money(x.volume1h)}</td><td class="${pnlClass(x.priceChange1h)}">${pct(x.priceChange1h)}</td><td>${num(x.buys5m,0)} / ${num(x.sells5m,0)}</td><td><button class="table-action token-open" data-mint="${esc(x.mint)}">Open</button></td></tr>`).join('')}</tbody></table>`:'<div class="empty-state" style="padding:20px">No tokens match this filter.</div>';
}

async function loadToken(mint, jump=true){
  mint=String(mint||'').trim();
  if(!mint) throw new Error('Paste a token contract address first.');
  const data=await api(`/api/token?mint=${encodeURIComponent(mint)}`);
  store.tokenIntel=data.token;
  qs('#tradeMint').value=mint;
  renderTokenIntel();
  if(jump)gotoView('trade');
  return data.token;
}
function renderTokenIntel(){
  const x=store.tokenIntel, root=qs('#tokenHero'); if(!x)return;
  const risks=(x.risks||[]).slice(0,3).map(r=>`${r.level||''}: ${r.name||''}`).join(' · ');
  root.innerHTML=`<div class="token-title"><div class="token-icon">${esc((x.symbol||'T').slice(0,2))}</div><div><h3>${esc(x.symbol||'TOKEN')} <span class="muted">${esc(x.name||'')}</span></h3><small class="mono">${esc(short(x.mint||qs('#tradeMint').value))}</small></div></div>
  <div class="token-metrics"><div class="metric"><span>Price</span><b>${money(x.priceUsd)}</b></div><div class="metric"><span>Liquidity</span><b>${money(x.liquidityUsd)}</b></div><div class="metric"><span>MCap</span><b>${money(x.marketCapUsd)}</b></div><div class="metric"><span>1h vol</span><b>${money(x.volume1h)}</b></div><div class="metric"><span>1h</span><b class="${pnlClass(x.priceChange1h)}">${pct(x.priceChange1h)}</b></div></div>
  <div class="risk-line">${x.rugged?'🚨 Rugged flag detected. ':''}${risks?esc(risks):x.rugUnavailable?'Security scanner unavailable.':'No major scanner warning in current response.'}</div>`;
  const mint=qs('#tradeMint').value.trim();
  const frame=qs('#dexFrame'), ph=qs('#chartPlaceholder');
  frame.src=`https://dexscreener.com/solana/${encodeURIComponent(mint)}?embed=1&theme=dark&trades=0&info=0`;
  frame.style.display='block'; ph.style.display='none';
}

function renderLeaders(){
  const root=qs('#leadersTable'); if(!root)return;
  const rows=store.boot?.leaders||[];
  root.innerHTML=rows.length?`<table class="data-table"><thead><tr><th>Status</th><th>Wallet</th><th>Mode</th><th>Tier</th><th>Size</th><th>Sells</th><th>Last activity</th><th>Errors</th><th></th></tr></thead><tbody>${rows.map(l=>`
  <tr><td><span class="pill ${l.enabled!==false?'green':'red'}">${l.enabled!==false?'ON':'PAUSED'}</span></td><td><b>${esc(l.label||short(l.address))}</b><div class="mono muted">${esc(short(l.address))}</div></td><td>${esc((l.copyMode||'track').toUpperCase())}</td><td>${esc(l.tier||'B')}</td><td>${l.copyBuyPct?`${num(l.copyBuyPct,0)}%`:l.copyBuySol?`${num(l.copyBuySol,3)} SOL`:`${num(store.boot.settings.copyBuySol,3)} SOL`}</td><td>${l.copySells===false?'Off':'On'}</td><td>${l.lastActivityAt?ago(l.lastActivityAt):'—'}</td><td>${num(l.pollErrors,0)}</td><td>
    <button class="table-action leader-edit" data-wallet="${esc(l.address)}">Edit</button>
    <button class="table-action leader-toggle" data-wallet="${esc(l.address)}" data-action="${l.enabled!==false?'pause':'resume'}">${l.enabled!==false?'Pause':'Resume'}</button>
    <button class="table-action danger leader-remove" data-wallet="${esc(l.address)}">Remove</button></td></tr>`).join('')}</tbody></table>`:'<div class="empty-state" style="padding:20px">No wallets configured. Add a wallet in track-only mode first.</div>';
}
function openLeaderEditor(wallet=null){
  const leader=wallet?(store.boot?.leaders||[]).find(l=>l.address===wallet):null;
  qs('#leaderEditor').classList.remove('hidden');
  qs('#leaderEditorTitle').textContent=leader?'Edit wallet':'Add wallet';
  qs('#leaderOriginalWallet').value=leader?.address||'';
  qs('#leaderWallet').value=leader?.address||''; qs('#leaderWallet').disabled=Boolean(leader);
  qs('#leaderLabel').value=leader?.label||'';
  qs('#leaderMode').value=leader?.copyMode||'track';
  qs('#leaderTier').value=leader?.tier||'B';
  qs('#leaderFixed').value=leader?.copyBuySol ?? store.boot?.settings?.copyBuySol ?? .03;
  qs('#leaderPercent').value=leader?.copyBuyPct||0;
  qs('#leaderMinLiq').value=leader?.minLiquidityUsd ?? store.boot?.settings?.minLiquidityUsd ?? 25000;
  qs('#leaderMaxMcap').value=leader?.maxMarketCapUsd ?? store.boot?.settings?.maxMarketCapUsd ?? 0;
  qs('#leaderTp').value=leader?.autoTakeProfitPct||0; qs('#leaderSl').value=leader?.autoStopLossPct||0; qs('#leaderTrail').value=leader?.trailingStopPct||0;
  qs('#leaderCopySells').checked=leader?.copySells!==false; qs('#leaderDuplicates').checked=Boolean(leader?.duplicateBuys);
}

function renderPositions(){
  const p=store.boot?.portfolio||{}, rows=p.positions||[];
  qs('#posCash').textContent=sol(p.cashSol);qs('#posValue').textContent=sol(p.positionsSol);
  qs('#posRealized').textContent=`${Number(p.realizedPnlSol)>=0?'+':''}${num(p.realizedPnlSol,3)} SOL`;qs('#posRealized').className=pnlClass(p.realizedPnlSol);
  qs('#posUnrealized').textContent=`${Number(p.unrealizedPnlSol)>=0?'+':''}${num(p.unrealizedPnlSol,3)} SOL`;qs('#posUnrealized').className=pnlClass(p.unrealizedPnlSol);
  qs('#positionsTable').innerHTML=rows.length?`<table class="data-table"><thead><tr><th>Mint</th><th>Source</th><th>Cost</th><th>Value</th><th>PnL</th><th>Avg price</th><th>Current</th><th></th></tr></thead><tbody>${rows.map(x=>`
  <tr><td class="mono">${esc(short(x.mint))}</td><td>${esc(x.leaderLabel||x.leaderAddress||'Manual')}</td><td>${sol(x.costSol)}</td><td>${sol(x.valueSol)}</td><td class="${pnlClass(x.pnlSol)}">${Number(x.pnlSol)>=0?'+':''}${num(x.pnlSol,3)} SOL (${pct(x.pnlPct)})</td><td>${money(x.avgPriceUsd)}</td><td>${money(x.priceUsd)}</td><td><button class="table-action token-open" data-mint="${esc(x.mint)}">Trade</button></td></tr>`).join('')}</tbody></table>`:'<div class="empty-state" style="padding:20px">No paper positions.</div>';
}
function orderTrigger(o){
  if(o.kind==='dca')return `${o.runsRemaining}/${o.runsTotal} runs · ${o.intervalSec}s`;
  if(o.kind==='trailing-stop')return `${num(o.trailPct,1)}% trail`;
  return `${o.direction||''} ${money(o.target)}`;
}
function renderOrders(){
  const rows=store.boot?.orders||[];
  qs('#ordersTable').innerHTML=rows.length?`<table class="data-table"><thead><tr><th>ID</th><th>Status</th><th>Kind</th><th>Side</th><th>Mint</th><th>Trigger</th><th>Size</th><th>Mode</th><th></th></tr></thead><tbody>${rows.map(o=>`
  <tr><td>#${o.id}</td><td><span class="pill ${o.status==='open'?'green':o.status==='failed'?'red':''}">${esc(o.status)}</span></td><td>${esc(o.kind)}</td><td class="${o.side==='buy'?'positive':'negative'}">${esc((o.side||'').toUpperCase())}</td><td class="mono">${esc(short(o.mint))}</td><td>${esc(orderTrigger(o))}</td><td>${o.side==='buy'?`${num(o.solAmount,3)} SOL`:`${num(o.sellPct,1)}%`}</td><td>${esc((o.mode||'paper').toUpperCase())}</td><td>${o.status==='open'?`<button class="table-action danger order-cancel" data-id="${o.id}">Cancel</button>`:''}</td></tr>`).join('')}</tbody></table>`:'<div class="empty-state" style="padding:20px">No orders yet.</div>';
}

function renderSnipers(){
  const rows=store.boot?.snipers||[], root=qs('#sniperList');
  root.innerHTML=rows.length?rows.map(s=>`<div class="stack-item">
    <span class="pill ${s.enabled!==false?'green':'red'}">${s.enabled!==false?'ON':'PAUSED'}</span>
    <div class="grow"><b>#${s.id} ${esc(s.label||'Sniper')}</b><small>${num(s.solAmount,3)} SOL · ${s.completed||0}/${s.maxSnipes||1} filled · liq ${money(s.minLiquidityUsd)} · max cap ${money(s.maxMarketCapUsd)}</small></div>
    <button class="table-action sniper-toggle" data-id="${s.id}" data-action="${s.enabled!==false?'pause':'resume'}">${s.enabled!==false?'Pause':'Resume'}</button>
    <button class="table-action danger sniper-toggle" data-id="${s.id}" data-action="remove">Remove</button>
  </div>`).join(''):'<div class="empty-state">No sniper setups.</div>';
}

function renderHistory(){
  const rows=store.boot?.history||[];
  qs('#historyTable').innerHTML=rows.length?`<table class="data-table"><thead><tr><th>ID</th><th>Time</th><th>Mode</th><th>Side</th><th>Mint</th><th>SOL</th><th>Price</th><th>Realized PnL</th><th>Source</th></tr></thead><tbody>${rows.map(t=>`
  <tr><td>#${t.id}</td><td>${ago(t.at)} ago</td><td><span class="pill ${t.mode==='LIVE'?'red':'purple'}">${esc(t.mode||'PAPER')}</span></td><td class="${t.side==='BUY'?'positive':'negative'}">${esc(t.side||'')}</td><td class="mono">${esc(short(t.mint))}</td><td>${t.solAmount==null?'—':sol(t.solAmount,4)}</td><td>${t.priceUsd?money(t.priceUsd):'—'}</td><td class="${t.realizedPnlSol==null?'':pnlClass(t.realizedPnlSol)}">${t.realizedPnlSol==null?'—':`${Number(t.realizedPnlSol)>=0?'+':''}${num(t.realizedPnlSol,4)} SOL`}</td><td>${esc(t.leaderLabel||t.source||'—')}</td></tr>`).join('')}</tbody></table>`:'<div class="empty-state" style="padding:20px">No trade history.</div>';
}

function updateTradeFields(){
  qsa('#tradeSideSwitch button').forEach(b=>b.classList.toggle('active',b.dataset.side===store.tradeSide));
  qsa('#tradeTypeSwitch button').forEach(b=>b.classList.toggle('active',b.dataset.type===store.tradeType));
  qs('#marketFields').classList.toggle('hidden',store.tradeType!=='market');
  qs('#limitFields').classList.toggle('hidden',store.tradeType!=='limit');
  qs('#dcaFields').classList.toggle('hidden',store.tradeType!=='dca');
  const buy=store.tradeSide==='buy'; qs('#tradeSideTitle').textContent=buy?'Buy':'Sell';
  qs('#marketAmountLabel').textContent=buy?'Buy amount (SOL)':'Sell amount (%)';
  qs('#marketAmount').value=buy?'0.03':'100'; qs('#quickBuy').classList.toggle('hidden',!buy);qs('#quickSell').classList.toggle('hidden',buy);
  qs('#limitSizeLabel').childNodes[0].textContent=buy?'Buy amount (SOL)':'Sell amount (%)';
  qs('#limitSize').value=buy?'0.03':'100';
  qs('#dcaSizeLabel').childNodes[0].textContent=buy?'Amount per run (SOL)':'Percent per run (%)';
  qs('#dcaSize').value=buy?'0.03':'20';
  updateExecuteLabel();
}
function updateExecuteLabel(){
  const mode=store.tradeMode, side=store.tradeSide, type=store.tradeType;
  qs('#executeTradeBtn').textContent= type==='market'
    ? `Execute ${mode} ${side}`
    : `Create ${mode} ${type} ${side}`;
}

async function executeTrade(){
  const mint=qs('#tradeMint').value.trim(); if(!mint)throw new Error('Load a token first.');
  if(store.tradeMode==='live' && !store.boot?.stats?.liveTradingEnabled)throw new Error('Live trading is disabled in the server environment.');
  if(store.tradeMode==='live' && !confirm('LIVE MODE will submit a real on-chain transaction using the configured wallet. Continue?'))return;
  if(store.tradeType==='market'){
    const amount=Number(qs('#marketAmount').value);
    if(store.tradeSide==='buy') await api('/api/trade/buy',{method:'POST',body:JSON.stringify({mint,solAmount:amount,mode:store.tradeMode})});
    else await api('/api/trade/sell',{method:'POST',body:JSON.stringify({mint,percent:amount,mode:store.tradeMode})});
  } else if(store.tradeType==='limit'){
    const size=Number(qs('#limitSize').value);
    await api('/api/orders/limit',{method:'POST',body:JSON.stringify({
      mint,side:store.tradeSide,direction:qs('#limitDirection').value,targetType:qs('#limitTargetType').value,target:Number(qs('#limitTarget').value),
      solAmount:store.tradeSide==='buy'?size:null,sellPct:store.tradeSide==='sell'?size:null,mode:store.tradeMode
    })});
  } else {
    const size=Number(qs('#dcaSize').value);
    await api('/api/orders/dca',{method:'POST',body:JSON.stringify({
      mint,side:store.tradeSide,solAmount:store.tradeSide==='buy'?size:null,sellPct:store.tradeSide==='sell'?size:null,
      intervalSec:Number(qs('#dcaInterval').value),runs:Number(qs('#dcaRuns').value),mode:store.tradeMode
    })});
  }
  toast(`${store.tradeType.toUpperCase()} ${store.tradeSide.toUpperCase()} submitted`);
  await refreshAll({discover:false});
}

async function analyzeWallet(address){
  const data=await api(`/api/wallet?address=${encodeURIComponent(address)}&limit=120`);
  renderWallet(data,address);gotoView('wallet');
}
function renderWallet(data,address){
  const c=data.copyability||{}, p=data.performance||{}, root=qs('#walletResults');
  const best=(p.best||[]).slice(0,5), worst=(p.worst||[]).slice(0,5);
  root.className='wallet-results';
  root.innerHTML=`<div class="wallet-grid">
    <div class="wallet-card"><span>Copyability</span><strong>${num(c.score,0)}/100</strong><small class="muted">${esc(c.label||'')}</small></div>
    <div class="wallet-card"><span>Observed win rate</span><strong>${num(p.winRate,1)}%</strong><small class="muted">${p.wins||0}W / ${p.losses||0}L</small></div>
    <div class="wallet-card"><span>Realized PnL</span><strong class="${pnlClass(p.realizedPnlSol)}">${Number(p.realizedPnlSol)>=0?'+':''}${num(p.realizedPnlSol,3)} SOL</strong><small class="muted">observed swaps</small></div>
    <div class="wallet-card"><span>Median hold</span><strong>${p.medianHoldSec?ago(Date.now()-p.medianHoldSec*1000):'—'}</strong><small class="muted">${p.parsedSwaps||0}/${p.sampledTransactions||0} swaps parsed</small></div>
  </div>
  <div class="wallet-detail">
    <article class="panel"><div class="panel-head"><div><span class="eyebrow">PROFILE</span><h3>${esc(short(address))}</h3></div><button class="btn primary wallet-add-copy" data-wallet="${esc(address)}">Track wallet</button></div>
      <div class="stack-list">
        <div class="stack-item"><div class="grow"><b>Copyable swaps</b><small>Transactions compatible with the copy parser</small></div><b>${c.copyableSwaps||0}/${c.swapTransactions||0}</b></div>
        <div class="stack-item"><div class="grow"><b>Buy / sell count</b><small>Observed direction mix</small></div><b>${c.buys||0} / ${c.sells||0}</b></div>
        <div class="stack-item"><div class="grow"><b>Median trade</b><small>Observed median size</small></div><b>${num(c.medianTradeSol,3)} SOL</b></div>
        <div class="stack-item"><div class="grow"><b>Unique tokens</b><small>Observed sample diversity</small></div><b>${c.uniqueTokens||0}</b></div>
      </div><p class="muted" style="font-size:10px;line-height:1.6;margin-top:12px">${esc(c.note||p.note||'Observed on-chain estimates are not guaranteed profitability.')}</p>
    </article>
    <article class="panel"><div class="panel-head"><div><span class="eyebrow">REALIZED TOKENS</span><h3>Best / worst observed</h3></div></div>
      <div class="stack-list">${best.map(x=>`<div class="stack-item"><span class="pill green">BEST</span><div class="grow mono">${esc(short(x.mint))}</div><b class="positive">+${num(x.pnlSol,3)} SOL</b></div>`).join('')}${worst.map(x=>`<div class="stack-item"><span class="pill red">WORST</span><div class="grow mono">${esc(short(x.mint))}</div><b class="negative">${num(x.pnlSol,3)} SOL</b></div>`).join('')||'<div class="empty-state">No realized token rows.</div>'}</div>
    </article>
  </div>`;
}

async function globalLookup(value){
  value=String(value||'').trim(); if(!value)return;
  try{await loadToken(value,true);return}catch{}
  await analyzeWallet(value);
}

document.addEventListener('click', async e=>{
  const jump=e.target.closest('[data-jump]'); if(jump){gotoView(jump.dataset.jump);return}
  const nav=e.target.closest('.nav-item'); if(nav){gotoView(nav.dataset.view);return}
  const token=e.target.closest('.token-open'); if(token){try{await loadToken(token.dataset.mint)}catch(err){toast(err.message,'error')}return}
  const leaderEdit=e.target.closest('.leader-edit'); if(leaderEdit){openLeaderEditor(leaderEdit.dataset.wallet);return}
  const leaderToggle=e.target.closest('.leader-toggle'); if(leaderToggle){try{await api('/api/leaders',{method:'POST',body:JSON.stringify({action:leaderToggle.dataset.action,wallet:leaderToggle.dataset.wallet})});await refreshAll({discover:false});toast('Wallet updated')}catch(err){toast(err.message,'error')}return}
  const leaderRemove=e.target.closest('.leader-remove'); if(leaderRemove){if(!confirm('Remove this tracked wallet?'))return;try{await api('/api/leaders',{method:'POST',body:JSON.stringify({action:'remove',wallet:leaderRemove.dataset.wallet})});await refreshAll({discover:false});toast('Wallet removed')}catch(err){toast(err.message,'error')}return}
  const orderCancel=e.target.closest('.order-cancel'); if(orderCancel){try{await api('/api/orders/cancel',{method:'POST',body:JSON.stringify({id:Number(orderCancel.dataset.id)})});await refreshAll({discover:false});toast('Order cancelled')}catch(err){toast(err.message,'error')}return}
  const sniper=e.target.closest('.sniper-toggle'); if(sniper){try{await api('/api/snipers',{method:'POST',body:JSON.stringify({id:Number(sniper.dataset.id),action:sniper.dataset.action})});await refreshAll({discover:false});toast('Sniper updated')}catch(err){toast(err.message,'error')}return}
  const addCopy=e.target.closest('.wallet-add-copy'); if(addCopy){gotoView('copy');openLeaderEditor(addCopy.dataset.wallet);return}
});

qs('#authForm').addEventListener('submit',async e=>{
  e.preventDefault(); store.token=qs('#authToken').value.trim();
  localStorage.setItem('luna_web_token',store.token);
  try{await refreshAll();hideAuth();toast('Terminal unlocked')}catch(err){showAuth(err.message)}
});
qs('#lockBtn').addEventListener('click',()=>{localStorage.removeItem('luna_web_token');store.token='';showAuth()});
qs('#refreshBtn').addEventListener('click',async()=>{try{await refreshAll();toast('Terminal refreshed')}catch(err){toast(err.message,'error')}});
qs('#pauseBtn').addEventListener('click',async()=>{try{const paused=!store.boot.settings.paused;await api('/api/settings',{method:'POST',body:JSON.stringify({paused})});await refreshAll({discover:false});toast(paused?'Engine paused':'Engine resumed')}catch(err){toast(err.message,'error')}});

qs('#globalSearch').addEventListener('submit',async e=>{e.preventDefault();try{await globalLookup(qs('#globalSearchInput').value)}catch(err){toast(err.message,'error')}});
qs('#discoverRefresh').addEventListener('click',async()=>{try{await loadDiscover();toast('Radar refreshed')}catch(err){toast(err.message,'error')}});
qs('#discoverFilter').addEventListener('input',renderDiscover);qs('#discoverSort').addEventListener('change',renderDiscover);

qs('#loadTokenBtn').addEventListener('click',async()=>{try{await loadToken(qs('#tradeMint').value,false)}catch(err){toast(err.message,'error')}});
qs('#tradeMint').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();qs('#loadTokenBtn').click()}});
qsa('#modeSwitch button').forEach(b=>b.addEventListener('click',()=>{
  if(b.dataset.mode==='live' && !store.boot?.stats?.liveTradingEnabled){toast('Live trading is disabled on the server. Paper mode stays selected.','error');return}
  store.tradeMode=b.dataset.mode;renderMode();
}));
qsa('#tradeSideSwitch button').forEach(b=>b.addEventListener('click',()=>{store.tradeSide=b.dataset.side;updateTradeFields()}));
qsa('#tradeTypeSwitch button').forEach(b=>b.addEventListener('click',()=>{store.tradeType=b.dataset.type;updateTradeFields()}));
qsa('#quickBuy button,#quickSell button').forEach(b=>b.addEventListener('click',()=>{qs('#marketAmount').value=b.dataset.value}));
qs('#executeTradeBtn').addEventListener('click',async()=>{try{await executeTrade()}catch(err){toast(err.message,'error')}});
qs('#createExitBtn').addEventListener('click',async()=>{
  try{
    const mint=qs('#tradeMint').value.trim();if(!mint)throw new Error('Load a token first.');
    if(store.tradeMode==='live' && !confirm('Create LIVE automated exit orders?'))return;
    await api('/api/orders/autosell',{method:'POST',body:JSON.stringify({mint,takeProfitPct:Number(qs('#tpPct').value),stopLossPct:Number(qs('#slPct').value),trailingPct:Number(qs('#trailPct').value),sellPct:100,mode:store.tradeMode})});
    await refreshAll({discover:false});toast('Exit profile created');
  }catch(err){toast(err.message,'error')}
});

qs('#addLeaderBtn').addEventListener('click',()=>openLeaderEditor());
qs('#closeLeaderEditor').addEventListener('click',()=>qs('#leaderEditor').classList.add('hidden'));
qs('#leaderEditor').addEventListener('click',e=>{if(e.target===qs('#leaderEditor'))qs('#leaderEditor').classList.add('hidden')});
qs('#leaderForm').addEventListener('submit',async e=>{
  e.preventDefault();
  try{
    const original=qs('#leaderOriginalWallet').value;
    const body={
      action:original?'update':'add',wallet:original||qs('#leaderWallet').value.trim(),label:qs('#leaderLabel').value.trim(),
      mode:qs('#leaderMode').value,tier:qs('#leaderTier').value,copyBuySol:Number(qs('#leaderFixed').value),copyBuyPct:Number(qs('#leaderPercent').value),
      minLiquidityUsd:Number(qs('#leaderMinLiq').value),maxMarketCapUsd:Number(qs('#leaderMaxMcap').value),
      autoTakeProfitPct:Number(qs('#leaderTp').value),autoStopLossPct:Number(qs('#leaderSl').value),trailingStopPct:Number(qs('#leaderTrail').value),
      copySells:qs('#leaderCopySells').checked,duplicateBuys:qs('#leaderDuplicates').checked
    };
    await api('/api/leaders',{method:'POST',body:JSON.stringify(body)});qs('#leaderEditor').classList.add('hidden');await refreshAll({discover:false});toast(original?'Wallet settings saved':'Wallet added');
  }catch(err){toast(err.message,'error')}
});

qs('#walletAnalyzeForm').addEventListener('submit',async e=>{e.preventDefault();try{await analyzeWallet(qs('#walletAnalyzeInput').value.trim())}catch(err){toast(err.message,'error')}});

qs('#paperResetBtn').addEventListener('click',async()=>{
  const raw=prompt('Starting paper balance in SOL','10'); if(raw===null)return;
  try{await api('/api/paper/reset',{method:'POST',body:JSON.stringify({startingSol:Number(raw)})});await refreshAll({discover:false});toast('Paper account reset')}catch(err){toast(err.message,'error')}
});

qs('#sniperForm').addEventListener('submit',async e=>{
  e.preventDefault();
  try{
    await api('/api/snipers',{method:'POST',body:JSON.stringify({action:'add',label:qs('#sniperLabel').value,solAmount:Number(qs('#sniperSol').value),minLiquidityUsd:Number(qs('#sniperMinLiq').value),maxMarketCapUsd:Number(qs('#sniperMaxMcap').value),maxSnipes:Number(qs('#sniperMax').value),mode:'paper'})});
    await refreshAll({discover:false});toast('Paper sniper created');
  }catch(err){toast(err.message,'error')}
});
qs('#addSniperBtn').addEventListener('click',()=>qs('#sniperLabel').focus());

async function boot(){
  updateTradeFields();
  if(!store.token){showAuth();return}
  try{await refreshAll();hideAuth()}catch(err){showAuth(err.message)}
}
boot();

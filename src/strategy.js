import { config } from './config.js';
import { paperBuy, paperSell } from './paper.js';
import { copyBuy, copySell, loadExecutionWallet } from './jupiter.js';
import { getTokenBalanceRaw } from './solana.js';
import { getLatestSolanaProfiles, getTokenIntel } from './market.js';

const MANUAL = 'manual';
const STRATEGY = 'strategy';

function nowIso() { return new Date().toISOString(); }
function clampPct(pct) { return Math.max(0, Math.min(100, Number(pct || 0))); }
function activeOrder(o) { return o && o.status === 'open'; }
function activeSniper(s) { return s && s.enabled !== false && Number(s.completed || 0) < Number(s.maxSnipes || 1); }
function pushLiveHistory(store, row) {
  store.data.tradeHistory.unshift({ id: store.data.nextTradeId++, at: nowIso(), mode: 'LIVE', ...row });
  store.data.tradeHistory = store.data.tradeHistory.slice(0, 500);
  store.save();
}

function ensureMode(mode, automated = false) {
  const m = mode === 'live' ? 'live' : 'paper';
  if (m === 'live' && !config.liveTradingEnabled) throw new Error('Live trading is disabled. Set ENABLE_LIVE_TRADING=true and provide BS58_PRIVATE_KEY first.');
  if (m === 'live' && automated && !config.liveAutomationEnabled) throw new Error('Unattended live automation is disabled. Set ENABLE_LIVE_AUTOMATION=true only after testing in paper mode.');
  return m;
}

async function notify(client, store, text) {
  const id = store.data.settings.alertChannelId;
  if (!id) return;
  try {
    const ch = await client.channels.fetch(id);
    if (ch?.isTextBased()) await ch.send(text);
  } catch {}
}

function paperPositionOpen(store, mint, leaderAddress = null) {
  return store.data.paper.positions.some(p => p.mint === mint && p.tokenAmount > 1e-12 && (!leaderAddress || p.leaderAddress === leaderAddress));
}

export async function executeBuy({ store, mint, solAmount, mode = 'paper', source = MANUAL, automated = false }) {
  const m = ensureMode(mode, automated);
  const amount = Number(solAmount || 0);
  if (!(amount > 0)) throw new Error('Buy amount must be greater than 0 SOL.');
  if (amount > Number(store.data.settings.maxManualTradeSol || 1)) throw new Error(`Buy exceeds max manual/strategy trade (${store.data.settings.maxManualTradeSol} SOL).`);
  if (store.data.blockedMints.includes(mint)) throw new Error('Mint is on Luna blocklist.');

  if (m === 'paper') {
    return { mode: m, ...(await paperBuy({ store, mint, solAmount: amount, leaderAddress: source, leaderLabel: source === MANUAL ? 'Manual' : 'Strategy' })), positionClosed: false };
  }

  const wallet = loadExecutionWallet();
  const settings = { ...store.data.settings, maxTradeSol: Number(store.data.settings.maxManualTradeSol || 1) };
  const r = await copyBuy({ mint, solAmount: amount, wallet, settings });
  const signature = r.result?.signature || r.result?.txid || null;
  pushLiveHistory(store, { side: 'BUY', mint, solAmount: r.solAmount, tokenAmount: null, priceUsd: r.quality?.tokenPriceUsd || null, signature, realizedPnlSol: 0, source, router: r.router || null });
  return { mode: m, solAmount: r.solAmount, signature, info: r.info, quality: r.quality, router: r.router, orderMode: r.orderMode, positionClosed: false };
}

export async function executeSell({ store, mint, percent = 100, mode = 'paper', source = MANUAL, automated = false, leaderAddress = null }) {
  const m = ensureMode(mode, automated);
  const pct = clampPct(percent);
  if (!(pct > 0)) throw new Error('Sell percentage must be greater than 0.');

  if (m === 'paper') {
    let effectiveLeader = leaderAddress;
    let result;
    try {
      result = await paperSell({ store, mint, sellPct: pct / 100, leaderAddress, leaderLabel: source === MANUAL ? 'Manual' : 'Strategy' });
    } catch (e) {
      if (source !== MANUAL || !leaderAddress || !/No paper position/i.test(String(e.message || e))) throw e;
      effectiveLeader = null;
      result = await paperSell({ store, mint, sellPct: pct / 100, leaderAddress: null, leaderLabel: 'Manual' });
    }
    return { mode: m, ...result, positionClosed: !paperPositionOpen(store, mint, effectiveLeader) };
  }

  const wallet = loadExecutionWallet();
  const bal = await getTokenBalanceRaw(wallet.publicKey.toBase58(), mint);
  if (bal.raw <= 0n) throw new Error('Live wallet has no token balance to sell.');
  const raw = pct >= 99.999 ? bal.raw : (bal.raw * BigInt(Math.floor(pct * 10000))) / 1_000_000n;
  if (raw <= 0n) throw new Error('Sell amount rounds to zero.');
  const r = await copySell({ mint, rawAmount: raw, wallet, settings: store.data.settings });
  const signature = r.result?.signature || r.result?.txid || null;
  const remainingRaw = bal.raw - raw;
  pushLiveHistory(store, { side: 'SELL', mint, solAmount: null, tokenAmount: null, priceUsd: null, signature, realizedPnlSol: null, source, router: r.router || null });
  return { mode: m, percent: pct, rawAmount: raw.toString(), remainingRaw: remainingRaw.toString(), signature, router: r.router, orderMode: r.orderMode, positionClosed: remainingRaw <= 0n };
}

export async function createLimitOrder({ store, mint, side, direction, targetType = 'price', target, solAmount = null, sellPct = null, mode = 'paper' }) {
  const m = ensureMode(mode, true);
  const intel = await getTokenIntel(mint);
  if (!intel.priceUsd) throw new Error('Current token price is unavailable.');
  const type = targetType === 'mcap' ? 'mcap' : 'price';
  const dir = direction === 'above' ? 'above' : 'below';
  const value = Number(target || 0);
  if (!(value > 0)) throw new Error('Target must be greater than zero.');
  if (side === 'buy' && !(Number(solAmount) > 0)) throw new Error('Buy limit requires a SOL amount.');
  if (side === 'sell' && !(Number(sellPct) > 0)) throw new Error('Sell limit requires a percentage.');
  const order = { id: store.data.nextOrderId++, kind: 'limit', side, mint, mode: m, status: 'open', direction: dir, targetType: type, target: value, solAmount: side === 'buy' ? Number(solAmount) : null, sellPct: side === 'sell' ? clampPct(sellPct) : null, createdAt: nowIso(), basePriceUsd: intel.priceUsd, baseMarketCapUsd: intel.marketCapUsd || 0, executions: 0 };
  store.data.orders.push(order); store.save(); return order;
}

export async function createDcaOrder({ store, mint, side, solAmount = null, sellPct = null, intervalSec, runs, mode = 'paper' }) {
  const m = ensureMode(mode, true);
  const interval = Math.max(10, Math.floor(Number(intervalSec || 0)));
  const count = Math.max(1, Math.min(100, Math.floor(Number(runs || 1))));
  if (side === 'buy' && !(Number(solAmount) > 0)) throw new Error('DCA buy requires SOL amount per run.');
  if (side === 'sell' && !(Number(sellPct) > 0)) throw new Error('DCA sell requires percent per run.');
  const order = { id: store.data.nextOrderId++, kind: 'dca', side, mint, mode: m, status: 'open', solAmount: side === 'buy' ? Number(solAmount) : null, sellPct: side === 'sell' ? clampPct(sellPct) : null, intervalSec: interval, runsTotal: count, runsRemaining: count, nextRunAt: Date.now(), executions: 0, createdAt: nowIso() };
  store.data.orders.push(order); store.save(); return order;
}

function makeExitOrder(store, { kind, mint, mode, target = null, sellPct = 100, basePriceUsd, groupId, leaderAddress = null, trailPct = null }) {
  return {
    id: store.data.nextOrderId++, kind, side: 'sell', mint, mode, status: 'open',
    ...(kind === 'trailing-stop' ? { trailPct: Number(trailPct), highWaterPriceUsd: basePriceUsd } : { direction: kind === 'stop-loss' ? 'below' : 'above', targetType: 'price', target: Number(target) }),
    sellPct: clampPct(sellPct), basePriceUsd, groupId, groupPolicy: 'position-aware', leaderAddress, createdAt: nowIso(), executions: 0,
  };
}

export async function createAutoSellSet({ store, mint, takeProfitPct = 0, stopLossPct = 0, trailingPct = 0, sellPct = 100, mode = 'paper', leaderAddress = null }) {
  const m = ensureMode(mode, true);
  const intel = await getTokenIntel(mint);
  if (!intel.priceUsd) throw new Error('Current token price is unavailable.');
  const created = [];
  const groupId = `as-${Date.now()}-${store.data.nextOrderId}`;
  const tp = Number(takeProfitPct || 0), sl = Math.abs(Number(stopLossPct || 0)), trail = Math.abs(Number(trailingPct || 0));
  if (tp > 0) created.push(makeExitOrder(store, { kind: 'take-profit', mint, mode: m, target: intel.priceUsd * (1 + tp / 100), sellPct, basePriceUsd: intel.priceUsd, groupId, leaderAddress }));
  if (sl > 0) created.push(makeExitOrder(store, { kind: 'stop-loss', mint, mode: m, target: intel.priceUsd * (1 - sl / 100), sellPct, basePriceUsd: intel.priceUsd, groupId, leaderAddress }));
  if (trail > 0) created.push(makeExitOrder(store, { kind: 'trailing-stop', mint, mode: m, trailPct: trail, sellPct, basePriceUsd: intel.priceUsd, groupId, leaderAddress }));
  if (!created.length) throw new Error('Set at least one take-profit, stop-loss or trailing-stop percentage.');
  store.data.orders.push(...created); store.save(); return created;
}

export async function createExitLadder({ store, mint, tp1Pct = 0, sell1Pct = 25, tp2Pct = 0, sell2Pct = 25, stopLossPct = 0, trailingPct = 0, mode = 'paper', leaderAddress = null }) {
  const m = ensureMode(mode, true);
  const intel = await getTokenIntel(mint);
  if (!intel.priceUsd) throw new Error('Current token price is unavailable.');
  const groupId = `ladder-${Date.now()}-${store.data.nextOrderId}`;
  const created = [];
  if (Number(tp1Pct) > 0) created.push(makeExitOrder(store, { kind: 'take-profit', mint, mode: m, target: intel.priceUsd * (1 + Number(tp1Pct) / 100), sellPct: sell1Pct, basePriceUsd: intel.priceUsd, groupId, leaderAddress }));
  if (Number(tp2Pct) > 0) created.push(makeExitOrder(store, { kind: 'take-profit', mint, mode: m, target: intel.priceUsd * (1 + Number(tp2Pct) / 100), sellPct: sell2Pct, basePriceUsd: intel.priceUsd, groupId, leaderAddress }));
  if (Number(stopLossPct) > 0) created.push(makeExitOrder(store, { kind: 'stop-loss', mint, mode: m, target: intel.priceUsd * (1 - Math.abs(Number(stopLossPct)) / 100), sellPct: 100, basePriceUsd: intel.priceUsd, groupId, leaderAddress }));
  if (Number(trailingPct) > 0) created.push(makeExitOrder(store, { kind: 'trailing-stop', mint, mode: m, trailPct: Math.abs(Number(trailingPct)), sellPct: 100, basePriceUsd: intel.priceUsd, groupId, leaderAddress }));
  if (!created.length) throw new Error('Set at least one TP, stop-loss or trailing-stop value.');
  store.data.orders.push(...created); store.save(); return created;
}

export function cancelOrder(store, id) {
  const order = store.data.orders.find(o => o.id === Number(id) && o.status === 'open');
  if (!order) return null;
  order.status = 'cancelled'; order.closedAt = nowIso(); store.save(); return order;
}
export function listOrders(store, includeClosed = false) { return [...(includeClosed ? store.data.orders : store.data.orders.filter(activeOrder))].sort((a, b) => b.id - a.id); }

export async function createSniper({ store, label, solAmount, minLiquidityUsd = 0, maxMarketCapUsd = 0, maxSnipes = 1, mode = 'paper' }) {
  const m = ensureMode(mode, true);
  const profiles = await getLatestSolanaProfiles(30);
  const setup = { id: store.data.nextSniperId++, label: label || `Sniper ${store.data.nextSniperId - 1}`, mode: m, enabled: true, solAmount: Number(solAmount || 0), minLiquidityUsd: Number(minLiquidityUsd || 0), maxMarketCapUsd: Number(maxMarketCapUsd || 0), maxSnipes: Math.max(1, Math.min(100, Number(maxSnipes || 1))), completed: 0, createdAt: nowIso(), seenMints: profiles.map(x => x.tokenAddress).slice(0, 100) };
  if (!(setup.solAmount > 0)) throw new Error('Sniper buy amount must be greater than 0 SOL.');
  store.data.snipers.push(setup); store.save(); return setup;
}
export function editSniperState(store, id, action) {
  const s = store.data.snipers.find(x => x.id === Number(id));
  if (!s) return null;
  if (action === 'remove') store.data.snipers = store.data.snipers.filter(x => x !== s); else s.enabled = action === 'resume';
  store.save(); return s;
}

function targetHit(order, intel) {
  if (order.kind === 'trailing-stop') {
    if (!intel.priceUsd) return false;
    order.highWaterPriceUsd = Math.max(Number(order.highWaterPriceUsd || 0), intel.priceUsd);
    const stop = order.highWaterPriceUsd * (1 - Number(order.trailPct || 0) / 100);
    order.currentTrigger = stop;
    return intel.priceUsd <= stop;
  }
  const current = order.targetType === 'mcap' ? Number(intel.marketCapUsd || 0) : Number(intel.priceUsd || 0);
  if (!(current > 0)) return false;
  return order.direction === 'above' ? current >= Number(order.target) : current <= Number(order.target);
}

function cancelSiblingExitsIfClosed(store, order, result) {
  if (!order.groupId || result?.positionClosed !== true) return 0;
  let cancelled = 0;
  for (const sibling of store.data.orders) {
    if (sibling !== order && sibling.groupId === order.groupId && sibling.status === 'open') {
      sibling.status = 'cancelled'; sibling.closedAt = nowIso(); sibling.cancelReason = `Position closed by #${order.id}`; cancelled++;
    }
  }
  return cancelled;
}

async function executeStrategyOrder(client, store, order) {
  try {
    const result = order.side === 'buy'
      ? await executeBuy({ store, mint: order.mint, solAmount: order.solAmount, mode: order.mode, source: STRATEGY, automated: true })
      : await executeSell({ store, mint: order.mint, percent: order.sellPct, mode: order.mode, source: STRATEGY, automated: true, leaderAddress: order.leaderAddress || null });
    order.executions = Number(order.executions || 0) + 1;
    order.lastExecutionAt = nowIso();
    if (order.kind === 'dca') {
      order.runsRemaining = Math.max(0, Number(order.runsRemaining || 0) - 1);
      if (order.runsRemaining > 0) order.nextRunAt = Date.now() + Number(order.intervalSec) * 1000;
      else { order.status = 'filled'; order.closedAt = nowIso(); }
    } else {
      order.status = 'filled'; order.closedAt = nowIso(); cancelSiblingExitsIfClosed(store, order, result);
    }
    order.lastError = null; store.save();
    const partial = order.side === 'sell' && result?.positionClosed === false ? ' · remaining position stays protected' : '';
    await notify(client, store, `⚙️ **V5 order #${order.id} filled** · ${order.side.toUpperCase()} \`${order.mint}\` · ${order.mode.toUpperCase()}${partial}${result?.signature ? `\nhttps://solscan.io/tx/${result.signature}` : ''}`);
  } catch (e) {
    order.failures = Number(order.failures || 0) + 1;
    order.lastError = String(e.message || e).slice(0, 500);
    if (order.failures >= 3) { order.status = 'failed'; order.closedAt = nowIso(); }
    else if (order.kind === 'dca') order.nextRunAt = Date.now() + Math.max(30, Number(order.intervalSec || 30)) * 1000;
    store.save();
    if (order.status === 'failed') await notify(client, store, `⚠️ **V5 order #${order.id} failed** after 3 attempts: ${order.lastError}`);
  }
}

async function processOrders(client, store) {
  if (store.data.settings.paused || store.isReady?.() === false) return;
  const open = store.data.orders.filter(activeOrder);
  const dueDca = open.find(o => o.kind === 'dca' && Date.now() >= Number(o.nextRunAt || 0));
  if (dueDca) { await executeStrategyOrder(client, store, dueDca); return; }
  const marketOrders = open.filter(o => o.kind !== 'dca');
  const uniqueMints = [...new Set(marketOrders.map(o => o.mint))];
  const results = await Promise.allSettled(uniqueMints.map(async mint => [mint, await getTokenIntel(mint)]));
  const intelByMint = new Map(results.filter(r => r.status === 'fulfilled').map(r => r.value));
  for (const order of marketOrders) {
    const intel = intelByMint.get(order.mint);
    if (intel && targetHit(order, intel)) { await executeStrategyOrder(client, store, order); return; }
  }
  store.save();
}

async function processSnipers(client, store) {
  if (store.data.settings.paused || store.isReady?.() === false) return;
  const setups = store.data.snipers.filter(activeSniper);
  if (!setups.length) return;
  const profiles = await getLatestSolanaProfiles(30);
  for (const setup of setups) {
    const seen = new Set(setup.seenMints || []);
    const fresh = profiles.filter(p => !seen.has(p.tokenAddress));
    setup.seenMints = [...new Set([...profiles.map(p => p.tokenAddress), ...(setup.seenMints || [])])].slice(0, 150);
    for (const profile of fresh) {
      const mint = profile.tokenAddress;
      if (store.data.blockedMints.includes(mint)) continue;
      let intel;
      try { intel = await getTokenIntel(mint); } catch { continue; }
      if (Number(setup.minLiquidityUsd || 0) > 0 && intel.liquidityUsd < setup.minLiquidityUsd) continue;
      if (Number(setup.maxMarketCapUsd || 0) > 0 && (!intel.marketCapUsd || intel.marketCapUsd > setup.maxMarketCapUsd)) continue;
      if (intel.rugged || (intel.risks || []).some(r => /critical|danger|high/i.test(String(r.level || '')))) continue;
      try {
        const r = await executeBuy({ store, mint, solAmount: setup.solAmount, mode: setup.mode, source: `sniper-${setup.id}`, automated: true });
        setup.completed = Number(setup.completed || 0) + 1;
        setup.lastMint = mint; setup.lastSnipeAt = nowIso(); setup.lastError = null;
        if (setup.completed >= setup.maxSnipes) setup.enabled = false;
        store.save();
        await notify(client, store, `🎯 **V5 launch-profile snipe #${setup.id}** · **${intel.symbol}** · ${setup.mode.toUpperCase()} ${setup.solAmount} SOL\nMint: \`${mint}\`${r?.signature ? `\nhttps://solscan.io/tx/${r.signature}` : ''}`);
        return;
      } catch (e) { setup.lastError = String(e.message || e).slice(0, 400); store.save(); }
    }
  }
  store.save();
}

export function startV4Strategies(client, store) {
  let orderBusy = false, sniperBusy = false;
  setInterval(async () => {
    if (orderBusy) return;
    orderBusy = true;
    try { await processOrders(client, store); } catch (e) { console.error('V5 strategy monitor:', e.message); } finally { orderBusy = false; }
  }, config.strategyPollMs);
  setInterval(async () => {
    if (sniperBusy) return;
    sniperBusy = true;
    try { await processSnipers(client, store); } catch (e) { console.error('V5 launch scanner:', e.message); } finally { sniperBusy = false; }
  }, config.launchPollMs);
}

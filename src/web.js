import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { config } from './config.js';
import { getHeliusStats } from './helius.js';
import { getLatestSignature } from './solana.js';
import { analyzeWallet } from './analytics.js';
import { analyzeWalletPerformance } from './wallet-performance.js';
import { paperPortfolio, resetPaper } from './paper.js';
import { getTokenIntel, getDiscoveryRadar } from './market.js';
import {
  executeBuy,
  executeSell,
  createLimitOrder,
  createDcaOrder,
  createAutoSellSet,
  listOrders,
  cancelOrder,
  createSniper,
  editSniperState,
} from './strategy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const WEB_TOKEN = String(process.env.WEB_ADMIN_TOKEN || '').trim();
const PORT = Number(process.env.PORT || 10000);
const startedAt = Date.now();

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function ok(res, data = {}) { json(res, 200, { ok: true, ...data }); }

function fail(res, status, error, details = null) {
  json(res, status, { ok: false, error: String(error), ...(details ? { details } : {}) });
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function authorized(req) {
  if (!WEB_TOKEN) return false;
  const header = String(req.headers.authorization || '');
  const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return safeEqual(supplied, WEB_TOKEN);
}

function isSolAddress(value) {
  try {
    const s = String(value || '').trim();
    return new PublicKey(s).toBase58() === s;
  } catch { return false; }
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, Number(n))); }

async function readBody(req, limit = 128 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text || '{}');
}

function publicSettings(store) {
  const s = store.data.settings;
  return {
    paused: s.paused,
    paperTrading: s.paperTrading,
    copyBuySol: s.copyBuySol,
    maxTradeSol: s.maxTradeSol,
    maxManualTradeSol: s.maxManualTradeSol,
    maxDailyBuySol: s.maxDailyBuySol,
    minLiquidityUsd: s.minLiquidityUsd,
    maxMarketCapUsd: s.maxMarketCapUsd,
    minOrganicScore: s.minOrganicScore,
    maxEstimatedImpactPct: s.maxEstimatedImpactPct,
    maxEntryDelaySec: s.maxEntryDelaySec,
    skipExistingPosition: s.skipExistingPosition,
    minLeaderBuySol: s.minLeaderBuySol,
    signalMinWallets: s.signalMinWallets,
    signalMinWeight: s.signalMinWeight,
    signalWindowSec: s.signalWindowSec,
    signalCooldownSec: s.signalCooldownSec,
  };
}

function tierWeight(tier) {
  return tier === 'A' ? 1.5 : tier === 'C' ? 0.75 : 1;
}

function leaderDefaults() {
  return {
    copyBuyPct: 0,
    copySells: true,
    duplicateBuys: false,
    minLeaderBuySol: null,
    minLiquidityUsd: null,
    minMarketCapUsd: null,
    maxMarketCapUsd: null,
    maxChasePct: null,
    minAlphaScore: null,
    autoTakeProfitPct: 0,
    autoStopLossPct: 0,
    trailingStopPct: 0,
  };
}

async function addLeader(store, body) {
  const wallet = String(body.wallet || body.address || '').trim();
  if (!isSolAddress(wallet)) throw new Error('Invalid Solana wallet address.');
  if (store.data.leaders.some(l => l.address === wallet)) throw new Error('Wallet is already being tracked.');
  let latest = null;
  try { latest = await getLatestSignature(wallet); } catch {}
  const tier = ['A', 'B', 'C'].includes(body.tier) ? body.tier : 'B';
  const mode = body.mode === 'track' ? 'track' : 'paper';
  const leader = {
    ...leaderDefaults(),
    address: wallet,
    label: String(body.label || `Trader ${wallet.slice(0, 4)}`).slice(0, 60),
    enabled: true,
    copyMode: mode,
    copyBuySol: body.copyBuySol == null ? null : Number(body.copyBuySol),
    tier,
    weight: Number(body.weight || tierWeight(tier)),
    lastSignature: latest?.signature || null,
    lastTimestamp: Number(latest?.blockTime || 0),
    lastActivityAt: 0,
    nextPollAt: 0,
    pollErrors: 0,
  };
  applyLeaderPatch(leader, body);
  store.data.leaders.push(leader);
  store.save();
  return leader;
}

function applyLeaderPatch(leader, body) {
  if (body.label != null) leader.label = String(body.label).slice(0, 60);
  if (['paper', 'track'].includes(body.mode)) leader.copyMode = body.mode;
  if (['A', 'B', 'C'].includes(body.tier)) leader.tier = body.tier;
  if (body.weight != null) leader.weight = clamp(body.weight, 0.1, 10);
  if (body.copyBuySol != null) leader.copyBuySol = Math.max(0, Number(body.copyBuySol));
  if (body.copyBuyPct != null) leader.copyBuyPct = clamp(body.copyBuyPct, 0, 1000);
  if (body.copySells != null) leader.copySells = Boolean(body.copySells);
  if (body.duplicateBuys != null) leader.duplicateBuys = Boolean(body.duplicateBuys);
  for (const key of ['minLeaderBuySol','minLiquidityUsd','minMarketCapUsd','maxMarketCapUsd','maxChasePct','minAlphaScore','autoTakeProfitPct','autoStopLossPct','trailingStopPct']) {
    if (body[key] !== undefined) leader[key] = body[key] === null || body[key] === '' ? null : Math.max(0, Number(body[key]));
  }
  if (body.enabled != null) leader.enabled = Boolean(body.enabled);
  if (leader.copyBuySol != null && leader.copyBuySol > 0 && leader.copyBuySol > 50) throw new Error('Copy buy size is unreasonably high.');
  return leader;
}

async function bootstrap(store) {
  const portfolio = await paperPortfolio(store);
  const h = getHeliusStats();
  store.resetDailyIfNeeded();
  const wins = store.data.tradeHistory.filter(t => t.side === 'SELL' && Number(t.realizedPnlSol) > 0).length;
  const losses = store.data.tradeHistory.filter(t => t.side === 'SELL' && Number(t.realizedPnlSol) < 0).length;
  return {
    portfolio,
    leaders: store.data.leaders,
    orders: listOrders(store, true).slice(0, 100),
    snipers: store.data.snipers,
    watchlist: store.data.watchlist,
    blockedMints: store.data.blockedMints,
    history: store.data.tradeHistory.slice(0, 100),
    signals: store.data.signalHistory.slice(0, 60),
    settings: publicSettings(store),
    stats: {
      wins,
      losses,
      winRate: wins + losses ? (wins / (wins + losses)) * 100 : 0,
      activeLeaders: store.data.leaders.filter(l => l.enabled !== false).length,
      openOrders: store.data.orders.filter(o => o.status === 'open').length,
      enabledSnipers: store.data.snipers.filter(s => s.enabled !== false).length,
      heliusRequests: h.requests,
      helius429s: h.rateLimited,
      heliusCoolingDown: h.coolingDown,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      liveTradingEnabled: config.liveTradingEnabled,
      liveAutomationEnabled: config.liveAutomationEnabled,
      authConfigured: Boolean(WEB_TOKEN),
    },
  };
}

async function serveStatic(req, res, pathname) {
  const routes = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  };
  const row = routes[pathname];
  if (!row) return false;
  try {
    const content = await fs.readFile(path.join(PUBLIC_DIR, row[0]));
    res.writeHead(200, {
      'content-type': row[1],
      'cache-control': pathname === '/' ? 'no-cache' : 'public, max-age=60',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; img-src 'self' data: https:; frame-src https://dexscreener.com; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:;",
    });
    res.end(content);
  } catch (e) {
    fail(res, 500, e.message);
  }
  return true;
}

function requireAuth(req, res) {
  if (authorized(req)) return true;
  if (!WEB_TOKEN) fail(res, 503, 'WEB_ADMIN_TOKEN is not configured. Set it before enabling private dashboard data or trading.');
  else fail(res, 401, 'Invalid or missing dashboard access key.');
  return false;
}

async function handleApi(req, res, url, store) {
  const pathname = url.pathname;

  if (pathname === '/api/session' && req.method === 'GET') {
    return ok(res, { authRequired: true, authConfigured: Boolean(WEB_TOKEN) });
  }

  if (!requireAuth(req, res)) return;

  if (pathname === '/api/bootstrap' && req.method === 'GET') {
    return ok(res, await bootstrap(store));
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    const h = getHeliusStats();
    return ok(res, {
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      persistence: store.getPersistenceStatus?.() || null,
      helius: h,
      liveTradingEnabled: config.liveTradingEnabled,
      liveAutomationEnabled: config.liveAutomationEnabled,
    });
  }

  if (pathname === '/api/discover' && req.method === 'GET') {
    const limit = clamp(url.searchParams.get('limit') || 12, 1, 30);
    return ok(res, { rows: await getDiscoveryRadar(limit) });
  }

  if (pathname === '/api/token' && req.method === 'GET') {
    const mint = String(url.searchParams.get('mint') || '').trim();
    if (!isSolAddress(mint)) return fail(res, 400, 'Invalid Solana mint.');
    return ok(res, { token: await getTokenIntel(mint) });
  }

  if (pathname === '/api/wallet' && req.method === 'GET') {
    const address = String(url.searchParams.get('address') || '').trim();
    const limit = clamp(url.searchParams.get('limit') || 100, 20, 200);
    if (!isSolAddress(address)) return fail(res, 400, 'Invalid Solana wallet.');
    const [copyability, performance] = await Promise.all([
      analyzeWallet(address, limit),
      analyzeWalletPerformance(address, limit),
    ]);
    return ok(res, { copyability, performance });
  }

  const body = await readBody(req);

  if (pathname === '/api/trade/buy' && req.method === 'POST') {
    const mint = String(body.mint || '').trim();
    if (!isSolAddress(mint)) return fail(res, 400, 'Invalid Solana mint.');
    const mode = body.mode === 'live' ? 'live' : 'paper';
    const solAmount = Number(body.solAmount);
    if (!(solAmount > 0)) return fail(res, 400, 'SOL amount must be greater than zero.');
    const result = await executeBuy({ store, mint, solAmount, mode, source: 'web', automated: false });
    return ok(res, { result });
  }

  if (pathname === '/api/trade/sell' && req.method === 'POST') {
    const mint = String(body.mint || '').trim();
    if (!isSolAddress(mint)) return fail(res, 400, 'Invalid Solana mint.');
    const mode = body.mode === 'live' ? 'live' : 'paper';
    const percent = clamp(body.percent || 100, 0.01, 100);
    const result = await executeSell({
      store,
      mint,
      percent,
      mode,
      source: 'web',
      automated: false,
      leaderAddress: null,
    });
    return ok(res, { result });
  }

  if (pathname === '/api/orders/limit' && req.method === 'POST') {
    const mint = String(body.mint || '').trim();
    if (!isSolAddress(mint)) return fail(res, 400, 'Invalid Solana mint.');
    const order = await createLimitOrder({
      store,
      mint,
      side: body.side === 'sell' ? 'sell' : 'buy',
      direction: body.direction === 'above' ? 'above' : 'below',
      targetType: body.targetType === 'mcap' ? 'mcap' : 'price',
      target: Number(body.target),
      solAmount: body.solAmount == null ? null : Number(body.solAmount),
      sellPct: body.sellPct == null ? null : Number(body.sellPct),
      mode: body.mode === 'live' ? 'live' : 'paper',
    });
    return ok(res, { order });
  }

  if (pathname === '/api/orders/dca' && req.method === 'POST') {
    const mint = String(body.mint || '').trim();
    if (!isSolAddress(mint)) return fail(res, 400, 'Invalid Solana mint.');
    const order = await createDcaOrder({
      store,
      mint,
      side: body.side === 'sell' ? 'sell' : 'buy',
      solAmount: body.solAmount == null ? null : Number(body.solAmount),
      sellPct: body.sellPct == null ? null : Number(body.sellPct),
      intervalSec: Number(body.intervalSec),
      runs: Number(body.runs),
      mode: body.mode === 'live' ? 'live' : 'paper',
    });
    return ok(res, { order });
  }

  if (pathname === '/api/orders/autosell' && req.method === 'POST') {
    const mint = String(body.mint || '').trim();
    if (!isSolAddress(mint)) return fail(res, 400, 'Invalid Solana mint.');
    const orders = await createAutoSellSet({
      store,
      mint,
      takeProfitPct: Number(body.takeProfitPct || 0),
      stopLossPct: Number(body.stopLossPct || 0),
      trailingPct: Number(body.trailingPct || 0),
      sellPct: Number(body.sellPct || 100),
      mode: body.mode === 'live' ? 'live' : 'paper',
    });
    return ok(res, { orders });
  }

  if (pathname === '/api/orders/cancel' && req.method === 'POST') {
    const order = cancelOrder(store, Number(body.id));
    if (!order) return fail(res, 404, 'Open order not found.');
    return ok(res, { order });
  }

  if (pathname === '/api/leaders' && req.method === 'POST') {
    const action = String(body.action || 'add');
    if (action === 'add') return ok(res, { leader: await addLeader(store, body) });
    const wallet = String(body.wallet || body.address || '').trim();
    const leader = store.data.leaders.find(l => l.address === wallet);
    if (!leader) return fail(res, 404, 'Tracked wallet not found.');
    if (action === 'remove') {
      store.data.leaders = store.data.leaders.filter(l => l !== leader);
      store.save();
      return ok(res);
    }
    if (action === 'pause') leader.enabled = false;
    else if (action === 'resume') { leader.enabled = true; leader.nextPollAt = 0; }
    else if (action === 'update') applyLeaderPatch(leader, body);
    else return fail(res, 400, 'Unknown leader action.');
    store.save();
    return ok(res, { leader });
  }

  if (pathname === '/api/watchlist' && req.method === 'POST') {
    const mint = String(body.mint || '').trim();
    if (!isSolAddress(mint)) return fail(res, 400, 'Invalid Solana mint.');
    if (body.action === 'remove') {
      store.data.watchlist = store.data.watchlist.filter(x => x.mint !== mint);
    } else if (!store.data.watchlist.some(x => x.mint === mint)) {
      store.data.watchlist.unshift({ mint, label: body.label ? String(body.label).slice(0, 50) : null, addedAt: new Date().toISOString() });
    }
    store.save();
    return ok(res, { watchlist: store.data.watchlist });
  }

  if (pathname === '/api/snipers' && req.method === 'POST') {
    const action = String(body.action || 'add');
    if (action === 'add') {
      const sniper = await createSniper({
        store,
        label: String(body.label || 'Web Sniper').slice(0, 60),
        solAmount: Number(body.solAmount),
        minLiquidityUsd: Number(body.minLiquidityUsd || 0),
        maxMarketCapUsd: Number(body.maxMarketCapUsd || 0),
        maxSnipes: Number(body.maxSnipes || 1),
        mode: body.mode === 'live' ? 'live' : 'paper',
      });
      return ok(res, { sniper });
    }
    const sniper = editSniperState(store, Number(body.id), action);
    if (!sniper) return fail(res, 404, 'Sniper not found.');
    return ok(res, { sniper });
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    const s = store.data.settings;
    const allowed = {
      paused: 'bool',
      paperTrading: 'bool',
      copyBuySol: 'num',
      maxTradeSol: 'num',
      maxManualTradeSol: 'num',
      maxDailyBuySol: 'num',
      minLiquidityUsd: 'num',
      maxMarketCapUsd: 'num',
      minOrganicScore: 'num',
      maxEntryDelaySec: 'num',
      minLeaderBuySol: 'num',
      signalMinWallets: 'num',
      signalMinWeight: 'num',
      signalWindowSec: 'num',
      signalCooldownSec: 'num',
    };
    for (const [key, type] of Object.entries(allowed)) {
      if (body[key] === undefined) continue;
      s[key] = type === 'bool' ? Boolean(body[key]) : Math.max(0, Number(body[key]));
    }
    if (s.copyBuySol > s.maxTradeSol) s.copyBuySol = s.maxTradeSol;
    store.save();
    return ok(res, { settings: publicSettings(store) });
  }

  if (pathname === '/api/paper/reset' && req.method === 'POST') {
    resetPaper(store, Number(body.startingSol || 10));
    return ok(res, { portfolio: await paperPortfolio(store) });
  }

  return fail(res, 404, 'API route not found.');
}

export function startWebTerminal(store) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, store);
      if (await serveStatic(req, res, url.pathname)) return;
      if (req.method === 'GET') return await serveStatic(req, res, '/');
      return fail(res, 404, 'Not found.');
    } catch (e) {
      console.error('Web terminal error:', e);
      return fail(res, 500, e.message || 'Internal error');
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Luna web terminal listening on :${PORT}`);
    if (!WEB_TOKEN) console.warn('WEB_ADMIN_TOKEN is not configured; private API access is disabled.');
  });
  return server;
}

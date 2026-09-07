import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'state.json');

const defaults = {
  schemaVersion: 5,
  leaders: [],
  priceAlerts: [],
  nextPriceAlertId: 1,
  nextTradeId: 1,
  nextOrderId: 1,
  nextSniperId: 1,
  tradeHistory: [],
  signalHistory: [],
  orders: [],
  snipers: [],
  watchlist: [],
  blockedMints: [],
  paper: { startingSol: 10, cashSol: 10, realizedPnlSol: 0, positions: [] },
  settings: {
    alertChannelId: null,
    paperTrading: true,
    paused: false,
    buyAlerts: true,
    sellAlerts: true,
    skippedAlerts: false,

    copyBuySol: 0.03,
    maxTradeSol: 0.10,
    maxManualTradeSol: 1.0,
    maxDailyBuySol: 0.30,
    minLiquidityUsd: 25000,
    maxMarketCapUsd: 0,
    minOrganicScore: 0,
    maxEstimatedImpactPct: 8,
    maxEntryDelaySec: 45,
    skipExistingPosition: true,
    sellMode: 'proportional',

    // V5 entry quality. Defaults are deliberately meaningful for paper mode;
    // they can be loosened with /v5risk while results are evaluated.
    maxChasePct: 12,
    minAlphaScore: 60,
    maxQuoteAgeMs: 2500,
    fixedSlippageBps: 0,

    minLeaderBuySol: 0.02,
    signalMinWallets: 1,
    signalMinWeight: 1,
    signalWindowSec: 120,
    signalCooldownSec: 300,
  },
  daily: { date: '', boughtSol: 0 },
};

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function tierWeight(tier) { return tier === 'A' ? 1.5 : tier === 'C' ? 0.75 : 1; }

function normalizeLeader(l = {}) {
  const tier = ['A', 'B', 'C'].includes(l.tier) ? l.tier : 'B';
  const parsedWeight = Number(l.weight);
  return {
    ...l,
    enabled: l.enabled !== false,
    copyMode: ['paper', 'track'].includes(l.copyMode) ? l.copyMode : 'paper',
    copyBuySol: l.copyBuySol ?? null,
    copyBuyPct: Number.isFinite(Number(l.copyBuyPct)) ? Number(l.copyBuyPct) : 0,
    copySells: l.copySells !== false,
    duplicateBuys: l.duplicateBuys === true,
    minLeaderBuySol: l.minLeaderBuySol == null ? null : Number(l.minLeaderBuySol),
    minLiquidityUsd: l.minLiquidityUsd == null ? null : Number(l.minLiquidityUsd),
    minMarketCapUsd: l.minMarketCapUsd == null ? null : Number(l.minMarketCapUsd),
    maxMarketCapUsd: l.maxMarketCapUsd == null ? null : Number(l.maxMarketCapUsd),
    maxChasePct: l.maxChasePct == null ? null : Number(l.maxChasePct),
    minAlphaScore: l.minAlphaScore == null ? null : Number(l.minAlphaScore),
    autoTakeProfitPct: Number(l.autoTakeProfitPct || 0),
    autoStopLossPct: Number(l.autoStopLossPct || 0),
    trailingStopPct: Number(l.trailingStopPct || 0),
    tier,
    weight: Number.isFinite(parsedWeight) && parsedWeight > 0 ? parsedWeight : tierWeight(tier),
    lastSignature: l.lastSignature || null,
    lastTimestamp: Number(l.lastTimestamp || 0),
    lastActivityAt: Number(l.lastActivityAt || 0),
    nextPollAt: Number(l.nextPollAt || 0),
    pollErrors: Number(l.pollErrors || 0),
  };
}

function normalizeOrder(o = {}) {
  return {
    ...o,
    id: Number(o.id || 0),
    status: ['open', 'filled', 'cancelled', 'failed'].includes(o.status) ? o.status : 'open',
    mode: o.mode === 'live' ? 'live' : 'paper',
    executions: Number(o.executions || 0),
    failures: Number(o.failures || 0),
  };
}

function normalizeSniper(s = {}) {
  return {
    ...s,
    id: Number(s.id || 0),
    mode: s.mode === 'live' ? 'live' : 'paper',
    enabled: s.enabled !== false,
    completed: Number(s.completed || 0),
    maxSnipes: Math.max(1, Number(s.maxSnipes || 1)),
    seenMints: Array.isArray(s.seenMints) ? s.seenMints.slice(0, 150) : [],
  };
}

export class StateStore {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.remote = { mode: 'local', ready: true, error: null, updatedAt: null };
    this.pool = null;
    this.pendingRemoteSnapshot = null;
    this.remoteFlushTimer = null;
    this.remoteFlushing = false;
    this.data = this.load();
    this.readyPromise = this.initRemote().catch(e => {
      this.remote = { mode: 'local-fallback', ready: true, error: String(e.message || e), updatedAt: null };
      console.warn('V5 persistence fallback:', e.message || e);
    });
  }

  normalize(parsed = {}) {
    const data = {
      ...clone(defaults),
      ...parsed,
      schemaVersion: 5,
      leaders: (parsed.leaders || []).map(normalizeLeader),
      settings: { ...defaults.settings, ...(parsed.settings || {}) },
      daily: { ...defaults.daily, ...(parsed.daily || {}) },
      paper: { ...defaults.paper, ...(parsed.paper || {}), positions: parsed.paper?.positions || [] },
      tradeHistory: parsed.tradeHistory || [],
      signalHistory: parsed.signalHistory || [],
      orders: (parsed.orders || []).map(normalizeOrder),
      snipers: (parsed.snipers || []).map(normalizeSniper),
      watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : [],
      blockedMints: parsed.blockedMints || [],
    };
    const maxOrder = Math.max(0, ...data.orders.map(o => Number(o.id || 0)));
    const maxSniper = Math.max(0, ...data.snipers.map(s => Number(s.id || 0)));
    data.nextOrderId = Math.max(Number(data.nextOrderId || 1), maxOrder + 1);
    data.nextSniperId = Math.max(Number(data.nextSniperId || 1), maxSniper + 1);
    return data;
  }

  load() {
    if (!fs.existsSync(FILE)) return clone(defaults);
    try { return this.normalize(JSON.parse(fs.readFileSync(FILE, 'utf8'))); }
    catch { return clone(defaults); }
  }

  saveLocal() {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, FILE);
  }

  async initRemote() {
    const url = process.env.DATABASE_URL;
    if (!url) return;
    this.remote = { mode: 'postgres', ready: false, error: null, updatedAt: null };
    const { Pool } = await import('pg');
    const ssl = String(process.env.DATABASE_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: false } : undefined;
    this.pool = new Pool({ connectionString: url, ...(ssl ? { ssl } : {}) });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS luna_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const result = await this.pool.query('SELECT data, updated_at FROM luna_state WHERE id = $1', ['primary']);
    if (result.rows[0]?.data) {
      this.data = this.normalize(result.rows[0].data);
      this.saveLocal();
      this.remote.updatedAt = result.rows[0].updated_at || null;
    } else {
      await this.pool.query(
        'INSERT INTO luna_state(id, data, updated_at) VALUES($1, $2::jsonb, NOW()) ON CONFLICT(id) DO NOTHING',
        ['primary', JSON.stringify(this.data)],
      );
    }
    this.remote.ready = true;
    this.remote.error = null;
  }

  whenReady() { return this.readyPromise; }
  isReady() { return this.remote.ready !== false; }
  getPersistenceStatus() { return { ...this.remote }; }

  queueRemoteSave() {
    if (!this.pool || !this.remote.ready) return;
    this.pendingRemoteSnapshot = JSON.stringify(this.data);
    if (this.remoteFlushTimer) return;
    this.remoteFlushTimer = setTimeout(() => {
      this.remoteFlushTimer = null;
      this.flushRemote().catch(e => {
        this.remote.error = String(e.message || e);
        console.warn('V5 Postgres state write:', e.message || e);
      });
    }, 150);
  }

  async flushRemote() {
    if (this.remoteFlushing || !this.pool || !this.pendingRemoteSnapshot) return;
    this.remoteFlushing = true;
    try {
      while (this.pendingRemoteSnapshot) {
        const snapshot = this.pendingRemoteSnapshot;
        this.pendingRemoteSnapshot = null;
        await this.pool.query(
          `INSERT INTO luna_state(id, data, updated_at) VALUES($1, $2::jsonb, NOW())
           ON CONFLICT(id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          ['primary', snapshot],
        );
        this.remote.updatedAt = new Date().toISOString();
        this.remote.error = null;
      }
    } finally { this.remoteFlushing = false; }
  }

  save() {
    this.saveLocal();
    this.queueRemoteSave();
  }

  resetDailyIfNeeded() {
    const date = new Date().toISOString().slice(0, 10);
    if (this.data.daily.date !== date) {
      this.data.daily = { date, boughtSol: 0 };
      this.save();
    }
  }

  pushSignal(row) {
    this.data.signalHistory.unshift({ at: new Date().toISOString(), ...row });
    this.data.signalHistory = this.data.signalHistory.slice(0, 300);
    this.save();
  }
}

import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'state.json');

const defaults = {
  schemaVersion: 3,
  leaders: [],
  priceAlerts: [],
  nextPriceAlertId: 1,
  nextTradeId: 1,
  tradeHistory: [],
  signalHistory: [],
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
    maxDailyBuySol: 0.30,
    minLiquidityUsd: 25000,
    maxMarketCapUsd: 0,
    minOrganicScore: 0,
    maxEstimatedImpactPct: 8,
    maxEntryDelaySec: 45,
    skipExistingPosition: true,
    sellMode: 'proportional',

    // V3 signal engine. Defaults preserve one-wallet copy behaviour while
    // allowing consensus mode to be enabled from Discord.
    minLeaderBuySol: 0.02,
    signalMinWallets: 1,
    signalMinWeight: 1,
    signalWindowSec: 120,
    signalCooldownSec: 300,
  },
  daily: { date: '', boughtSol: 0 },
};

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function tierWeight(tier) {
  if (tier === 'A') return 1.5;
  if (tier === 'C') return 0.75;
  return 1;
}

function normalizeLeader(l = {}) {
  const tier = ['A', 'B', 'C'].includes(l.tier) ? l.tier : 'B';
  const parsedWeight = Number(l.weight);
  return {
    ...l,
    enabled: l.enabled !== false,
    copyMode: ['paper', 'track'].includes(l.copyMode) ? l.copyMode : 'paper',
    copyBuySol: l.copyBuySol ?? null,
    tier,
    weight: Number.isFinite(parsedWeight) && parsedWeight > 0 ? parsedWeight : tierWeight(tier),
    lastSignature: l.lastSignature || null,
    lastTimestamp: Number(l.lastTimestamp || 0),
    lastActivityAt: Number(l.lastActivityAt || 0),
    nextPollAt: Number(l.nextPollAt || 0),
    pollErrors: Number(l.pollErrors || 0),
  };
}

export class StateStore {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.data = this.load();
  }

  load() {
    if (!fs.existsSync(FILE)) return clone(defaults);
    try {
      const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return {
        ...clone(defaults),
        ...parsed,
        schemaVersion: 3,
        leaders: (parsed.leaders || []).map(normalizeLeader),
        settings: { ...defaults.settings, ...(parsed.settings || {}) },
        daily: { ...defaults.daily, ...(parsed.daily || {}) },
        paper: { ...defaults.paper, ...(parsed.paper || {}), positions: parsed.paper?.positions || [] },
        tradeHistory: parsed.tradeHistory || [],
        signalHistory: parsed.signalHistory || [],
        blockedMints: parsed.blockedMints || [],
      };
    } catch {
      return clone(defaults);
    }
  }

  save() {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, FILE);
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
    this.data.signalHistory = this.data.signalHistory.slice(0, 200);
    this.save();
  }
}

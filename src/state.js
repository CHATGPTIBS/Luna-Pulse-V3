import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'state.json');

const defaults = {
  leaders: [],
  priceAlerts: [],
  nextPriceAlertId: 1,
  nextTradeId: 1,
  tradeHistory: [],
  blockedMints: [],
  paper: { startingSol: 10, cashSol: 10, realizedPnlSol: 0, positions: [] },
  settings: {
    alertChannelId: null,
    autocopy: false,
    paperTrading: true,
    paused: false,
    buyAlerts: true,
    sellAlerts: true,
    copyBuySol: 0.03,
    maxTradeSol: 0.10,
    maxDailyBuySol: 0.30,
    minLiquidityUsd: 25000,
    maxMarketCapUsd: 0,
    minOrganicScore: 0,
    maxEstimatedImpactPct: 8,
    maxEntryDelaySec: 45,
    skipExistingPosition: true,
    sellMode: 'proportional'
  },
  daily: { date: '', boughtSol: 0 }
};

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function normalizeLeader(l) {
  return {
    enabled: true,
    copyMode: 'paper',
    copyBuySol: null,
    ...l,
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
        leaders: (parsed.leaders || []).map(normalizeLeader),
        settings: { ...defaults.settings, ...(parsed.settings || {}) },
        daily: { ...defaults.daily, ...(parsed.daily || {}) },
        paper: { ...defaults.paper, ...(parsed.paper || {}), positions: parsed.paper?.positions || [] },
        tradeHistory: parsed.tradeHistory || [],
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
}

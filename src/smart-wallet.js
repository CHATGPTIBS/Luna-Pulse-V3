import { analyzeWallet } from './analytics.js';
import { analyzeWalletPerformance } from './wallet-performance.js';

function clamp(n, min, max) { return Math.max(min, Math.min(max, Number(n || 0))); }

export async function scoreTrackedWallet(address, limit = 60) {
  const [copy, pnl] = await Promise.all([
    analyzeWallet(address, limit),
    analyzeWalletPerformance(address, limit),
  ]);

  const closed = Number(pnl.wins || 0) + Number(pnl.losses || 0);
  const winRate = Number(pnl.winRate || 0);
  const pnlSol = Number(pnl.realizedPnlSol || 0);
  const medianHold = Number(pnl.medianHoldSec || 0);
  const sniperLike = closed >= 4 && medianHold > 0 && medianHold < 25;

  const profitability = clamp((pnlSol > 0 ? Math.min(18, pnlSol * 6) : Math.max(-12, pnlSol * 8)) + Math.min(12, winRate * 0.12), 0, 30);
  const consistency = clamp((closed >= 12 ? 8 : closed >= 6 ? 6 : closed >= 3 ? 3 : 0) + Math.max(0, (winRate - 40) * 0.2), 0, 20);
  const copyability = clamp(Number(copy.score || 0) * 0.2, 0, 20);
  const freshness = copy.newestAgeHours == null ? 0 : copy.newestAgeHours < 1 ? 15 : copy.newestAgeHours < 6 ? 12 : copy.newestAgeHours < 24 ? 8 : copy.newestAgeHours < 72 ? 4 : 0;
  let behavior = 15;
  if (sniperLike) behavior -= 8;
  if (Number(copy.medianTradeSol || 0) > 50) behavior -= 3;
  if (Number(pnl.openPositions || 0) > 15) behavior -= 3;
  if (Number(copy.parseRatePct || 0) < 50) behavior -= 4;
  behavior = clamp(behavior, 0, 15);

  const score = Math.round(clamp(profitability + consistency + copyability + freshness + behavior, 0, 100));
  return {
    address,
    score,
    label: score >= 85 ? 'ELITE' : score >= 72 ? 'STRONG' : score >= 60 ? 'WATCH' : score >= 45 ? 'WEAK' : 'AVOID',
    realizedPnlSol: pnlSol,
    winRate,
    closed,
    medianHoldSec: pnl.medianHoldSec,
    medianTradeSol: copy.medianTradeSol,
    parseRatePct: copy.parseRatePct,
    newestAgeHours: copy.newestAgeHours,
    sniperLike,
    breakdown: { profitability, consistency, copyability, freshness, behavior },
  };
}

export async function rankTrackedWallets(store, limit = 10) {
  const leaders = store.data.leaders.filter(l => l.enabled !== false);
  const rows = [];
  // Deliberately sequential: wallet radar is an on-demand analytics command and
  // should not burst Helius hard enough to disturb the live copy monitor.
  for (const leader of leaders.slice(0, 20)) {
    try {
      const score = await scoreTrackedWallet(leader.address, 60);
      rows.push({ ...score, labelName: leader.label || null, tier: leader.tier || 'B', weight: Number(leader.weight || 1) });
    } catch (e) {
      rows.push({ address: leader.address, labelName: leader.label || null, error: String(e.message || e) });
    }
  }
  return rows.filter(x => !x.error).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(20, Number(limit) || 10)));
}

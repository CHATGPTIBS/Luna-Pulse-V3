import { getRecentTransactions } from './helius.js';
import { parseSwap } from './swap.js';

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function median(values) {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export async function analyzeWallet(address, limit = 100) {
  const txs = await getRecentTransactions(address, limit);
  const swapTxs = txs.filter(t => t.type === 'SWAP');
  const parsed = swapTxs.map(t => ({ tx: t, swap: parseSwap(t, address) })).filter(x => x.swap);
  const buys = parsed.filter(x => x.swap.side === 'BUY');
  const sells = parsed.filter(x => x.swap.side === 'SELL');
  const uniqueTokens = new Set(parsed.map(x => x.swap.mint));
  const solSizes = parsed.map(x => Number(x.swap.solAmount || 0)).filter(n => n > 0);
  const newestTs = Math.max(0, ...parsed.map(x => Number(x.tx.timestamp || 0)));
  const ageHours = newestTs ? (Date.now() / 1000 - newestTs) / 3600 : Infinity;
  const parseRate = swapTxs.length ? parsed.length / swapTxs.length : 0;
  const sampleScore = clamp(parsed.length / 40, 0, 1) * 20;
  const freshnessScore = ageHours < 1 ? 15 : ageHours < 6 ? 12 : ageHours < 24 ? 8 : ageHours < 72 ? 4 : 0;
  const copyabilityScore = parseRate * 25;
  const sellFollowthrough = buys.length ? clamp(sells.length / buys.length, 0, 1) * 15 : 0;
  const diversityScore = clamp(uniqueTokens.size / 12, 0, 1) * 10;
  const sizeMedian = median(solSizes);
  const sizeScore = sizeMedian >= 0.02 && sizeMedian <= 25 ? 10 : sizeMedian > 0 ? 5 : 0;
  const activityScore = clamp(parsed.length / Math.max(1, txs.length), 0, 1) * 5;
  const score = Math.round(clamp(sampleScore + freshnessScore + copyabilityScore + sellFollowthrough + diversityScore + sizeScore + activityScore, 0, 100));

  return {
    score,
    label: score >= 85 ? 'Excellent' : score >= 70 ? 'Strong' : score >= 55 ? 'Mixed' : 'Weak',
    transactionsChecked: txs.length,
    swapTransactions: swapTxs.length,
    copyableSwaps: parsed.length,
    buys: buys.length,
    sells: sells.length,
    uniqueTokens: uniqueTokens.size,
    parseRatePct: parseRate * 100,
    medianTradeSol: sizeMedian,
    newestAgeHours: Number.isFinite(ageHours) ? ageHours : null,
    recent: parsed.slice(0, 8).map(x => ({ side: x.swap.side, mint: x.swap.mint, solAmount: x.swap.solAmount, timestamp: x.tx.timestamp, signature: x.tx.signature })),
    note: 'Luna V3 score measures recent activity and how cleanly SOL↔token swaps can be followed. It is a copyability heuristic, not verified profitability or a win-rate guarantee.',
  };
}

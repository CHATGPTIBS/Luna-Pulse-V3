import { getRecentTransactions } from './helius.js';
import { parseSwap } from './swap.js';

export async function analyzeWalletPerformance(address, limit = 100) {
  const txs = await getRecentTransactions(address, Math.max(20, Math.min(100, Number(limit) || 100)));
  const swaps = txs
    .map(tx => ({ tx, swap: parseSwap(tx, address) }))
    .filter(x => x.swap && Number(x.swap.solAmount || 0) > 0)
    .sort((a, b) => Number(a.tx.timestamp || 0) - Number(b.tx.timestamp || 0));

  const positions = new Map();
  const closed = [];
  let realizedPnlSol = 0;
  let totalBuySol = 0;
  let totalSellSol = 0;
  let buys = 0;
  let sells = 0;

  for (const { tx, swap } of swaps) {
    const mint = swap.mint;
    if (swap.side === 'BUY') {
      buys++;
      totalBuySol += Number(swap.solAmount || 0);
      const p = positions.get(mint) || { mint, tokenAmount: 0, costSol: 0, firstBuyAt: Number(tx.timestamp || 0), lastBuyAt: 0 };
      p.tokenAmount += Number(swap.tokenAmount || 0);
      p.costSol += Number(swap.solAmount || 0);
      p.lastBuyAt = Number(tx.timestamp || 0);
      if (!p.firstBuyAt) p.firstBuyAt = p.lastBuyAt;
      positions.set(mint, p);
      continue;
    }

    if (swap.side === 'SELL') {
      sells++;
      totalSellSol += Number(swap.solAmount || 0);
      const p = positions.get(mint);
      if (!p || p.tokenAmount <= 0 || p.costSol <= 0) continue;
      const tokenSold = Math.max(0, Number(swap.tokenAmount || 0));
      const fraction = Math.max(0, Math.min(1, tokenSold / p.tokenAmount));
      if (fraction <= 0) continue;
      const costShare = p.costSol * fraction;
      const proceeds = Number(swap.solAmount || 0);
      const pnlSol = proceeds - costShare;
      realizedPnlSol += pnlSol;
      closed.push({
        mint,
        pnlSol,
        costSol: costShare,
        proceedsSol: proceeds,
        returnPct: costShare > 0 ? (pnlSol / costShare) * 100 : 0,
        holdSec: p.firstBuyAt && tx.timestamp ? Math.max(0, Number(tx.timestamp) - p.firstBuyAt) : null,
        at: Number(tx.timestamp || 0),
        signature: tx.signature,
      });
      p.tokenAmount *= (1 - fraction);
      p.costSol *= (1 - fraction);
      if (p.tokenAmount <= 1e-9 || p.costSol <= 1e-9) positions.delete(mint);
      else positions.set(mint, p);
    }
  }

  const wins = closed.filter(x => x.pnlSol > 0).length;
  const losses = closed.filter(x => x.pnlSol < 0).length;
  const breakeven = closed.length - wins - losses;
  const winRate = wins + losses ? (wins / (wins + losses)) * 100 : 0;
  const holds = closed.map(x => x.holdSec).filter(Number.isFinite).sort((a, b) => a - b);
  const medianHoldSec = holds.length ? holds[Math.floor(holds.length / 2)] : null;
  const openCostSol = [...positions.values()].reduce((sum, p) => sum + Number(p.costSol || 0), 0);
  const tokenStats = new Map();
  for (const row of closed) {
    const t = tokenStats.get(row.mint) || { mint: row.mint, pnlSol: 0, exits: 0, wins: 0 };
    t.pnlSol += row.pnlSol;
    t.exits++;
    if (row.pnlSol > 0) t.wins++;
    tokenStats.set(row.mint, t);
  }

  return {
    address,
    sampledTransactions: txs.length,
    parsedSwaps: swaps.length,
    buys,
    sells,
    totalBuySol,
    totalSellSol,
    realizedPnlSol,
    wins,
    losses,
    breakeven,
    winRate,
    medianHoldSec,
    openPositions: positions.size,
    openCostSol,
    best: [...tokenStats.values()].sort((a, b) => b.pnlSol - a.pnlSol).slice(0, 5),
    worst: [...tokenStats.values()].sort((a, b) => a.pnlSol - b.pnlSol).slice(0, 5),
    recentClosed: [...closed].sort((a, b) => b.at - a.at).slice(0, 10),
    note: 'Observed-window estimate from recent parseable SOL↔token swaps. It is not a complete tax-lot or all-time PnL record.',
  };
}

import { getPrices } from './jupiter.js';
import { WSOL } from './config.js';

function nowIso() { return new Date().toISOString(); }
function position(store, mint, leaderAddress = null) { return store.data.paper.positions.find(p => p.mint === mint && (!leaderAddress || p.leaderAddress === leaderAddress)); }

function pushHistory(store, row) {
  store.data.tradeHistory.unshift({ id: store.data.nextTradeId++, at: nowIso(), ...row });
  store.data.tradeHistory = store.data.tradeHistory.slice(0, 500);
}

export async function paperBuy({ store, mint, solAmount, leaderAddress, leaderLabel, signature = null }) {
  const prices = await getPrices([WSOL, mint]);
  const tokenPrice = Number(prices?.[mint]?.usdPrice || 0);
  const solPrice = Number(prices?.[WSOL]?.usdPrice || 0);
  if (!tokenPrice || !solPrice) throw new Error('Paper trade skipped: price unavailable');
  if (store.data.paper.cashSol < solAmount) throw new Error(`Paper cash only ${store.data.paper.cashSol.toFixed(3)} SOL`);

  const tokenAmount = (solAmount * solPrice) / tokenPrice;
  let p = position(store, mint, leaderAddress);
  if (!p) {
    p = { mint, tokenAmount: 0, costSol: 0, avgPriceUsd: tokenPrice, openedAt: nowIso(), leaderAddress, leaderLabel };
    store.data.paper.positions.push(p);
  }
  const oldUsdCost = p.tokenAmount * p.avgPriceUsd;
  p.tokenAmount += tokenAmount;
  p.costSol += solAmount;
  p.avgPriceUsd = (oldUsdCost + tokenAmount * tokenPrice) / p.tokenAmount;
  p.updatedAt = nowIso();
  store.data.paper.cashSol -= solAmount;
  pushHistory(store, { mode: 'PAPER', side: 'BUY', mint, solAmount, tokenAmount, priceUsd: tokenPrice, leaderAddress, leaderLabel, signature, realizedPnlSol: 0 });
  store.save();
  return { solAmount, tokenAmount, priceUsd: tokenPrice };
}

export async function paperSell({ store, mint, sellPct = 1, leaderAddress, leaderLabel, signature = null }) {
  const p = position(store, mint, leaderAddress);
  if (!p || p.tokenAmount <= 0) throw new Error('No paper position to sell');
  const prices = await getPrices([WSOL, mint]);
  const tokenPrice = Number(prices?.[mint]?.usdPrice || 0);
  const solPrice = Number(prices?.[WSOL]?.usdPrice || 0);
  if (!tokenPrice || !solPrice) throw new Error('Paper sell skipped: price unavailable');

  const pct = Math.max(0, Math.min(1, sellPct));
  const tokenAmount = p.tokenAmount * pct;
  const costSol = p.costSol * pct;
  const proceedsSol = (tokenAmount * tokenPrice) / solPrice;
  const pnlSol = proceedsSol - costSol;

  p.tokenAmount -= tokenAmount;
  p.costSol -= costSol;
  p.updatedAt = nowIso();
  store.data.paper.cashSol += proceedsSol;
  store.data.paper.realizedPnlSol += pnlSol;
  if (p.tokenAmount <= 1e-12) store.data.paper.positions = store.data.paper.positions.filter(x => x !== p);
  pushHistory(store, { mode: 'PAPER', side: 'SELL', mint, solAmount: proceedsSol, tokenAmount, priceUsd: tokenPrice, leaderAddress, leaderLabel, signature, realizedPnlSol: pnlSol });
  store.save();
  return { proceedsSol, tokenAmount, priceUsd: tokenPrice, pnlSol, sellPct: pct };
}

export async function paperPortfolio(store) {
  const positions = store.data.paper.positions;
  const mints = positions.map(p => p.mint);
  let prices = {};
  if (mints.length) { try { prices = await getPrices([WSOL, ...mints]); } catch {} }
  const solPrice = Number(prices?.[WSOL]?.usdPrice || 0);
  let positionsSol = 0;
  let unrealizedPnlSol = 0;
  const rows = [];

  for (const p of positions) {
    const priceUsd = Number(prices?.[p.mint]?.usdPrice || 0);
    const valueSol = solPrice && priceUsd ? (p.tokenAmount * priceUsd) / solPrice : 0;
    const pnlSol = valueSol - p.costSol;
    positionsSol += valueSol;
    unrealizedPnlSol += pnlSol;
    rows.push({ ...p, priceUsd, valueSol, pnlSol, pnlPct: p.costSol > 0 ? (pnlSol / p.costSol) * 100 : 0 });
  }

  return {
    startingSol: store.data.paper.startingSol,
    cashSol: store.data.paper.cashSol,
    positionsSol,
    equitySol: store.data.paper.cashSol + positionsSol,
    realizedPnlSol: store.data.paper.realizedPnlSol,
    unrealizedPnlSol,
    totalPnlSol: store.data.paper.cashSol + positionsSol - store.data.paper.startingSol,
    positions: rows,
  };
}

export function resetPaper(store, startingSol) {
  const value = Math.max(0.1, Number(startingSol || 10));
  store.data.paper = { startingSol: value, cashSol: value, realizedPnlSol: 0, positions: [] };
  store.data.tradeHistory = store.data.tradeHistory.filter(t => t.mode !== 'PAPER');
  store.save();
}

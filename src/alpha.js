function clamp(n, min, max) { return Math.max(min, Math.min(max, Number(n || 0))); }
function pct(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }

function smartMoneyScore(signal = null) {
  if (!signal) return { score: 10, note: 'No live smart-money consensus attached' };
  const wallets = Math.max(0, Number(signal.walletCount || signal.participants?.length || 0));
  const weight = Math.max(0, Number(signal.totalWeight || 0));
  const score = clamp(Math.min(16, wallets * 6) + Math.min(14, weight * 5), 0, 30);
  return { score, note: `${wallets} wallet${wallets === 1 ? '' : 's'} · weight ${weight.toFixed(2)}` };
}

function safetyScore(intel = {}) {
  if (intel.rugged) return { score: 0, note: 'RugCheck rugged flag' };
  let score = 25;
  const risks = Array.isArray(intel.risks) ? intel.risks : [];
  for (const r of risks) {
    const level = String(r.level || '').toLowerCase();
    if (/critical|danger|high/.test(level)) score -= 8;
    else if (/medium|warn/.test(level)) score -= 3;
    else if (/low/.test(level)) score -= 1;
  }
  const top10 = pct(intel.top10HolderPct);
  if (top10 !== null) {
    if (top10 >= 60) score -= 10;
    else if (top10 >= 40) score -= 6;
    else if (top10 >= 25) score -= 3;
  }
  const creator = pct(intel.creatorHoldingPct);
  if (creator !== null) {
    if (creator >= 20) score -= 8;
    else if (creator >= 10) score -= 5;
    else if (creator >= 5) score -= 2;
  }
  if (intel.mintAuthority) score -= 3;
  if (intel.freezeAuthority) score -= 4;
  if (Number(intel.liquidityUsd || 0) < 10000) score -= 5;
  return {
    score: clamp(score, 0, 25),
    note: top10 === null ? 'Holder concentration unavailable' : `Top-10 ${top10.toFixed(1)}%${creator === null ? '' : ` · creator ${creator.toFixed(1)}%`}`,
  };
}

function flowScore(intel = {}) {
  let score = 0;
  const buys = Number(intel.buys5m || 0);
  const sells = Number(intel.sells5m || 0);
  const ratio = buys / Math.max(1, sells);
  if (buys + sells >= 4) {
    if (ratio >= 2.5) score += 8;
    else if (ratio >= 1.5) score += 6;
    else if (ratio >= 1.0) score += 4;
    else if (ratio >= 0.6) score += 2;
  }

  const liq = Math.max(1, Number(intel.liquidityUsd || 0));
  const vol1h = Number(intel.volume1h || 0);
  const turnover = vol1h / liq;
  if (turnover >= 2) score += 7;
  else if (turnover >= 1) score += 6;
  else if (turnover >= 0.4) score += 4;
  else if (turnover >= 0.15) score += 2;

  const move = Number(intel.priceChange1h || 0);
  if (move >= 2 && move <= 35) score += 5;
  else if (move > 35 && move <= 80) score += 3;
  else if (move > 80 && move <= 150) score += 1;
  else if (move < -25 || move > 150) score -= 3;
  return { score: clamp(score, 0, 20), note: `5m B/S ${buys}/${sells} · 1h vol/liq ${turnover.toFixed(2)}x` };
}

function entryScore(chasePct = null) {
  if (!Number.isFinite(Number(chasePct))) return { score: 8, note: 'Leader entry price unavailable' };
  const chase = Number(chasePct);
  let score;
  if (chase <= 0) score = 15;
  else if (chase <= 3) score = 14;
  else if (chase <= 7) score = 12;
  else if (chase <= 12) score = 9;
  else if (chase <= 20) score = 4;
  else score = 0;
  return { score, note: `${chase >= 0 ? '+' : ''}${chase.toFixed(1)}% vs leader entry` };
}

function executionScore(intel = {}, tradeSol = 0, solPriceUsd = 0) {
  const liq = Number(intel.liquidityUsd || 0);
  let score = liq >= 250000 ? 7 : liq >= 100000 ? 6 : liq >= 50000 ? 5 : liq >= 25000 ? 4 : liq >= 10000 ? 2 : 0;
  const tradeUsd = Math.max(0, Number(tradeSol || 0) * Number(solPriceUsd || 0));
  const sizeToLiq = liq > 0 ? tradeUsd / liq : 1;
  if (sizeToLiq <= 0.002) score += 3;
  else if (sizeToLiq <= 0.005) score += 2;
  else if (sizeToLiq <= 0.01) score += 1;
  else if (sizeToLiq > 0.03) score -= 2;
  return { score: clamp(score, 0, 10), note: `${liq ? `$${Math.round(liq).toLocaleString()} liq` : 'liq unavailable'}${tradeUsd ? ` · ${(sizeToLiq * 100).toFixed(2)}% size/liq` : ''}` };
}

export function calculateAlphaScore({ intel = {}, signal = null, chasePct = null, tradeSol = 0, solPriceUsd = 0 } = {}) {
  const smart = smartMoneyScore(signal);
  const safety = safetyScore(intel);
  const flow = flowScore(intel);
  const entry = entryScore(chasePct);
  const execution = executionScore(intel, tradeSol, solPriceUsd);
  const total = Math.round(clamp(smart.score + safety.score + flow.score + entry.score + execution.score, 0, 100));
  const label = total >= 85 ? 'ELITE' : total >= 72 ? 'STRONG' : total >= 60 ? 'WATCH' : total >= 45 ? 'WEAK' : 'AVOID';
  return {
    score: total,
    label,
    breakdown: {
      smartMoney: { ...smart, max: 30 },
      safety: { ...safety, max: 25 },
      flow: { ...flow, max: 20 },
      entry: { ...entry, max: 15 },
      execution: { ...execution, max: 10 },
    },
  };
}

export function formatAlpha(alpha) {
  if (!alpha) return 'Alpha unavailable';
  const b = alpha.breakdown;
  return [
    `**LUNA ALPHA ${alpha.score}/100 — ${alpha.label}**`,
    `Smart money ${b.smartMoney.score.toFixed(0)}/${b.smartMoney.max} · Safety ${b.safety.score.toFixed(0)}/${b.safety.max}`,
    `Flow ${b.flow.score.toFixed(0)}/${b.flow.max} · Entry ${b.entry.score.toFixed(0)}/${b.entry.max} · Execution ${b.execution.score.toFixed(0)}/${b.execution.max}`,
  ].join('\n');
}

import { WSOL } from './config.js';

export function short(address) {
  return address ? `${address.slice(0, 5)}…${address.slice(-5)}` : '—';
}

export function fmt(value, digits = 4) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function parseSwap(tx, wallet) {
  if (tx?.type !== 'SWAP') return null;
  const deltas = new Map();
  let lamports = 0;

  for (const t of tx.nativeTransfers || []) {
    if (t.toUserAccount === wallet) lamports += Number(t.amount || 0);
    if (t.fromUserAccount === wallet) lamports -= Number(t.amount || 0);
  }
  for (const t of tx.tokenTransfers || []) {
    if (!t.mint) continue;
    let delta = deltas.get(t.mint) || 0;
    if (t.toUserAccount === wallet) delta += Number(t.tokenAmount || 0);
    if (t.fromUserAccount === wallet) delta -= Number(t.tokenAmount || 0);
    deltas.set(t.mint, delta);
  }

  let solDelta = lamports / 1e9 + (deltas.get(WSOL) || 0);
  deltas.delete(WSOL);
  const moves = [...deltas.entries()].filter(([, d]) => Math.abs(d) > 0);
  if (!moves.length) return null;

  const positive = moves.filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]);
  const negative = moves.filter(([, d]) => d < 0).sort((a, b) => a[1] - b[1]);

  if (solDelta < -0.00001 && positive.length) {
    const [mint, tokenAmount] = positive[0];
    return { side: 'BUY', mint, tokenAmount, solAmount: Math.abs(solDelta) };
  }
  if (solDelta > 0.00001 && negative.length) {
    const [mint, amount] = negative[0];
    return { side: 'SELL', mint, tokenAmount: Math.abs(amount), solAmount: solDelta };
  }
  return null;
}

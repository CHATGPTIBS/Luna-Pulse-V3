import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAlphaScore } from '../src/alpha.js';

const strongIntel = {
  liquidityUsd: 150000,
  volume1h: 220000,
  buys5m: 40,
  sells5m: 15,
  priceChange1h: 18,
  rugged: false,
  risks: [],
  top10HolderPct: 18,
  creatorHoldingPct: 1.5,
  mintAuthority: null,
  freezeAuthority: null,
};

test('strong consensus and clean entry scores highly', () => {
  const alpha = calculateAlphaScore({
    intel: strongIntel,
    signal: { walletCount: 3, totalWeight: 4.2 },
    chasePct: 2,
    tradeSol: 0.1,
    solPriceUsd: 180,
  });
  assert.ok(alpha.score >= 80, `expected >=80, got ${alpha.score}`);
  assert.match(alpha.label, /ELITE|STRONG/);
});

test('chasing a pumped entry is penalized', () => {
  const early = calculateAlphaScore({ intel: strongIntel, signal: { walletCount: 2, totalWeight: 3 }, chasePct: 3, tradeSol: 0.1, solPriceUsd: 180 });
  const chased = calculateAlphaScore({ intel: strongIntel, signal: { walletCount: 2, totalWeight: 3 }, chasePct: 35, tradeSol: 0.1, solPriceUsd: 180 });
  assert.ok(early.score - chased.score >= 10, `expected meaningful chase penalty: ${early.score} vs ${chased.score}`);
});

test('rugged and concentrated token scores lower', () => {
  const risky = calculateAlphaScore({
    intel: { ...strongIntel, rugged: true, top10HolderPct: 80, creatorHoldingPct: 25, mintAuthority: 'x', freezeAuthority: 'y' },
    signal: { walletCount: 2, totalWeight: 3 },
    chasePct: 2,
    tradeSol: 0.1,
    solPriceUsd: 180,
  });
  const clean = calculateAlphaScore({ intel: strongIntel, signal: { walletCount: 2, totalWeight: 3 }, chasePct: 2, tradeSol: 0.1, solPriceUsd: 180 });
  assert.ok(clean.score - risky.score >= 20, `expected safety penalty: ${clean.score} vs ${risky.score}`);
  assert.equal(risky.breakdown.safety.score, 0);
});

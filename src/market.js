import { getPrices, getTokenInfo } from './jupiter.js';

const DEX = 'https://api.dexscreener.com';
const RUG = 'https://api.rugcheck.xyz/v1';
const cache = new Map();

function cached(key, ttlMs) {
  const row = cache.get(key);
  return row && Date.now() - row.at < ttlMs ? row.value : null;
}
function put(key, value) { cache.set(key, { at: Date.now(), value }); return value; }
async function json(url, options = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...(options.headers || {}) }, ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function getDexPairs(mint) {
  const key = `pairs:${mint}`;
  const hit = cached(key, 15000);
  if (hit) return hit;
  const rows = await json(`${DEX}/token-pairs/v1/solana/${mint}`);
  return put(key, Array.isArray(rows) ? rows : []);
}

export async function getBestDexPair(mint) {
  const rows = await getDexPairs(mint);
  return [...rows].sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0] || null;
}

export async function getRugSummary(mint) {
  const key = `rug:${mint}`;
  const hit = cached(key, 60000);
  if (hit) return hit;
  try {
    const report = await json(`${RUG}/tokens/${mint}/report/summary`);
    return put(key, report || null);
  } catch (e) {
    return put(key, { unavailable: true, error: String(e.message || e) });
  }
}

export async function getTokenIntel(mint) {
  const key = `intel:${mint}`;
  const hit = cached(key, 10000);
  if (hit) return hit;
  const [infoResult, pricesResult, pairResult, rugResult] = await Promise.allSettled([
    getTokenInfo(mint),
    getPrices([mint]),
    getBestDexPair(mint),
    getRugSummary(mint),
  ]);
  const info = infoResult.status === 'fulfilled' ? infoResult.value : null;
  const prices = pricesResult.status === 'fulfilled' ? pricesResult.value : {};
  const price = prices?.[mint] || null;
  const pair = pairResult.status === 'fulfilled' ? pairResult.value : null;
  const rug = rugResult.status === 'fulfilled' ? rugResult.value : null;
  const risks = Array.isArray(rug?.risks) ? rug.risks : [];
  const intel = {
    mint,
    name: pair?.baseToken?.address === mint ? pair.baseToken.name : info?.name || pair?.baseToken?.name || 'Unknown',
    symbol: pair?.baseToken?.address === mint ? pair.baseToken.symbol : info?.symbol || pair?.baseToken?.symbol || 'TOKEN',
    priceUsd: Number(pair?.priceUsd || price?.usdPrice || 0),
    liquidityUsd: Number(pair?.liquidity?.usd || price?.liquidity || 0),
    marketCapUsd: Number(pair?.marketCap || pair?.fdv || price?.marketCap || price?.marketCapUsd || info?.marketCap || 0),
    fdvUsd: Number(pair?.fdv || 0),
    volume5m: Number(pair?.volume?.m5 || 0),
    volume1h: Number(pair?.volume?.h1 || 0),
    volume24h: Number(pair?.volume?.h24 || 0),
    buys5m: Number(pair?.txns?.m5?.buys || 0),
    sells5m: Number(pair?.txns?.m5?.sells || 0),
    priceChange5m: Number(pair?.priceChange?.m5 || 0),
    priceChange1h: Number(pair?.priceChange?.h1 || 0),
    pairCreatedAt: Number(pair?.pairCreatedAt || 0),
    dexId: pair?.dexId || null,
    pairUrl: pair?.url || null,
    boosts: Number(pair?.boosts?.active || 0),
    organicScore: Number(info?.organicScore || 0),
    rugUnavailable: Boolean(rug?.unavailable),
    rugged: rug?.rugged === true,
    rugScore: Number.isFinite(Number(rug?.score)) ? Number(rug.score) : null,
    risks: risks.slice(0, 8).map(r => ({
      name: r.name || r.type || 'Risk',
      level: r.level || r.severity || 'unknown',
      description: r.description || '',
      score: Number.isFinite(Number(r.score)) ? Number(r.score) : null,
    })),
    rawInfo: info,
  };
  return put(key, intel);
}

export async function getLatestSolanaProfiles(limit = 15) {
  const key = 'profiles';
  const hit = cached(key, 5000);
  let rows = hit;
  if (!rows) {
    const payload = await json(`${DEX}/token-profiles/latest/v1`);
    rows = Array.isArray(payload) ? payload.filter(x => x?.chainId === 'solana' && x?.tokenAddress) : [];
    put(key, rows);
  }
  return rows.slice(0, Math.max(1, Math.min(30, Number(limit) || 15)));
}

export async function getDiscoveryRadar(limit = 10) {
  const key = 'boosts';
  const hit = cached(key, 10000);
  let boosts = hit;
  if (!boosts) {
    const payload = await json(`${DEX}/token-boosts/top/v1`);
    boosts = Array.isArray(payload) ? payload.filter(x => x?.chainId === 'solana' && x?.tokenAddress) : [];
    put(key, boosts);
  }
  const selected = boosts.slice(0, Math.max(5, Math.min(30, Number(limit) * 2 || 20)));
  const intel = await Promise.all(selected.map(async b => {
    try {
      const pair = await getBestDexPair(b.tokenAddress);
      return {
        mint: b.tokenAddress,
        amount: Number(b.amount || 0),
        totalAmount: Number(b.totalAmount || 0),
        symbol: pair?.baseToken?.symbol || 'TOKEN',
        name: pair?.baseToken?.name || 'Unknown',
        priceUsd: Number(pair?.priceUsd || 0),
        liquidityUsd: Number(pair?.liquidity?.usd || 0),
        marketCapUsd: Number(pair?.marketCap || pair?.fdv || 0),
        volume1h: Number(pair?.volume?.h1 || 0),
        buys5m: Number(pair?.txns?.m5?.buys || 0),
        sells5m: Number(pair?.txns?.m5?.sells || 0),
        priceChange1h: Number(pair?.priceChange?.h1 || 0),
        pairUrl: pair?.url || b.url || null,
      };
    } catch {
      return null;
    }
  }));
  return intel.filter(Boolean)
    .sort((a, b) => (b.volume1h + b.liquidityUsd * 0.05 + b.totalAmount * 100) - (a.volume1h + a.liquidityUsd * 0.05 + a.totalAmount * 100))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 10)));
}

export function money(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '$0';
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(n < 1 ? 6 : 2)}`;
}

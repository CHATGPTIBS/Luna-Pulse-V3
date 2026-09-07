import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { config, WSOL, LAMPORTS_PER_SOL } from './config.js';

const BASE = 'https://api.jup.ag';
const headers = () => ({ 'x-api-key': config.jupiterApiKey });

export function loadExecutionWallet() {
  if (!config.liveTradingEnabled) return null;
  if (!config.privateKey) throw new Error('ENABLE_LIVE_TRADING=true but BS58_PRIVATE_KEY is empty');
  const secret = bs58.decode(config.privateKey.trim());
  return Keypair.fromSecretKey(secret);
}

export async function getPrices(mints) {
  const ids = [...new Set(mints)].filter(Boolean);
  if (!ids.length) return {};
  const res = await fetch(`${BASE}/price/v3?ids=${encodeURIComponent(ids.join(','))}`, { headers: headers() });
  if (!res.ok) throw new Error(`Jupiter price ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function getTokenInfo(mint) {
  const res = await fetch(`${BASE}/tokens/v2/search?query=${encodeURIComponent(mint)}`, { headers: headers() });
  if (!res.ok) throw new Error(`Jupiter tokens ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows.find(x => x.id === mint) || rows[0] || null;
}

export async function getOrder({ inputMint, outputMint, amountRaw, taker, slippageBps = 0 }) {
  const params = new URLSearchParams({ inputMint, outputMint, amount: String(amountRaw), taker });
  if (Number(slippageBps || 0) > 0) params.set('slippageBps', String(Math.floor(Number(slippageBps))));
  const res = await fetch(`${BASE}/swap/v2/order?${params}`, { headers: headers() });
  if (!res.ok) throw new Error(`Jupiter order ${res.status}: ${await res.text()}`);
  return { ...(await res.json()), quotedAtMs: Date.now() };
}

export async function executeOrder(order, wallet, maxQuoteAgeMs = 0) {
  if (!order?.transaction) throw new Error(order?.errorMessage || 'Jupiter returned no executable transaction');
  if (Number(maxQuoteAgeMs || 0) > 0 && order.quotedAtMs && Date.now() - order.quotedAtMs > Number(maxQuoteAgeMs)) {
    throw new Error(`Jupiter quote stale (${Date.now() - order.quotedAtMs}ms > ${maxQuoteAgeMs}ms)`);
  }
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
  tx.sign([wallet]);
  const signedTransaction = Buffer.from(tx.serialize()).toString('base64');
  const res = await fetch(`${BASE}/swap/v2/execute`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedTransaction,
      requestId: order.requestId,
      ...(order.lastValidBlockHeight ? { lastValidBlockHeight: String(order.lastValidBlockHeight) } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Jupiter execute ${res.status}: ${await res.text()}`);
  const result = await res.json();
  if (result.status !== 'Success') throw new Error(result.error || `Swap failed with code ${result.code}`);
  return result;
}

export async function estimateBuyQuality({ mint, solAmount, outAmountRaw, outputDecimals }) {
  const prices = await getPrices([WSOL, mint]);
  const sol = prices[WSOL];
  const token = prices[mint];
  if (!sol?.usdPrice || !token?.usdPrice) return { ok: false, reason: 'No reliable Jupiter price available for SOL/token' };
  const inputUsd = solAmount * sol.usdPrice;
  const outTokens = Number(outAmountRaw) / 10 ** outputDecimals;
  const outputUsd = outTokens * token.usdPrice;
  const impactPct = inputUsd > 0 ? Math.max(0, (1 - outputUsd / inputUsd) * 100) : 100;
  return {
    ok: true,
    liquidityUsd: Number(token.liquidity || 0),
    impactPct,
    tokenPriceUsd: token.usdPrice,
    solPriceUsd: sol.usdPrice,
  };
}

async function freshBuyOrder({ mint, amountRaw, wallet, settings, info, solAmount }) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const order = await getOrder({
        inputMint: WSOL,
        outputMint: mint,
        amountRaw,
        taker: wallet.publicKey.toBase58(),
        slippageBps: Number(settings.fixedSlippageBps || 0),
      });
      if (!order.transaction) throw new Error(order.errorMessage || 'No executable Jupiter route');
      const q = await estimateBuyQuality({ mint, solAmount, outAmountRaw: order.outAmount, outputDecimals: info.decimals });
      if (!q.ok) throw new Error(q.reason);
      if (q.liquidityUsd < settings.minLiquidityUsd) throw new Error(`Liquidity $${Math.round(q.liquidityUsd).toLocaleString()} below minimum $${settings.minLiquidityUsd.toLocaleString()}`);
      if (q.impactPct > settings.maxEstimatedImpactPct) throw new Error(`Estimated price impact ${q.impactPct.toFixed(2)}% above maximum ${settings.maxEstimatedImpactPct}%`);
      const age = Date.now() - Number(order.quotedAtMs || Date.now());
      if (Number(settings.maxQuoteAgeMs || 0) > 0 && age > Number(settings.maxQuoteAgeMs)) {
        lastError = new Error(`Quote aged ${age}ms during validation; requoting`);
        continue;
      }
      return { order, quality: q };
    } catch (e) {
      lastError = e;
      if (!/stale|aged/i.test(String(e.message || e))) throw e;
    }
  }
  throw lastError || new Error('Unable to obtain a fresh Jupiter quote');
}

export async function copyBuy({ mint, solAmount, wallet, settings }) {
  const amountSol = Math.min(solAmount, settings.maxTradeSol);
  const amountRaw = Math.floor(amountSol * LAMPORTS_PER_SOL);
  const info = await getTokenInfo(mint);
  if (!info) throw new Error('Token not found in Jupiter token metadata');
  if (settings.minOrganicScore > 0 && Number(info.organicScore || 0) < settings.minOrganicScore) {
    throw new Error(`Organic score ${Number(info.organicScore || 0).toFixed(1)} below minimum ${settings.minOrganicScore}`);
  }
  const { order, quality } = await freshBuyOrder({ mint, amountRaw, wallet, settings, info, solAmount: amountSol });
  const result = await executeOrder(order, wallet, Number(settings.maxQuoteAgeMs || 0));
  return { result, info, quality, solAmount: amountSol, router: order.router || null, orderMode: order.mode || null };
}

export async function copySell({ mint, rawAmount, wallet, settings = {} }) {
  if (rawAmount <= 0n) throw new Error('Nothing to sell');
  let order = await getOrder({
    inputMint: mint,
    outputMint: WSOL,
    amountRaw: rawAmount.toString(),
    taker: wallet.publicKey.toBase58(),
    slippageBps: Number(settings.fixedSlippageBps || 0),
  });
  if (!order.transaction) throw new Error(order.errorMessage || 'No executable Jupiter sell route');
  if (Number(settings.maxQuoteAgeMs || 0) > 0 && Date.now() - order.quotedAtMs > Number(settings.maxQuoteAgeMs)) {
    order = await getOrder({
      inputMint: mint,
      outputMint: WSOL,
      amountRaw: rawAmount.toString(),
      taker: wallet.publicKey.toBase58(),
      slippageBps: Number(settings.fixedSlippageBps || 0),
    });
  }
  const result = await executeOrder(order, wallet, Number(settings.maxQuoteAgeMs || 0));
  return { result, router: order.router || null, orderMode: order.mode || null };
}

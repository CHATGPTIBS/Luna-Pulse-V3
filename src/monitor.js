import { EmbedBuilder } from 'discord.js';
import { getRecentTransactions, isHeliusRateLimitError } from './helius.js';
import { getPrices } from './jupiter.js';
import { getLatestSignature, getTokenBalanceRaw } from './solana.js';
import { config, WSOL } from './config.js';
import { parseSwap, short, fmt } from './swap.js';
import { paperBuy, paperSell } from './paper.js';
import { createAutoSellSet } from './strategy.js';
import { getTokenIntel } from './market.js';
import { calculateAlphaScore } from './alpha.js';
import { startRealtimeWalletWake } from './realtime.js';
import { startV5Discord } from './v5-discord.js';

const signalBook = new Map();
const tokenCache = new Map();

function explorerTx(sig) { return `https://solscan.io/tx/${sig}`; }
function leaderMode(leader) { return leader.copyMode === 'track' ? 'track' : leader.copyMode === 'paper' ? 'paper' : 'legacy-live'; }
function tierWeight(tier) { return tier === 'A' ? 1.5 : tier === 'C' ? 0.75 : 1; }
function weightOf(leader) { const n = Number(leader.weight); return Number.isFinite(n) && n > 0 ? n : tierWeight(leader.tier); }
function leaderMinBuy(leader, settings) { return leader.minLeaderBuySol == null ? Number(settings.minLeaderBuySol || 0) : Number(leader.minLeaderBuySol || 0); }

async function alertChannel(client, store) {
  const id = store.data.settings.alertChannelId;
  if (!id) return null;
  try { return await client.channels.fetch(id); } catch { return null; }
}

async function tokenSnapshot(mint) {
  const cached = tokenCache.get(mint);
  if (cached && Date.now() - cached.at < 10000) return cached.value;
  let intel = null, prices = {};
  try {
    const results = await Promise.allSettled([getTokenIntel(mint), getPrices([WSOL, mint])]);
    intel = results[0].status === 'fulfilled' ? results[0].value : null;
    prices = results[1].status === 'fulfilled' ? results[1].value : {};
  } catch {}
  const price = prices?.[mint] || null;
  const value = {
    intel,
    info: intel?.rawInfo || null,
    price,
    solPriceUsd: Number(prices?.[WSOL]?.usdPrice || 0),
    liquidityUsd: Number(intel?.liquidityUsd || price?.liquidity || 0),
    marketCapUsd: Number(intel?.marketCapUsd || price?.marketCap || price?.marketCapUsd || 0),
  };
  tokenCache.set(mint, { at: Date.now(), value });
  return value;
}

function pruneSignals(store) {
  const now = Date.now();
  const windowMs = Math.max(30, Number(store.data.settings.signalWindowSec || 120)) * 1000;
  const cooldownMs = Math.max(0, Number(store.data.settings.signalCooldownSec || 0)) * 1000;
  const participantCutoff = now - windowMs;
  for (const [mint, book] of signalBook) {
    for (const [address, row] of book.buyers) if (row.at < participantCutoff) book.buyers.delete(address);
    const signalCooldownExpired = !book.firedAt || now - book.firedAt >= cooldownMs;
    const paperCooldownExpired = !book.paperFiredAt || now - book.paperFiredAt >= cooldownMs;
    if (!book.buyers.size && signalCooldownExpired && paperCooldownExpired) signalBook.delete(mint);
  }
}

function recordBuySignal(store, leader, swap, tx) {
  pruneSignals(store);
  const s = store.data.settings;
  const now = Date.now();
  let book = signalBook.get(swap.mint);
  if (!book) { book = { mint: swap.mint, buyers: new Map(), firedAt: 0, paperFiredAt: 0 }; signalBook.set(swap.mint, book); }
  book.buyers.set(leader.address, {
    address: leader.address,
    label: leader.label,
    tier: leader.tier || 'B',
    weight: weightOf(leader),
    solAmount: Number(swap.solAmount || 0),
    tokenAmount: Number(swap.tokenAmount || 0),
    at: now,
    signature: tx.signature,
  });
  const participants = [...book.buyers.values()];
  const walletCount = participants.length;
  const totalWeight = participants.reduce((sum, x) => sum + x.weight, 0);
  const qualified = walletCount >= Math.max(1, Number(s.signalMinWallets || 1)) && totalWeight >= Math.max(0, Number(s.signalMinWeight || 0));
  const cooldownMs = Math.max(0, Number(s.signalCooldownSec || 0)) * 1000;
  const cooled = !book.firedAt || now - book.firedAt >= cooldownMs;
  const newlyQualified = qualified && cooled;
  if (newlyQualified) {
    book.firedAt = now;
    store.pushSignal({
      side: 'BUY', mint: swap.mint, walletCount, totalWeight,
      wallets: participants.map(x => ({ address: x.address, label: x.label, tier: x.tier, weight: x.weight, solAmount: x.solAmount })),
      triggerSignature: tx.signature,
      alphaScore: null,
      chasePct: null,
    });
  }
  return { walletCount, totalWeight, qualified, newlyQualified, participants };
}

function annotateLatestSignal(store, mint, alpha, chasePct) {
  const row = store.data.signalHistory.find(x => x.mint === mint && x.side === 'BUY');
  if (!row) return;
  row.alphaScore = alpha?.score ?? null;
  row.alphaLabel = alpha?.label ?? null;
  row.alphaBreakdown = alpha?.breakdown ?? null;
  row.chasePct = Number.isFinite(Number(chasePct)) ? Number(chasePct) : null;
  store.save();
}

function paperCooldownAvailable(store, mint) {
  const book = signalBook.get(mint);
  if (!book?.paperFiredAt) return true;
  const cooldownMs = Math.max(0, Number(store.data.settings.signalCooldownSec || 0)) * 1000;
  return Date.now() - book.paperFiredAt >= cooldownMs;
}
function markPaperFired(mint) { const book = signalBook.get(mint); if (book) book.paperFiredAt = Date.now(); }

function copiedBuySol(leader, settings, leaderBuySol) {
  const pct = Number(leader.copyBuyPct || 0);
  const requested = pct > 0 ? Number(leaderBuySol || 0) * pct / 100 : Number(leader.copyBuySol || settings.copyBuySol);
  return Math.max(0, Math.min(requested, Number(settings.maxTradeSol)));
}

async function buyGate({ store, leader, swap, tx, leaderBuySol, leaderTokenAmount, signal }) {
  const s = store.data.settings;
  if (store.data.blockedMints.includes(swap.mint)) return { ok: false, reason: 'Mint is on Luna blocklist' };
  const minBuy = leaderMinBuy(leader, s);
  if (Number(leaderBuySol || 0) < minBuy) return { ok: false, reason: `Leader buy ${fmt(leaderBuySol, 4)} SOL below ${fmt(minBuy, 4)} SOL minimum` };
  if (s.maxEntryDelaySec > 0 && tx.timestamp) {
    const delay = Math.max(0, Math.round(Date.now() / 1000 - Number(tx.timestamp)));
    if (delay > s.maxEntryDelaySec) return { ok: false, reason: `Entry is ${delay}s old (max ${s.maxEntryDelaySec}s)` };
  }
  if (s.skipExistingPosition && !leader.duplicateBuys) {
    const p = store.data.paper.positions.find(x => x.mint === swap.mint && x.tokenAmount > 0);
    if (p) return { ok: false, reason: 'Existing paper position already open (duplicate buys OFF)' };
  }
  store.resetDailyIfNeeded();
  const buySol = copiedBuySol(leader, s, leaderBuySol);
  if (!(buySol > 0)) return { ok: false, reason: 'Calculated copied buy size is zero' };
  if (s.maxDailyBuySol > 0 && store.data.daily.boughtSol + buySol > s.maxDailyBuySol + 1e-12) return { ok: false, reason: `Daily paper buy cap reached (${fmt(store.data.daily.boughtSol, 3)}/${fmt(s.maxDailyBuySol, 3)} SOL)` };

  const snap = await tokenSnapshot(swap.mint);
  const intel = snap.intel || {};
  if (intel.rugged) return { ok: false, reason: 'RugCheck currently marks token as rugged', snap };
  if ((intel.risks || []).some(r => /critical|danger/i.test(String(r.level || '')))) return { ok: false, reason: 'Critical token-risk signal detected', snap };

  if (s.minOrganicScore > 0) {
    const organic = Number(intel.organicScore || snap.info?.organicScore || 0);
    if (organic < s.minOrganicScore) return { ok: false, reason: `Organic score ${organic.toFixed(1)} below ${s.minOrganicScore}`, snap };
  }
  const minLiquidity = leader.minLiquidityUsd == null ? Number(s.minLiquidityUsd || 0) : Number(leader.minLiquidityUsd || 0);
  if (minLiquidity > 0) {
    if (!snap.liquidityUsd) return { ok: false, reason: 'Liquidity unavailable', snap };
    if (snap.liquidityUsd < minLiquidity) return { ok: false, reason: `Liquidity $${Math.round(snap.liquidityUsd).toLocaleString()} below $${minLiquidity.toLocaleString()}`, snap };
  }
  const minMcap = Number(leader.minMarketCapUsd || 0);
  const maxMcap = leader.maxMarketCapUsd == null ? Number(s.maxMarketCapUsd || 0) : Number(leader.maxMarketCapUsd || 0);
  if (minMcap > 0 && (!snap.marketCapUsd || snap.marketCapUsd < minMcap)) return { ok: false, reason: snap.marketCapUsd ? `Market cap $${Math.round(snap.marketCapUsd).toLocaleString()} below $${minMcap.toLocaleString()}` : 'Market cap unavailable', snap };
  if (maxMcap > 0 && snap.marketCapUsd > 0 && snap.marketCapUsd > maxMcap) return { ok: false, reason: `Market cap $${Math.round(snap.marketCapUsd).toLocaleString()} above $${maxMcap.toLocaleString()}`, snap };

  let leaderEntryPriceUsd = null, chasePct = null;
  if (Number(leaderTokenAmount || 0) > 0 && snap.solPriceUsd > 0) {
    leaderEntryPriceUsd = (Number(leaderBuySol || 0) * snap.solPriceUsd) / Number(leaderTokenAmount);
    if (leaderEntryPriceUsd > 0 && Number(intel.priceUsd || snap.price?.usdPrice || 0) > 0) {
      chasePct = ((Number(intel.priceUsd || snap.price.usdPrice) / leaderEntryPriceUsd) - 1) * 100;
    }
  }
  const maxChase = leader.maxChasePct == null ? Number(s.maxChasePct || 0) : Number(leader.maxChasePct || 0);
  if (maxChase > 0 && Number.isFinite(chasePct) && chasePct > maxChase) {
    return { ok: false, reason: `Price already ${chasePct.toFixed(1)}% above leader entry (max ${maxChase}%)`, snap, chasePct, leaderEntryPriceUsd };
  }

  const alpha = calculateAlphaScore({ intel, signal, chasePct, tradeSol: buySol, solPriceUsd: snap.solPriceUsd });
  const minAlpha = leader.minAlphaScore == null ? Number(s.minAlphaScore || 0) : Number(leader.minAlphaScore || 0);
  if (minAlpha > 0 && alpha.score < minAlpha) {
    return { ok: false, reason: `Luna Alpha ${alpha.score}/100 below minimum ${minAlpha}`, snap, chasePct, leaderEntryPriceUsd, alpha };
  }
  return { ok: true, snap, buySol, chasePct, leaderEntryPriceUsd, alpha };
}

async function postTradeAlert(client, store, leader, swap, tx, resultText, snap = null, signal = null, decision = null) {
  const s = store.data.settings;
  if ((swap.side === 'BUY' && !s.buyAlerts) || (swap.side === 'SELL' && !s.sellAlerts)) return;
  const ch = await alertChannel(client, store);
  if (!ch?.isTextBased()) return;
  if (!snap) snap = await tokenSnapshot(swap.mint);
  const fields = [
    { name: 'Leader', value: `${leader.tier || 'B'} · ${weightOf(leader).toFixed(2)}x · \`${short(leader.address)}\``, inline: true },
    { name: 'Mode', value: leaderMode(leader).toUpperCase(), inline: true },
    { name: 'Leader trade', value: swap.side === 'BUY' ? `≈ ${fmt(swap.solAmount, 4)} SOL` : `${fmt(swap.tokenAmount, 4)} tokens → ≈ ${fmt(swap.solAmount, 4)} SOL`, inline: true },
    { name: 'Price', value: snap.price?.usdPrice ? `$${fmt(snap.price.usdPrice, 9)}` : snap.intel?.priceUsd ? `$${fmt(snap.intel.priceUsd, 9)}` : 'Unavailable', inline: true },
    { name: 'Liquidity', value: snap.liquidityUsd ? `$${Math.round(snap.liquidityUsd).toLocaleString()}` : 'Unavailable', inline: true },
  ];
  if (signal) fields.push({ name: 'V5 signal', value: `${signal.walletCount} wallet${signal.walletCount === 1 ? '' : 's'} · weight ${signal.totalWeight.toFixed(2)} · ${signal.qualified ? '✅ qualified' : '⏳ building'}`, inline: true });
  if (decision?.alpha) fields.push({ name: 'Luna Alpha', value: `**${decision.alpha.score}/100 — ${decision.alpha.label}**`, inline: true });
  if (Number.isFinite(Number(decision?.chasePct))) fields.push({ name: 'Entry chase', value: `${decision.chasePct >= 0 ? '+' : ''}${Number(decision.chasePct).toFixed(1)}% vs leader`, inline: true });
  fields.push({ name: 'Result', value: resultText || 'Track only', inline: false });
  const embed = new EmbedBuilder()
    .setTitle(`${swap.side === 'BUY' ? '🟢' : '🔴'} ${leader.label || short(leader.address)} ${swap.side}`)
    .setDescription(`**${snap.intel?.symbol || snap.info?.symbol || 'TOKEN'}** · \`${swap.mint}\``)
    .addFields(...fields)
    .setURL(explorerTx(tx.signature))
    .setTimestamp(new Date((tx.timestamp || Date.now() / 1000) * 1000))
    .setFooter({ text: 'Luna V5 Alpha · realtime smart-money engine' });
  await ch.send({ embeds: [embed] });
}

function bestPaperLeader(store, participants) {
  const addresses = new Set(participants.map(x => x.address));
  return store.data.leaders.filter(l => addresses.has(l.address) && l.enabled !== false && leaderMode(l) === 'paper').sort((a, b) => weightOf(b) - weightOf(a))[0] || null;
}
function hasOpenAutoExit(store, mint, leaderAddress) {
  return store.data.orders?.some(o => o.status === 'open' && o.mint === mint && o.leaderAddress === leaderAddress && ['take-profit','stop-loss','trailing-stop'].includes(o.kind));
}

async function handleBuy(client, store, leader, swap, tx) {
  const s = store.data.settings;
  const minBuy = leaderMinBuy(leader, s);
  if (Number(swap.solAmount || 0) < minBuy) {
    if (s.skippedAlerts) await postTradeAlert(client, store, leader, swap, tx, `⛔ Ignored: leader buy below ${fmt(minBuy, 4)} SOL`);
    return;
  }
  const signal = recordBuySignal(store, leader, swap, tx);
  if (!signal.qualified) return postTradeAlert(client, store, leader, swap, tx, `⏳ Waiting for ${s.signalMinWallets} wallet(s) / ${Number(s.signalMinWeight).toFixed(2)} weight`, null, signal);
  const executionLeader = bestPaperLeader(store, signal.participants);
  if (!executionLeader) return postTradeAlert(client, store, leader, swap, tx, signal.newlyQualified ? '👀 Signal qualified, but participants are TRACK-only' : '👀 Qualified TRACK-only signal remains in cooldown', null, signal);
  if (!paperCooldownAvailable(store, swap.mint)) return postTradeAlert(client, store, leader, swap, tx, `🛡️ Paper signal already executed; ${s.signalCooldownSec}s duplicate cooldown active`, null, signal);

  const participant = signal.participants.find(x => x.address === executionLeader.address);
  const executionLeaderBuySol = Number(participant?.solAmount || swap.solAmount || 0);
  const executionLeaderTokenAmount = Number(participant?.tokenAmount || swap.tokenAmount || 0);
  const gate = await buyGate({ store, leader: executionLeader, swap, tx, leaderBuySol: executionLeaderBuySol, leaderTokenAmount: executionLeaderTokenAmount, signal });
  if (gate.alpha || Number.isFinite(Number(gate.chasePct))) annotateLatestSignal(store, swap.mint, gate.alpha, gate.chasePct);
  if (!gate.ok) return postTradeAlert(client, store, leader, swap, tx, `⛔ Qualified signal skipped: ${gate.reason}`, gate.snap, signal, gate);
  if (!s.paperTrading) return postTradeAlert(client, store, leader, swap, tx, '⏸️ Qualified signal; paper trading master switch OFF', gate.snap, signal, gate);

  try {
    const r = await paperBuy({ store, mint: swap.mint, solAmount: gate.buySol, leaderAddress: executionLeader.address, leaderLabel: executionLeader.label, signature: tx.signature });
    markPaperFired(swap.mint);
    store.resetDailyIfNeeded();
    store.data.daily.boughtSol += r.solAmount;
    let autoExitText = '';
    const tp = Number(executionLeader.autoTakeProfitPct || 0), sl = Number(executionLeader.autoStopLossPct || 0), trail = Number(executionLeader.trailingStopPct || 0);
    if ((tp > 0 || sl > 0 || trail > 0) && !hasOpenAutoExit(store, swap.mint, executionLeader.address)) {
      try {
        const exits = await createAutoSellSet({ store, mint: swap.mint, takeProfitPct: tp, stopLossPct: sl, trailingPct: trail, sellPct: 100, mode: 'paper', leaderAddress: executionLeader.address });
        autoExitText = ` · protected by #${exits.map(x => x.id).join('/#')}`;
      } catch (e) { autoExitText = ` · auto-exit setup failed: ${String(e.message || e).slice(0, 100)}`; }
    }
    store.save();
    return postTradeAlert(client, store, leader, swap, tx, `🧪 PAPER BUY ${r.solAmount.toFixed(3)} SOL · source ${executionLeader.label || short(executionLeader.address)}${Number(executionLeader.copyBuyPct || 0) > 0 ? ` · ${executionLeader.copyBuyPct}% sizing` : ''}${autoExitText}`, gate.snap, signal, gate);
  } catch (e) {
    return postTradeAlert(client, store, leader, swap, tx, `⛔ Paper buy skipped: ${String(e.message).slice(0, 350)}`, gate.snap, signal, gate);
  }
}

async function handleSell(client, store, leader, swap, tx) {
  const s = store.data.settings;
  const mode = leaderMode(leader);
  if (mode === 'track') return postTradeAlert(client, store, leader, swap, tx, '👀 Track-only sell signal');
  if (mode === 'legacy-live') return postTradeAlert(client, store, leader, swap, tx, '⚠️ Legacy live mode is alerts-only in V5');
  if (leader.copySells === false) return postTradeAlert(client, store, leader, swap, tx, '🛡️ Copy sells disabled for this wallet; TP/SL strategy remains independent');
  const owned = store.data.paper.positions.find(p => p.mint === swap.mint && p.leaderAddress === leader.address && p.tokenAmount > 0);
  if (!owned) return postTradeAlert(client, store, leader, swap, tx, 'ℹ️ No paper position sourced from this leader; sell not copied');
  let sellPct = 1;
  if (s.sellMode === 'proportional') {
    try {
      const leaderAfter = await getTokenBalanceRaw(leader.address, swap.mint);
      const before = leaderAfter.ui + swap.tokenAmount;
      sellPct = before > 0 ? Math.min(1, Math.max(0, swap.tokenAmount / before)) : 1;
    } catch { sellPct = 1; }
  }
  if (!s.paperTrading) return postTradeAlert(client, store, leader, swap, tx, '⏸️ Paper trading master switch OFF');
  try {
    const r = await paperSell({ store, mint: swap.mint, sellPct, leaderAddress: leader.address, leaderLabel: leader.label, signature: tx.signature });
    return postTradeAlert(client, store, leader, swap, tx, `🧪 PAPER SELL ${(r.sellPct * 100).toFixed(1)}% · PnL ${r.pnlSol >= 0 ? '+' : ''}${r.pnlSol.toFixed(4)} SOL`);
  } catch (e) { return postTradeAlert(client, store, leader, swap, tx, `ℹ️ ${String(e.message).slice(0, 350)}`); }
}

async function pollLeader(client, store, leader) {
  let latest = null;
  try { latest = await getLatestSignature(leader.address); }
  catch (e) { console.warn(`Signature preflight ${short(leader.address)}:`, e.message); }
  if (latest && leader.lastSignature && latest.signature === leader.lastSignature) return 0;
  if (latest && !leader.lastSignature) { leader.lastSignature = latest.signature; leader.lastTimestamp = Number(latest.blockTime || 0); return 0; }
  const txs = await getRecentTransactions(leader.address, config.recentTxLimit, { fresh: true });
  if (!txs.length) return 0;
  if (!leader.lastSignature) { leader.lastSignature = txs[0].signature; leader.lastTimestamp = Number(txs[0].timestamp || 0); return 0; }
  const idx = txs.findIndex(t => t.signature === leader.lastSignature);
  let fresh;
  if (idx >= 0) fresh = txs.slice(0, idx);
  else if (leader.lastTimestamp) fresh = txs.filter(t => Number(t.timestamp || 0) > Number(leader.lastTimestamp));
  else fresh = txs.slice(0, 1);
  fresh = fresh.reverse();
  let activity = 0;
  for (const tx of fresh) {
    const swap = parseSwap(tx, leader.address);
    if (swap?.side === 'BUY') { await handleBuy(client, store, leader, swap, tx); activity++; }
    if (swap?.side === 'SELL') { await handleSell(client, store, leader, swap, tx); activity++; }
    leader.lastSignature = tx.signature;
    leader.lastTimestamp = Math.max(Number(leader.lastTimestamp || 0), Number(tx.timestamp || 0));
  }
  if (!fresh.length) { leader.lastSignature = txs[0].signature; leader.lastTimestamp = Math.max(Number(leader.lastTimestamp || 0), Number(txs[0].timestamp || 0)); }
  if (activity) leader.lastActivityAt = Date.now();
  return activity;
}

async function pollPrices(client, store) {
  const active = store.data.priceAlerts.filter(a => a.active);
  if (!active.length) return;
  const prices = await getPrices(active.map(a => a.mint));
  const ch = await alertChannel(client, store);
  if (!ch?.isTextBased()) return;
  for (const a of active) {
    const p = prices[a.mint]?.usdPrice;
    if (!p) continue;
    const hit = a.direction === 'above' ? p >= a.price : p <= a.price;
    if (!hit) continue;
    a.active = false; store.save();
    const intel = await getTokenIntel(a.mint).catch(() => null);
    await ch.send(`🔔 **PRICE ALERT #${a.id}** — **${intel?.symbol || short(a.mint)}** is $${fmt(p, 10)}, ${a.direction} your $${fmt(a.price, 10)} trigger.\nMint: \`${a.mint}\``);
  }
}

export function startMonitors(client, store) {
  const realtime = startRealtimeWalletWake(store, ({ address, signature }) => {
    const leader = store.data.leaders.find(l => l.address === address && l.enabled !== false);
    if (!leader) return;
    leader.nextPollAt = 0;
    leader.lastRealtimeSignature = signature;
    leader.lastRealtimeAt = Date.now();
  });
  startV5Discord(client, store, realtime.getStats);

  let walletBusy = false, priceBusy = false;
  setInterval(async () => {
    if (walletBusy || store.data.settings.paused || store.isReady?.() === false) return;
    const now = Date.now();
    const due = store.data.leaders.filter(l => l.enabled !== false && Number(l.nextPollAt || 0) <= now).sort((a, b) => Number(a.nextPollAt || 0) - Number(b.nextPollAt || 0));
    const leader = due[0]; if (!leader) return;
    walletBusy = true;
    try {
      const activity = await pollLeader(client, store, leader);
      leader.pollErrors = 0;
      const recentlyActive = activity > 0 || (Number(leader.lastActivityAt || 0) > 0 && Date.now() - Number(leader.lastActivityAt) < config.walletHotHoldMs);
      leader.nextPollAt = Date.now() + (recentlyActive ? config.walletHotPollMs : config.walletIdlePollMs);
    } catch (e) {
      leader.pollErrors = Number(leader.pollErrors || 0) + 1;
      const rateLimited = isHeliusRateLimitError(e), retry = Number(e?.retryAfterMs || 0);
      leader.nextPollAt = Date.now() + (rateLimited ? Math.max(config.walletIdlePollMs, retry) : Math.min(300000, config.walletIdlePollMs * Math.max(1, leader.pollErrors)));
      console.error(`Leader poll ${leader.address}:`, e.message);
    } finally { store.save(); walletBusy = false; }
  }, config.walletSchedulerMs);

  setInterval(async () => {
    if (priceBusy || store.data.settings.paused || store.isReady?.() === false) return;
    priceBusy = true;
    try { await pollPrices(client, store); }
    catch (e) { console.error('Price poll:', e.message); }
    finally { priceBusy = false; }
  }, config.pricePollMs);
}

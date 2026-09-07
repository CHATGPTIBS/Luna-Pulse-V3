import { EmbedBuilder } from 'discord.js';
import { getRecentTransactions, isHeliusRateLimitError } from './helius.js';
import { getPrices, getTokenInfo } from './jupiter.js';
import { getTokenBalanceRaw } from './solana.js';
import { config } from './config.js';
import { parseSwap, short, fmt } from './swap.js';
import { paperBuy, paperSell } from './paper.js';

const signalBook = new Map();
const tokenCache = new Map();

function explorerTx(sig) { return `https://solscan.io/tx/${sig}`; }
function leaderMode(leader) { return leader.copyMode === 'track' ? 'track' : leader.copyMode === 'paper' ? 'paper' : 'legacy-live'; }
function tierWeight(tier) { return tier === 'A' ? 1.5 : tier === 'C' ? 0.75 : 1; }
function weightOf(leader) { const n = Number(leader.weight); return Number.isFinite(n) && n > 0 ? n : tierWeight(leader.tier); }

async function alertChannel(client, store) {
  const id = store.data.settings.alertChannelId;
  if (!id) return null;
  try { return await client.channels.fetch(id); } catch { return null; }
}

async function tokenSnapshot(mint) {
  const cached = tokenCache.get(mint);
  if (cached && Date.now() - cached.at < 30000) return cached.value;

  let info = null;
  let price = null;
  try {
    const [i, p] = await Promise.all([getTokenInfo(mint), getPrices([mint])]);
    info = i;
    price = p?.[mint] || null;
  } catch {}

  const value = {
    info,
    price,
    liquidityUsd: Number(price?.liquidity || 0),
    marketCapUsd: Number(price?.marketCap || price?.marketCapUsd || price?.mcap || info?.marketCap || info?.marketCapUsd || info?.mcap || 0),
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
    for (const [address, row] of book.buyers) {
      if (row.at < participantCutoff) book.buyers.delete(address);
    }
    const cooldownExpired = !book.firedAt || now - book.firedAt >= cooldownMs;
    if (!book.buyers.size && cooldownExpired) signalBook.delete(mint);
  }
}

function recordBuySignal(store, leader, swap, tx) {
  pruneSignals(store);
  const s = store.data.settings;
  const now = Date.now();
  let book = signalBook.get(swap.mint);
  if (!book) {
    book = { mint: swap.mint, buyers: new Map(), firedAt: 0 };
    signalBook.set(swap.mint, book);
  }

  book.buyers.set(leader.address, {
    address: leader.address,
    label: leader.label,
    tier: leader.tier || 'B',
    weight: weightOf(leader),
    solAmount: Number(swap.solAmount || 0),
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
      side: 'BUY',
      mint: swap.mint,
      walletCount,
      totalWeight,
      wallets: participants.map(x => ({ address: x.address, label: x.label, tier: x.tier, weight: x.weight })),
      triggerSignature: tx.signature,
    });
  }

  return { walletCount, totalWeight, qualified, newlyQualified, participants };
}

async function buyGate({ store, leader, swap, tx }) {
  const s = store.data.settings;
  if (store.data.blockedMints.includes(swap.mint)) return { ok: false, reason: 'Mint is on Luna blocklist' };

  if (Number(swap.solAmount || 0) < Number(s.minLeaderBuySol || 0)) {
    return { ok: false, reason: `Leader buy ${fmt(swap.solAmount, 4)} SOL below ${fmt(s.minLeaderBuySol, 4)} SOL signal minimum` };
  }

  if (s.maxEntryDelaySec > 0 && tx.timestamp) {
    const delay = Math.max(0, Math.round(Date.now() / 1000 - Number(tx.timestamp)));
    if (delay > s.maxEntryDelaySec) return { ok: false, reason: `Entry is ${delay}s old (max ${s.maxEntryDelaySec}s)` };
  }

  if (s.skipExistingPosition) {
    const p = store.data.paper.positions.find(x => x.mint === swap.mint && x.tokenAmount > 0);
    if (p) return { ok: false, reason: 'Existing paper position already open' };
  }

  store.resetDailyIfNeeded();
  const buySol = Math.min(Number(leader.copyBuySol || s.copyBuySol), Number(s.maxTradeSol));
  if (s.maxDailyBuySol > 0 && store.data.daily.boughtSol + buySol > s.maxDailyBuySol + 1e-12) {
    return { ok: false, reason: `Daily paper buy cap reached (${fmt(store.data.daily.boughtSol, 3)}/${fmt(s.maxDailyBuySol, 3)} SOL)` };
  }

  const snap = await tokenSnapshot(swap.mint);
  if (s.minOrganicScore > 0) {
    const organic = Number(snap.info?.organicScore || 0);
    if (organic < s.minOrganicScore) return { ok: false, reason: `Organic score ${organic.toFixed(1)} below ${s.minOrganicScore}`, snap };
  }
  if (s.minLiquidityUsd > 0) {
    if (!snap.liquidityUsd) return { ok: false, reason: 'Liquidity unavailable', snap };
    if (snap.liquidityUsd < s.minLiquidityUsd) return { ok: false, reason: `Liquidity $${Math.round(snap.liquidityUsd).toLocaleString()} below $${s.minLiquidityUsd.toLocaleString()}`, snap };
  }
  if (s.maxMarketCapUsd > 0 && snap.marketCapUsd > 0 && snap.marketCapUsd > s.maxMarketCapUsd) {
    return { ok: false, reason: `Market cap $${Math.round(snap.marketCapUsd).toLocaleString()} above $${s.maxMarketCapUsd.toLocaleString()}`, snap };
  }
  return { ok: true, snap, buySol };
}

async function postTradeAlert(client, store, leader, swap, tx, resultText, snap = null, signal = null) {
  const s = store.data.settings;
  if ((swap.side === 'BUY' && !s.buyAlerts) || (swap.side === 'SELL' && !s.sellAlerts)) return;
  const ch = await alertChannel(client, store);
  if (!ch?.isTextBased()) return;

  if (!snap) snap = await tokenSnapshot(swap.mint);
  const title = `${swap.side === 'BUY' ? '🟢' : '🔴'} ${leader.label || short(leader.address)} ${swap.side}`;
  const fields = [
    { name: 'Leader', value: `${leader.tier || 'B'} · ${weightOf(leader).toFixed(2)}x · \`${short(leader.address)}\``, inline: true },
    { name: 'Mode', value: leaderMode(leader).toUpperCase(), inline: true },
    { name: 'Leader trade', value: swap.side === 'BUY' ? `≈ ${fmt(swap.solAmount, 4)} SOL` : `${fmt(swap.tokenAmount, 4)} tokens → ≈ ${fmt(swap.solAmount, 4)} SOL`, inline: true },
    { name: 'Price', value: snap.price?.usdPrice ? `$${fmt(snap.price.usdPrice, 9)}` : 'Unavailable', inline: true },
    { name: 'Liquidity', value: snap.liquidityUsd ? `$${Math.round(snap.liquidityUsd).toLocaleString()}` : 'Unavailable', inline: true },
  ];
  if (signal) fields.push({ name: 'V3 signal', value: `${signal.walletCount} wallet${signal.walletCount === 1 ? '' : 's'} · weight ${signal.totalWeight.toFixed(2)} · ${signal.qualified ? '✅ qualified' : '⏳ building'}`, inline: true });
  fields.push({ name: 'Result', value: resultText || 'Track only', inline: false });

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(`**${snap.info?.symbol || 'TOKEN'}** · \`${swap.mint}\``)
    .addFields(...fields)
    .setURL(explorerTx(tx.signature))
    .setTimestamp(new Date((tx.timestamp || Date.now() / 1000) * 1000))
    .setFooter({ text: 'Luna V3 · paper-first signal engine' });
  await ch.send({ embeds: [embed] });
}

function bestPaperLeader(store, participants) {
  const addresses = new Set(participants.map(x => x.address));
  return store.data.leaders
    .filter(l => addresses.has(l.address) && l.enabled !== false && leaderMode(l) === 'paper')
    .sort((a, b) => weightOf(b) - weightOf(a))[0] || null;
}

async function handleBuy(client, store, leader, swap, tx) {
  const s = store.data.settings;

  if (Number(swap.solAmount || 0) < Number(s.minLeaderBuySol || 0)) {
    if (s.skippedAlerts) await postTradeAlert(client, store, leader, swap, tx, `⛔ Ignored: leader buy below ${fmt(s.minLeaderBuySol, 4)} SOL`);
    return;
  }

  const signal = recordBuySignal(store, leader, swap, tx);
  if (!signal.qualified) {
    return postTradeAlert(client, store, leader, swap, tx, `⏳ Waiting for ${s.signalMinWallets} wallet(s) / ${Number(s.signalMinWeight).toFixed(2)} weight`, null, signal);
  }

  if (!signal.newlyQualified) {
    return postTradeAlert(client, store, leader, swap, tx, `🛡️ Signal already fired; ${s.signalCooldownSec}s duplicate cooldown active`, null, signal);
  }

  const executionLeader = bestPaperLeader(store, signal.participants);
  if (!executionLeader) {
    return postTradeAlert(client, store, leader, swap, tx, '👀 Signal qualified, but participating wallets are TRACK-only', null, signal);
  }

  const gate = await buyGate({ store, leader: executionLeader, swap, tx });
  if (!gate.ok) return postTradeAlert(client, store, leader, swap, tx, `⛔ Qualified signal skipped: ${gate.reason}`, gate.snap, signal);
  if (!s.paperTrading) return postTradeAlert(client, store, leader, swap, tx, '⏸️ Qualified signal; paper trading master switch OFF', gate.snap, signal);

  try {
    const r = await paperBuy({
      store,
      mint: swap.mint,
      solAmount: gate.buySol,
      leaderAddress: executionLeader.address,
      leaderLabel: executionLeader.label,
      signature: tx.signature,
    });
    store.resetDailyIfNeeded();
    store.data.daily.boughtSol += r.solAmount;
    store.save();
    return postTradeAlert(client, store, leader, swap, tx, `🧪 PAPER BUY ${r.solAmount.toFixed(3)} SOL · source ${executionLeader.label || short(executionLeader.address)}`, gate.snap, signal);
  } catch (e) {
    return postTradeAlert(client, store, leader, swap, tx, `⛔ Paper buy skipped: ${String(e.message).slice(0, 350)}`, gate.snap, signal);
  }
}

async function handleSell(client, store, leader, swap, tx) {
  const s = store.data.settings;
  const mode = leaderMode(leader);
  if (mode === 'track') return postTradeAlert(client, store, leader, swap, tx, '👀 Track-only sell signal');
  if (mode === 'legacy-live') return postTradeAlert(client, store, leader, swap, tx, '⚠️ Legacy live mode is alerts-only in V3');

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
  } catch (e) {
    return postTradeAlert(client, store, leader, swap, tx, `ℹ️ ${String(e.message).slice(0, 350)}`);
  }
}

async function pollLeader(client, store, leader) {
  const txs = await getRecentTransactions(leader.address, config.recentTxLimit, { fresh: true });
  if (!txs.length) return 0;

  if (!leader.lastSignature) {
    leader.lastSignature = txs[0].signature;
    leader.lastTimestamp = Number(txs[0].timestamp || 0);
    return 0;
  }

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

  if (!fresh.length) {
    leader.lastSignature = txs[0].signature;
    leader.lastTimestamp = Math.max(Number(leader.lastTimestamp || 0), Number(txs[0].timestamp || 0));
  }
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
    a.active = false;
    store.save();
    let info = null; try { info = await getTokenInfo(a.mint); } catch {}
    await ch.send(`🔔 **PRICE ALERT #${a.id}** — **${info?.symbol || short(a.mint)}** is $${fmt(p, 10)}, ${a.direction} your $${fmt(a.price, 10)} trigger.\nMint: \`${a.mint}\``);
  }
}

export function startMonitors(client, store) {
  let walletBusy = false;
  let priceBusy = false;

  // One due wallet per scheduler tick. Each wallet gets its own adaptive
  // nextPollAt, which keeps API usage roughly bounded as the list grows.
  setInterval(async () => {
    if (walletBusy || store.data.settings.paused) return;
    const now = Date.now();
    const due = store.data.leaders
      .filter(l => l.enabled !== false && Number(l.nextPollAt || 0) <= now)
      .sort((a, b) => Number(a.nextPollAt || 0) - Number(b.nextPollAt || 0));
    const leader = due[0];
    if (!leader) return;

    walletBusy = true;
    try {
      const activity = await pollLeader(client, store, leader);
      leader.pollErrors = 0;
      const recentlyActive = activity > 0 || (Number(leader.lastActivityAt || 0) > 0 && Date.now() - Number(leader.lastActivityAt) < config.walletHotHoldMs);
      leader.nextPollAt = Date.now() + (recentlyActive ? config.walletHotPollMs : config.walletIdlePollMs);
    } catch (e) {
      leader.pollErrors = Number(leader.pollErrors || 0) + 1;
      const rateLimited = isHeliusRateLimitError(e);
      const retry = Number(e?.retryAfterMs || 0);
      leader.nextPollAt = Date.now() + (rateLimited ? Math.max(config.walletIdlePollMs, retry) : Math.min(300000, config.walletIdlePollMs * Math.max(1, leader.pollErrors)));
      console.error(`Leader poll ${leader.address}:`, e.message);
    } finally {
      store.save();
      walletBusy = false;
    }
  }, config.walletSchedulerMs);

  setInterval(async () => {
    if (priceBusy || store.data.settings.paused) return;
    priceBusy = true;
    try { await pollPrices(client, store); }
    catch (e) { console.error('Price poll:', e.message); }
    finally { priceBusy = false; }
  }, config.pricePollMs);
}

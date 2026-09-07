import { EmbedBuilder } from 'discord.js';
import { getRecentTransactions } from './helius.js';
import { getPrices, getTokenInfo } from './jupiter.js';
import { getTokenBalanceRaw } from './solana.js';
import { config } from './config.js';
import { parseSwap, short, fmt } from './swap.js';
import { paperBuy, paperSell } from './paper.js';

function explorerTx(sig) { return `https://solscan.io/tx/${sig}`; }
function dex(mint) { return `https://dexscreener.com/solana/${mint}`; }

async function alertChannel(client, store) {
  const id = store.data.settings.alertChannelId;
  if (!id) return null;
  try { return await client.channels.fetch(id); } catch { return null; }
}

function leaderMode(leader) {
  return leader.copyMode === 'track' ? 'track' : leader.copyMode === 'paper' ? 'paper' : 'legacy-live';
}

async function tokenSnapshot(mint) {
  let info = null;
  let price = null;
  try {
    const [i, p] = await Promise.all([getTokenInfo(mint), getPrices([mint])]);
    info = i;
    price = p?.[mint] || null;
  } catch {}
  return {
    info,
    price,
    liquidityUsd: Number(price?.liquidity || 0),
    marketCapUsd: Number(price?.marketCap || price?.marketCapUsd || price?.mcap || info?.marketCap || info?.marketCapUsd || info?.mcap || 0),
  };
}

async function buyGate({ store, leader, swap, tx }) {
  const s = store.data.settings;
  if (store.data.blockedMints.includes(swap.mint)) return { ok: false, reason: 'Mint is on Luna blocklist' };

  if (s.maxEntryDelaySec > 0 && tx.timestamp) {
    const delay = Math.max(0, Math.round(Date.now() / 1000 - Number(tx.timestamp)));
    if (delay > s.maxEntryDelaySec) return { ok: false, reason: `Entry is ${delay}s old (max ${s.maxEntryDelaySec}s)` };
  }

  if (s.skipExistingPosition && leaderMode(leader) === 'paper') {
    const p = store.data.paper.positions.find(x => x.mint === swap.mint && x.tokenAmount > 0);
    if (p) return { ok: false, reason: 'Existing paper position already open' };
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
  return { ok: true, snap };
}

async function postTradeAlert(client, store, leader, swap, tx, resultText, snap = null) {
  const s = store.data.settings;
  if ((swap.side === 'BUY' && !s.buyAlerts) || (swap.side === 'SELL' && !s.sellAlerts)) return;
  const ch = await alertChannel(client, store);
  if (!ch?.isTextBased()) return;

  if (!snap) snap = await tokenSnapshot(swap.mint);
  const mode = leaderMode(leader);
  const title = `${swap.side === 'BUY' ? '🟢' : '🔴'} ${leader.label || short(leader.address)} ${swap.side}`;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(`**${snap.info?.symbol || 'TOKEN'}** · \`${swap.mint}\``)
    .addFields(
      { name: 'Leader', value: `\`${short(leader.address)}\``, inline: true },
      { name: 'Mode', value: mode === 'legacy-live' ? 'LEGACY LIVE (alerts only)' : mode.toUpperCase(), inline: true },
      { name: 'Leader trade', value: swap.side === 'BUY' ? `≈ ${fmt(swap.solAmount, 4)} SOL` : `${fmt(swap.tokenAmount, 4)} tokens → ≈ ${fmt(swap.solAmount, 4)} SOL`, inline: true },
      { name: 'Price', value: snap.price?.usdPrice ? `$${fmt(snap.price.usdPrice, 9)}` : 'Unavailable', inline: true },
      { name: 'Liquidity', value: snap.liquidityUsd ? `$${Math.round(snap.liquidityUsd).toLocaleString()}` : 'Unavailable', inline: true },
      { name: 'Copy result', value: resultText || 'Track only', inline: false },
    )
    .setURL(explorerTx(tx.signature))
    .setTimestamp(new Date((tx.timestamp || Date.now() / 1000) * 1000))
    .setFooter({ text: `Luna V2 · ${dex(swap.mint)}` });
  await ch.send({ embeds: [embed] });
}

async function handleBuy(client, store, leader, swap, tx) {
  const s = store.data.settings;
  const mode = leaderMode(leader);
  const buySol = Math.min(Number(leader.copyBuySol || s.copyBuySol), s.maxTradeSol);
  const gate = await buyGate({ store, leader, swap, tx });
  if (!gate.ok) return postTradeAlert(client, store, leader, swap, tx, `⛔ Skipped: ${gate.reason}`, gate.snap);

  if (mode === 'track') return postTradeAlert(client, store, leader, swap, tx, '👀 Track only — no paper copy executed', gate.snap);
  if (mode === 'legacy-live') return postTradeAlert(client, store, leader, swap, tx, '⚠️ This V2 install does not automatically execute real-money swaps; alert only.', gate.snap);
  if (!s.paperTrading) return postTradeAlert(client, store, leader, swap, tx, '⏸️ Paper trading master switch OFF', gate.snap);

  try {
    const r = await paperBuy({ store, mint: swap.mint, solAmount: buySol, leaderAddress: leader.address, leaderLabel: leader.label, signature: tx.signature });
    return postTradeAlert(client, store, leader, swap, tx, `🧪 PAPER BUY ${r.solAmount.toFixed(3)} SOL`, gate.snap);
  } catch (e) {
    return postTradeAlert(client, store, leader, swap, tx, `⛔ Paper buy skipped: ${String(e.message).slice(0, 350)}`, gate.snap);
  }
}

async function handleSell(client, store, leader, swap, tx) {
  const s = store.data.settings;
  const mode = leaderMode(leader);
  if (mode === 'track') return postTradeAlert(client, store, leader, swap, tx, '👀 Track only — no paper copy executed');
  if (mode === 'legacy-live') return postTradeAlert(client, store, leader, swap, tx, '⚠️ This V2 install does not automatically execute real-money swaps; alert only.');

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
  const txs = await getRecentTransactions(leader.address, 10);
  if (!txs.length) return;
  if (!leader.lastSignature) {
    leader.lastSignature = txs[0].signature;
    store.save();
    return;
  }
  const idx = txs.findIndex(t => t.signature === leader.lastSignature);
  let fresh = idx >= 0 ? txs.slice(0, idx) : txs.slice(0, 1);
  fresh = fresh.reverse();
  for (const tx of fresh) {
    const swap = parseSwap(tx, leader.address);
    if (swap?.side === 'BUY') await handleBuy(client, store, leader, swap, tx);
    if (swap?.side === 'SELL') await handleSell(client, store, leader, swap, tx);
    leader.lastSignature = tx.signature;
    store.save();
  }
  if (!fresh.length && txs[0].signature !== leader.lastSignature) {
    leader.lastSignature = txs[0].signature;
    store.save();
  }
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
    await ch.send(`🔔 **PRICE ALERT #${a.id}** — **${info?.symbol || short(a.mint)}** is $${fmt(p, 10)}, ${a.direction} your $${fmt(a.price, 10)} trigger.\nMint: \`${a.mint}\`\n${dex(a.mint)}`);
  }
}

export function startMonitors(client, store) {
  let walletBusy = false;
  let priceBusy = false;

  setInterval(async () => {
    if (walletBusy || store.data.settings.paused) return;
    walletBusy = true;
    try {
      for (const leader of store.data.leaders.filter(l => l.enabled !== false)) {
        try { await pollLeader(client, store, leader); }
        catch (e) { console.error(`Leader poll ${leader.address}:`, e.message); }
      }
    } finally { walletBusy = false; }
  }, config.walletPollMs);

  setInterval(async () => {
    if (priceBusy || store.data.settings.paused) return;
    priceBusy = true;
    try { await pollPrices(client, store); }
    catch (e) { console.error('Price poll:', e.message); }
    finally { priceBusy = false; }
  }, config.pricePollMs);
}

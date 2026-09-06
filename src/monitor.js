import { EmbedBuilder } from 'discord.js';
import { PublicKey } from '@solana/web3.js';
import { getRecentTransactions } from './helius.js';
import { getPrices, getTokenInfo, copyBuy, copySell } from './jupiter.js';
import { getTokenBalanceRaw } from './solana.js';
import { config, WSOL } from './config.js';

function short(a) { return a ? `${a.slice(0, 5)}…${a.slice(-5)}` : '—'; }
function fmt(n, d = 4) { return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: d }); }
function explorerTx(sig) { return `https://solscan.io/tx/${sig}`; }
function dex(mint) { return `https://dexscreener.com/solana/${mint}`; }

function txSwap(tx, wallet) {
  if (tx.type !== 'SWAP') return null;
  const deltas = new Map();
  let lamports = 0;

  for (const t of tx.nativeTransfers || []) {
    if (t.toUserAccount === wallet) lamports += Number(t.amount || 0);
    if (t.fromUserAccount === wallet) lamports -= Number(t.amount || 0);
  }
  for (const t of tx.tokenTransfers || []) {
    const mint = t.mint;
    if (!mint) continue;
    let d = deltas.get(mint) || 0;
    if (t.toUserAccount === wallet) d += Number(t.tokenAmount || 0);
    if (t.fromUserAccount === wallet) d -= Number(t.tokenAmount || 0);
    deltas.set(mint, d);
  }

  // Treat WSOL movement as SOL-equivalent and remove it from candidate tokens.
  let solDelta = lamports / 1e9 + (deltas.get(WSOL) || 0);
  deltas.delete(WSOL);
  const tokenMoves = [...deltas.entries()].filter(([, d]) => Math.abs(d) > 0);
  if (!tokenMoves.length) return null;

  const positive = tokenMoves.filter(([, d]) => d > 0).sort((a,b) => b[1]-a[1]);
  const negative = tokenMoves.filter(([, d]) => d < 0).sort((a,b) => a[1]-b[1]);

  if (solDelta < -0.00001 && positive.length) {
    const [mint, amount] = positive[0];
    return { side: 'BUY', mint, tokenAmount: amount, solAmount: Math.abs(solDelta) };
  }
  if (solDelta > 0.00001 && negative.length) {
    const [mint, amount] = negative[0];
    return { side: 'SELL', mint, tokenAmount: Math.abs(amount), solAmount: solDelta };
  }
  return null; // V1 deliberately ignores token↔token swaps.
}

async function alertChannel(client, store) {
  const id = store.data.settings.alertChannelId;
  if (!id) return null;
  try { return await client.channels.fetch(id); } catch { return null; }
}

async function postTradeAlert(client, store, leader, swap, tx, copied = null) {
  const s = store.data.settings;
  if ((swap.side === 'BUY' && !s.buyAlerts) || (swap.side === 'SELL' && !s.sellAlerts)) return;
  const ch = await alertChannel(client, store);
  if (!ch?.isTextBased()) return;

  let info = null, prices = {};
  try { [info, prices] = await Promise.all([getTokenInfo(swap.mint), getPrices([swap.mint])]); } catch {}
  const p = prices?.[swap.mint];
  const title = `${swap.side === 'BUY' ? '🟢' : '🔴'} ${leader.label || short(leader.address)} ${swap.side}`;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(`**${info?.symbol || 'TOKEN'}** · \`${swap.mint}\``)
    .addFields(
      { name: 'Leader', value: `\`${short(leader.address)}\``, inline: true },
      { name: 'Leader trade', value: swap.side === 'BUY' ? `≈ ${fmt(swap.solAmount, 4)} SOL` : `${fmt(swap.tokenAmount, 4)} tokens → ≈ ${fmt(swap.solAmount,4)} SOL`, inline: true },
      { name: 'Price', value: p?.usdPrice ? `$${fmt(p.usdPrice, 8)}` : 'Unavailable', inline: true },
      { name: 'Liquidity', value: p?.liquidity ? `$${Math.round(p.liquidity).toLocaleString()}` : 'Unavailable', inline: true },
      { name: 'Copy result', value: copied || (s.autocopy ? 'Pending / not executed' : 'Autocopy OFF'), inline: false },
    )
    .setURL(explorerTx(tx.signature))
    .setTimestamp(new Date((tx.timestamp || Date.now()/1000) * 1000))
    .setFooter({ text: `DEX chart: ${dex(swap.mint)}` });
  await ch.send({ embeds: [embed] });
}

async function handleSwap(client, store, leader, swap, tx, executionWallet) {
  const settings = store.data.settings;
  let copied = null;

  if (settings.autocopy) {
    if (!config.liveTradingEnabled || !executionWallet) {
      copied = '⛔ Blocked: live trading disabled in environment';
    } else if (swap.side === 'BUY') {
      store.resetDailyIfNeeded();
      const buySol = Math.min(settings.copyBuySol, settings.maxTradeSol);
      if (store.data.daily.boughtSol + buySol > settings.maxDailyBuySol) {
        copied = `⛔ Blocked: daily buy limit ${settings.maxDailyBuySol} SOL reached`;
      } else {
        try {
          const r = await copyBuy({ mint: swap.mint, solAmount: buySol, wallet: executionWallet, settings });
          store.data.daily.boughtSol += r.solAmount;
          store.save();
          copied = `✅ Copied ${r.solAmount} SOL · [tx](${explorerTx(r.result.signature)}) · est impact ${r.quality.impactPct.toFixed(2)}%`;
        } catch (e) {
          copied = `⛔ Copy buy skipped: ${String(e.message).slice(0, 350)}`;
        }
      }
    } else if (swap.side === 'SELL') {
      try {
        const ours = await getTokenBalanceRaw(executionWallet.publicKey.toBase58(), swap.mint);
        if (ours.raw === 0n) {
          copied = 'ℹ️ No copied position to sell';
        } else {
          let sellPct = 1;
          if (settings.sellMode === 'proportional') {
            const leaderAfter = await getTokenBalanceRaw(leader.address, swap.mint);
            const before = leaderAfter.ui + swap.tokenAmount;
            sellPct = before > 0 ? Math.min(1, Math.max(0, swap.tokenAmount / before)) : 1;
          }
          const raw = (ours.raw * BigInt(Math.max(1, Math.round(sellPct * 10000)))) / 10000n;
          const r = await copySell({ mint: swap.mint, rawAmount: raw, wallet: executionWallet });
          copied = `✅ Copied ${(sellPct*100).toFixed(1)}% sell · [tx](${explorerTx(r.result.signature)})`;
        }
      } catch (e) {
        copied = `⛔ Copy sell failed/skipped: ${String(e.message).slice(0, 350)}`;
      }
    }
  }

  await postTradeAlert(client, store, leader, swap, tx, copied);
}

async function pollLeader(client, store, leader, executionWallet) {
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
    const swap = txSwap(tx, leader.address);
    if (swap) await handleSwap(client, store, leader, swap, tx, executionWallet);
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
    await ch.send(`🔔 **PRICE ALERT #${a.id}** — **${info?.symbol || short(a.mint)}** is $${fmt(p, 10)}, ${a.direction} your $${fmt(a.price,10)} trigger.\nMint: \`${a.mint}\`\n${dex(a.mint)}`);
  }
}

export function startMonitors(client, store, executionWallet) {
  let walletBusy = false;
  let priceBusy = false;

  setInterval(async () => {
    if (walletBusy || store.data.settings.paused) return;
    walletBusy = true;
    try {
      for (const leader of store.data.leaders.filter(l => l.enabled !== false)) {
        try { await pollLeader(client, store, leader, executionWallet); }
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

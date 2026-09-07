import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { PublicKey } from '@solana/web3.js';
import { config } from './config.js';
import { StateStore } from './state.js';
import { getHeliusStats } from './helius.js';
import { getLatestSignature } from './solana.js';
import { startMonitors } from './monitor.js';
import { analyzeWallet } from './analytics.js';
import { paperPortfolio, resetPaper } from './paper.js';
import { short, fmt } from './swap.js';
import { getTokenIntel, getDiscoveryRadar, money } from './market.js';
import { analyzeWalletPerformance } from './wallet-performance.js';
import {
  executeBuy,
  executeSell,
  createLimitOrder,
  createDcaOrder,
  createAutoSellSet,
  listOrders,
  cancelOrder,
  createSniper,
  editSniperState,
  startV4Strategies,
} from './strategy.js';

const store = new StateStore();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const startedAt = Date.now();

const adminOnly = async (i) => {
  if (i.user.id === config.adminUserId) return true;
  await i.reply({ content: 'This bot is restricted to its configured admin.', ephemeral: true });
  return false;
};

function isSolAddress(s) { try { return new PublicKey(s).toBase58() === s; } catch { return false; } }
function requireMint(i, mint) {
  if (!isSolAddress(mint)) { i.reply({ content: 'Invalid Solana token mint.', ephemeral: true }); return false; }
  return true;
}
function tierWeight(tier) { return tier === 'A' ? 1.5 : tier === 'C' ? 0.75 : 1; }
function modeIcon(mode) { return mode === 'paper' ? '🧪' : mode === 'track' ? '👀' : '⚠️'; }
function modeLabel(mode) { return mode === 'paper' ? 'PAPER' : mode === 'track' ? 'TRACK' : 'LEGACY / ALERTS ONLY'; }
function ageText(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
function leaderText(l) {
  const weight = Number(l.weight || tierWeight(l.tier));
  const sizing = Number(l.copyBuyPct || 0) > 0 ? `${Number(l.copyBuyPct).toFixed(0)}% leader size` : `${l.copyBuySol || store.data.settings.copyBuySol} SOL`;
  const exits = [Number(l.autoTakeProfitPct || 0) > 0 ? `TP +${l.autoTakeProfitPct}%` : '', Number(l.autoStopLossPct || 0) > 0 ? `SL -${l.autoStopLossPct}%` : '', Number(l.trailingStopPct || 0) > 0 ? `trail ${l.trailingStopPct}%` : ''].filter(Boolean).join(' · ');
  return `${modeIcon(l.copyMode)} **${l.label || short(l.address)}** · Tier ${l.tier || 'B'} (${weight.toFixed(2)}x) · ${modeLabel(l.copyMode)} · ${l.enabled === false ? 'PAUSED' : 'ON'} · ${sizing}${l.copySells === false ? ' · sells OFF' : ''}${l.duplicateBuys ? ' · repeats ON' : ''}${exits ? ` · ${exits}` : ''}\n\`${l.address}\``;
}
function orderText(o) {
  const trigger = o.kind === 'dca'
    ? `${o.runsRemaining}/${o.runsTotal} runs · every ${o.intervalSec}s`
    : o.kind === 'trailing-stop'
      ? `${o.trailPct}% trail · high $${fmt(o.highWaterPriceUsd, 9)}${o.currentTrigger ? ` · stop $${fmt(o.currentTrigger, 9)}` : ''}`
      : `${o.direction || ''} ${o.targetType === 'mcap' ? money(o.target) : '$' + fmt(o.target, 10)}`;
  const size = o.side === 'buy' ? `${o.solAmount} SOL` : `${o.sellPct}%`;
  return `#${o.id} · **${String(o.kind).toUpperCase()} ${String(o.side).toUpperCase()}** · \`${short(o.mint)}\` · ${trigger} · ${size} · ${String(o.mode).toUpperCase()}`;
}

function settingsText() {
  const s = store.data.settings;
  return [
    `Luna V4: **${s.paused ? 'PAUSED' : 'RUNNING'}**`,
    `Tracked wallets: **${store.data.leaders.length}** · Open orders: **${store.data.orders.filter(o => o.status === 'open').length}** · Snipers: **${store.data.snipers.filter(x => x.enabled !== false).length}**`,
    `Paper trading: **${s.paperTrading ? 'ON' : 'OFF'}**`,
    `Live manual execution: **${config.liveTradingEnabled ? 'ENABLED' : 'DISABLED'}**`,
    `Live unattended automation: **${config.liveAutomationEnabled ? 'ENABLED' : 'DISABLED'}**`,
    `Default copied buy: **${s.copyBuySol} SOL** · Max copied trade: **${s.maxTradeSol} SOL**`,
    `Max manual/strategy buy: **${s.maxManualTradeSol} SOL**`,
    `Daily paper copy cap: **${s.maxDailyBuySol > 0 ? s.maxDailyBuySol + ' SOL' : 'OFF'}**`,
    `Global min liquidity: **${money(s.minLiquidityUsd)}** · Max market cap: **${s.maxMarketCapUsd > 0 ? money(s.maxMarketCapUsd) : 'OFF'}**`,
    `Signal consensus: **${s.signalMinWallets} wallet(s), ${Number(s.signalMinWeight).toFixed(2)} weight / ${s.signalWindowSec}s**`,
    `Global minimum leader buy: **${s.minLeaderBuySol} SOL** · Signal cooldown: **${s.signalCooldownSec}s**`,
    `Blocked mints: **${store.data.blockedMints.length}** · Watchlist: **${store.data.watchlist.length}**`,
    `Alert channel: ${s.alertChannelId ? `<#${s.alertChannelId}>` : '**not set**'}`,
  ].join('\n');
}

function advancedLeaderDefaults() {
  return {
    copyBuyPct: 0,
    copySells: true,
    duplicateBuys: false,
    minLeaderBuySol: null,
    minLiquidityUsd: null,
    minMarketCapUsd: null,
    maxMarketCapUsd: null,
    autoTakeProfitPct: 0,
    autoStopLossPct: 0,
    trailingStopPct: 0,
  };
}

function applyCopyOptions(interaction, leader) {
  const getNum = key => interaction.options.getNumber(key);
  const getBool = key => interaction.options.getBoolean(key);
  const label = interaction.options.getString('label');
  const mode = interaction.options.getString('mode');
  const tier = interaction.options.getString('tier');
  const weight = getNum('weight');
  const size = getNum('size');
  const copyPct = getNum('copypercent');
  const copySells = getBool('copysells');
  const duplicates = getBool('duplicates');
  const minbuy = getNum('minbuy');
  const minliq = getNum('minliq');
  const minmcap = getNum('minmcap');
  const maxmcap = getNum('maxmcap');
  const tp = getNum('tp');
  const sl = getNum('sl');
  const trailing = getNum('trailing');
  if (label !== null) leader.label = label;
  if (mode !== null) leader.copyMode = mode;
  if (tier !== null) { leader.tier = tier; if (weight === null) leader.weight = tierWeight(tier); }
  if (weight !== null) leader.weight = weight;
  if (size !== null) leader.copyBuySol = size;
  if (copyPct !== null) leader.copyBuyPct = copyPct;
  if (copySells !== null) leader.copySells = copySells;
  if (duplicates !== null) leader.duplicateBuys = duplicates;
  if (minbuy !== null) leader.minLeaderBuySol = minbuy;
  if (minliq !== null) leader.minLiquidityUsd = minliq;
  if (minmcap !== null) leader.minMarketCapUsd = minmcap;
  if (maxmcap !== null) leader.maxMarketCapUsd = maxmcap;
  if (tp !== null) leader.autoTakeProfitPct = tp;
  if (sl !== null) leader.autoStopLossPct = sl;
  if (trailing !== null) leader.trailingStopPct = trailing;
  return leader;
}

async function addLeader(wallet, label = null, mode = 'paper', tier = 'B') {
  if (!isSolAddress(wallet)) throw new Error('Invalid Solana wallet address.');
  if (store.data.leaders.some(l => l.address === wallet)) throw new Error('That wallet is already being watched.');
  let latest = null;
  try { latest = await getLatestSignature(wallet); } catch {}
  const leader = {
    ...advancedLeaderDefaults(),
    address: wallet,
    label: label || `Trader ${wallet.slice(0, 4)}`,
    enabled: true,
    copyMode: mode,
    copyBuySol: null,
    tier,
    weight: tierWeight(tier),
    lastSignature: latest?.signature || null,
    lastTimestamp: Number(latest?.blockTime || 0),
    lastActivityAt: 0,
    nextPollAt: 0,
    pollErrors: 0,
  };
  store.data.leaders.push(leader);
  return leader;
}

async function walletAnalysisEmbed(address) {
  const a = await analyzeWallet(address, 100);
  const age = a.newestAgeHours === null ? 'No parsed swaps' : a.newestAgeHours < 1 ? `${Math.max(1, Math.round(a.newestAgeHours * 60))}m ago` : `${a.newestAgeHours.toFixed(1)}h ago`;
  return new EmbedBuilder()
    .setTitle(`🧠 Luna V4 Copyability — ${a.score}/100 (${a.label})`)
    .setDescription(`\`${address}\``)
    .addFields(
      { name: 'Copyable swaps', value: `${a.copyableSwaps}/${a.swapTransactions}`, inline: true },
      { name: 'Buy / Sell', value: `${a.buys} / ${a.sells}`, inline: true },
      { name: 'Unique tokens', value: String(a.uniqueTokens), inline: true },
      { name: 'Median trade', value: `${fmt(a.medianTradeSol, 4)} SOL`, inline: true },
      { name: 'Parse rate', value: `${a.parseRatePct.toFixed(0)}%`, inline: true },
      { name: 'Latest parsed swap', value: age, inline: true },
      { name: 'Important', value: a.note, inline: false },
    )
    .setFooter({ text: 'Copyability is not verified profitability.' })
    .setTimestamp();
}

async function walletPnlEmbed(address, limit) {
  const p = await analyzeWalletPerformance(address, limit);
  const best = p.best.slice(0, 3).map(x => `\`${short(x.mint)}\` ${x.pnlSol >= 0 ? '+' : ''}${x.pnlSol.toFixed(3)} SOL`).join('\n') || '—';
  const worst = p.worst.slice(0, 3).map(x => `\`${short(x.mint)}\` ${x.pnlSol >= 0 ? '+' : ''}${x.pnlSol.toFixed(3)} SOL`).join('\n') || '—';
  return new EmbedBuilder()
    .setTitle('📊 V4 Wallet PnL Estimate')
    .setDescription(`\`${address}\``)
    .addFields(
      { name: 'Observed realized PnL', value: `${p.realizedPnlSol >= 0 ? '+' : ''}${p.realizedPnlSol.toFixed(3)} SOL`, inline: true },
      { name: 'Observed win rate', value: `${p.winRate.toFixed(1)}% (${p.wins}W / ${p.losses}L)`, inline: true },
      { name: 'Parsed swaps', value: `${p.parsedSwaps}/${p.sampledTransactions}`, inline: true },
      { name: 'Observed buys / sells', value: `${p.buys} / ${p.sells}`, inline: true },
      { name: 'Median hold', value: p.medianHoldSec == null ? '—' : ageText(p.medianHoldSec), inline: true },
      { name: 'Open observed cost', value: `${p.openCostSol.toFixed(3)} SOL across ${p.openPositions}`, inline: true },
      { name: 'Best observed tokens', value: best, inline: true },
      { name: 'Worst observed tokens', value: worst, inline: true },
      { name: 'Method note', value: p.note, inline: false },
    )
    .setTimestamp();
}

async function tokenIntelEmbed(mint) {
  const x = await getTokenIntel(mint);
  const riskText = x.rugUnavailable
    ? 'RugCheck unavailable — do not infer safety.'
    : [x.rugged ? '🚨 RugCheck marks this token as rugged.' : 'No RugCheck rugged flag in the current response.', x.rugScore == null ? '' : `Raw RugCheck score: ${x.rugScore}`, ...x.risks.slice(0, 4).map(r => `• ${r.level}: ${r.name}${r.description ? ` — ${r.description.slice(0, 120)}` : ''}`)].filter(Boolean).join('\n');
  const embed = new EmbedBuilder()
    .setTitle(`🔎 ${x.symbol} — ${x.name}`)
    .setDescription(`\`${mint}\``)
    .addFields(
      { name: 'Price', value: x.priceUsd ? `$${fmt(x.priceUsd, 10)}` : 'Unavailable', inline: true },
      { name: 'Liquidity', value: money(x.liquidityUsd), inline: true },
      { name: 'Market cap', value: x.marketCapUsd ? money(x.marketCapUsd) : 'Unavailable', inline: true },
      { name: '1h volume', value: money(x.volume1h), inline: true },
      { name: '5m buys / sells', value: `${x.buys5m} / ${x.sells5m}`, inline: true },
      { name: '1h change', value: `${x.priceChange1h >= 0 ? '+' : ''}${x.priceChange1h.toFixed(1)}%`, inline: true },
      { name: 'DEX / pair age', value: `${x.dexId || '—'} · ${x.pairCreatedAt ? ageText((Date.now() - x.pairCreatedAt) / 1000) : '—'}`, inline: true },
      { name: 'Jupiter organic score', value: x.organicScore ? x.organicScore.toFixed(1) : 'Unavailable', inline: true },
      { name: 'Boost activity', value: String(x.boosts || 0), inline: true },
      { name: 'Security signals', value: riskText.slice(0, 1024) || 'No security data returned.', inline: false },
    )
    .setFooter({ text: 'Security scanners are risk signals, not guarantees. Verify mint and liquidity before trading.' })
    .setTimestamp();
  if (x.pairUrl) embed.setURL(x.pairUrl);
  return embed;
}

async function dashboardEmbed() {
  const p = await paperPortfolio(store);
  const active = store.data.leaders.filter(l => l.enabled !== false).length;
  const wins = store.data.tradeHistory.filter(t => t.side === 'SELL' && Number(t.realizedPnlSol) > 0).length;
  const losses = store.data.tradeHistory.filter(t => t.side === 'SELL' && Number(t.realizedPnlSol) < 0).length;
  const closed = wins + losses;
  const h = getHeliusStats();
  store.resetDailyIfNeeded();
  return new EmbedBuilder()
    .setTitle('🌙 Luna Meme Bot V4')
    .setDescription(store.data.settings.paused ? '⏸️ Monitoring/strategies paused' : h.coolingDown ? '🟠 Running · Helius cooldown' : '🟢 Smart-money + strategy engine running')
    .addFields(
      { name: 'Paper equity', value: `${p.equitySol.toFixed(3)} SOL`, inline: true },
      { name: 'Paper PnL', value: `${p.totalPnlSol >= 0 ? '+' : ''}${p.totalPnlSol.toFixed(3)} SOL`, inline: true },
      { name: 'Observed exits win rate', value: closed ? `${((wins / closed) * 100).toFixed(1)}% (${closed})` : 'No realized exits', inline: true },
      { name: 'Open paper positions', value: String(p.positions.length), inline: true },
      { name: 'Tracked wallets', value: `${active}/${store.data.leaders.length}`, inline: true },
      { name: 'Open strategy orders', value: String(store.data.orders.filter(o => o.status === 'open').length), inline: true },
      { name: 'Autosnipers', value: String(store.data.snipers.filter(x => x.enabled !== false).length), inline: true },
      { name: 'Watchlist', value: String(store.data.watchlist.length), inline: true },
      { name: 'Signals stored', value: String(store.data.signalHistory.length), inline: true },
      { name: 'Helius', value: `${h.requests} req · ${h.rateLimited} 429s`, inline: true },
      { name: 'Live manual', value: config.liveTradingEnabled ? '⚠️ ENABLED' : 'OFF', inline: true },
      { name: 'Live automation', value: config.liveAutomationEnabled ? '⚠️ ENABLED' : 'OFF', inline: true },
    )
    .setFooter({ text: 'V4 defaults to paper. Live execution requires explicit environment opt-ins.' })
    .setTimestamp();
}

function healthText() {
  const h = getHeliusStats();
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  const cooldown = h.coolingDown ? `${Math.max(1, Math.ceil((h.backoffUntil - Date.now()) / 1000))}s` : 'none';
  return [
    '**🩺 Luna V4 Health**',
    `Uptime: **${Math.floor(uptime / 60)}m**`,
    `Helius: **${h.requests} requests · ${h.cacheHits} cache hits · ${h.rateLimited} 429s · ${h.failures} failures**`,
    `Helius quota exhausted: **${h.quotaExhausted ? 'YES' : 'NO'}** · cooldown: **${cooldown}**`,
    `Wallet scheduler: **${config.walletSchedulerMs}ms** · hot/idle: **${config.walletHotPollMs / 1000}s/${config.walletIdlePollMs / 1000}s**`,
    `Strategy poll: **${config.strategyPollMs / 1000}s** · launch-profile scan: **${config.launchPollMs / 1000}s**`,
    `Open orders: **${store.data.orders.filter(o => o.status === 'open').length}** · enabled snipers: **${store.data.snipers.filter(s => s.enabled !== false).length}**`,
    `Live manual: **${config.liveTradingEnabled ? 'ENABLED' : 'OFF'}** · unattended live: **${config.liveAutomationEnabled ? 'ENABLED' : 'OFF'}**`,
    h.lastError ? `Last Helius error: \`${String(h.lastError).slice(0, 500)}\`` : 'Last Helius error: **none**',
  ].join('\n');
}

client.once('ready', () => {
  console.log(`Luna V4 logged in as ${client.user.tag}`);
  startMonitors(client, store);
  startV4Strategies(client, store);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (!(await adminOnly(interaction))) return;
    const s = store.data.settings;

    if (interaction.commandName === 'dashboard') { await interaction.deferReply(); return interaction.editReply({ embeds: [await dashboardEmbed()] }); }
    if (interaction.commandName === 'health') return interaction.reply(healthText());
    if (interaction.commandName === 'signals') {
      const rows = store.data.signalHistory.slice(0, 10);
      return interaction.reply(rows.length ? `**📡 Recent smart-money signals**\n${rows.map((x, i) => `${i + 1}. BUY \`${short(x.mint)}\` · ${x.walletCount} wallets · weight ${Number(x.totalWeight).toFixed(2)} · <t:${Math.floor(new Date(x.at).getTime() / 1000)}:R>`).join('\n')}` : 'No qualified signals yet.');
    }
    if (interaction.commandName === 'positions') {
      await interaction.deferReply();
      const p = await paperPortfolio(store);
      if (!p.positions.length) return interaction.editReply(`No open paper positions. Cash: **${p.cashSol.toFixed(3)} SOL**.`);
      return interaction.editReply(`**🧪 Paper positions**\n${p.positions.slice(0, 20).map((x, i) => `${i + 1}. \`${short(x.mint)}\` · value **${x.valueSol.toFixed(3)} SOL** · PnL **${x.pnlSol >= 0 ? '+' : ''}${x.pnlSol.toFixed(3)} SOL (${x.pnlPct.toFixed(1)}%)** · ${x.leaderLabel || x.leaderAddress || 'Manual'}`).join('\n')}\n\nCash **${p.cashSol.toFixed(3)} SOL** · Equity **${p.equitySol.toFixed(3)} SOL**`);
    }
    if (interaction.commandName === 'history') {
      const rows = store.data.tradeHistory.slice(0, interaction.options.getInteger('limit') || 10);
      return interaction.reply(rows.length ? `**Recent Luna history**\n${rows.map(t => `#${t.id} ${t.mode === 'LIVE' ? '⚡' : '🧪'} ${t.side} \`${short(t.mint)}\` · ${t.solAmount == null ? '—' : Number(t.solAmount).toFixed(4) + ' SOL'}${t.side === 'SELL' && t.realizedPnlSol != null ? ` · PnL ${Number(t.realizedPnlSol) >= 0 ? '+' : ''}${Number(t.realizedPnlSol).toFixed(4)} SOL` : ''}`).join('\n')}` : 'No trade history yet.');
    }

    if (interaction.commandName === 'buy') {
      const mint = interaction.options.getString('mint', true).trim(); if (!requireMint(interaction, mint)) return;
      const solAmount = interaction.options.getNumber('sol', true); const mode = interaction.options.getString('mode') || 'paper';
      await interaction.deferReply();
      const r = await executeBuy({ store, mint, solAmount, mode, source: 'manual', automated: false });
      return interaction.editReply(`✅ **${mode.toUpperCase()} BUY** · ${Number(r.solAmount || solAmount).toFixed(4)} SOL · \`${mint}\`${r.signature ? `\nhttps://solscan.io/tx/${r.signature}` : ''}`);
    }
    if (interaction.commandName === 'sell') {
      const mint = interaction.options.getString('mint', true).trim(); if (!requireMint(interaction, mint)) return;
      const percent = interaction.options.getNumber('percent', true); const mode = interaction.options.getString('mode') || 'paper';
      await interaction.deferReply();
      const r = await executeSell({ store, mint, percent, mode, source: 'manual', automated: false, leaderAddress: mode === 'paper' ? 'manual' : null });
      return interaction.editReply(`✅ **${mode.toUpperCase()} SELL** · ${percent.toFixed(2)}% · \`${mint}\`${r.signature ? `\nhttps://solscan.io/tx/${r.signature}` : ''}`);
    }
    if (interaction.commandName === 'limit') {
      const mint = interaction.options.getString('mint', true).trim(); if (!requireMint(interaction, mint)) return;
      const side = interaction.options.getString('side', true); const solAmount = interaction.options.getNumber('sol'); const sellPct = interaction.options.getNumber('percent');
      if (side === 'buy' && solAmount == null) return interaction.reply({ content: 'Buy limit orders require `sol`.', ephemeral: true });
      if (side === 'sell' && sellPct == null) return interaction.reply({ content: 'Sell limit orders require `percent`.', ephemeral: true });
      await interaction.deferReply();
      const o = await createLimitOrder({ store, mint, side, direction: interaction.options.getString('direction', true), targetType: interaction.options.getString('targettype', true), target: interaction.options.getNumber('target', true), solAmount, sellPct, mode: interaction.options.getString('mode') || 'paper' });
      return interaction.editReply(`✅ Created ${orderText(o)}`);
    }
    if (interaction.commandName === 'dca') {
      const mint = interaction.options.getString('mint', true).trim(); if (!requireMint(interaction, mint)) return;
      const side = interaction.options.getString('side', true); const solAmount = interaction.options.getNumber('sol'); const sellPct = interaction.options.getNumber('percent');
      if (side === 'buy' && solAmount == null) return interaction.reply({ content: 'DCA buys require `sol` per run.', ephemeral: true });
      if (side === 'sell' && sellPct == null) return interaction.reply({ content: 'DCA sells require `percent` per run.', ephemeral: true });
      const o = await createDcaOrder({ store, mint, side, solAmount, sellPct, intervalSec: interaction.options.getInteger('interval', true), runs: interaction.options.getInteger('runs', true), mode: interaction.options.getString('mode') || 'paper' });
      return interaction.reply(`✅ Created ${orderText(o)}`);
    }
    if (interaction.commandName === 'autosell') {
      const mint = interaction.options.getString('mint', true).trim(); if (!requireMint(interaction, mint)) return;
      await interaction.deferReply();
      const rows = await createAutoSellSet({ store, mint, takeProfitPct: interaction.options.getNumber('takeprofit') || 0, stopLossPct: interaction.options.getNumber('stoploss') || 0, trailingPct: interaction.options.getNumber('trailing') || 0, sellPct: interaction.options.getNumber('percent') || 100, mode: interaction.options.getString('mode') || 'paper' });
      return interaction.editReply(`✅ Created auto-sell group:\n${rows.map(orderText).join('\n')}`);
    }
    if (interaction.commandName === 'orders') {
      const rows = listOrders(store, false).slice(0, 20);
      return interaction.reply(rows.length ? `**⚙️ Open V4 orders**\n${rows.map(orderText).join('\n')}` : 'No open strategy orders.');
    }
    if (interaction.commandName === 'cancelorder') {
      const o = cancelOrder(store, interaction.options.getInteger('id', true));
      return interaction.reply(o ? `✅ Cancelled order #${o.id}.` : 'No open order with that ID.');
    }

    if (interaction.commandName === 'sniper') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'add') {
        await interaction.deferReply();
        const row = await createSniper({ store, label: interaction.options.getString('label'), solAmount: interaction.options.getNumber('sol', true), minLiquidityUsd: interaction.options.getNumber('minliq') || 0, maxMarketCapUsd: interaction.options.getNumber('maxmcap') || 0, maxSnipes: interaction.options.getInteger('maxsnipes') || 1, mode: interaction.options.getString('mode') || 'paper' });
        return interaction.editReply(`🎯 Created launch-profile sniper **#${row.id} ${row.label}** · ${row.solAmount} SOL · min liq ${money(row.minLiquidityUsd)} · max mcap ${row.maxMarketCapUsd ? money(row.maxMarketCapUsd) : 'OFF'} · max ${row.maxSnipes} · ${row.mode.toUpperCase()}.\nIt seeds current profiles, so it only reacts to profiles first seen after creation.`);
      }
      if (sub === 'list') {
        const rows = store.data.snipers;
        return interaction.reply(rows.length ? `**🎯 Launch-profile snipers**\n${rows.map(x => `#${x.id} **${x.label}** · ${x.enabled === false ? 'PAUSED' : 'ON'} · ${x.mode.toUpperCase()} · ${x.solAmount} SOL · ${x.completed}/${x.maxSnipes} filled · min liq ${money(x.minLiquidityUsd)} · max mcap ${x.maxMarketCapUsd ? money(x.maxMarketCapUsd) : 'OFF'}`).join('\n')}` : 'No sniper setups.');
      }
      const id = interaction.options.getInteger('id', true); const row = editSniperState(store, id, sub);
      return interaction.reply(row ? `✅ ${sub} sniper #${id}.` : 'No sniper with that ID.');
    }

    if (interaction.commandName === 'token') {
      const mint = interaction.options.getString('mint', true).trim(); if (!requireMint(interaction, mint)) return;
      await interaction.deferReply(); return interaction.editReply({ embeds: [await tokenIntelEmbed(mint)] });
    }
    if (interaction.commandName === 'discover') {
      await interaction.deferReply();
      const rows = await getDiscoveryRadar(interaction.options.getInteger('limit') || 8);
      if (!rows.length) return interaction.editReply('No discovery results available right now.');
      return interaction.editReply(`**🔥 Solana discovery radar**\n_DexScreener boost/activity ranking — not a buy recommendation._\n${rows.map((x, i) => `${i + 1}. **${x.symbol}** · liq ${money(x.liquidityUsd)} · mcap ${money(x.marketCapUsd)} · 1h vol ${money(x.volume1h)} · 1h ${x.priceChange1h >= 0 ? '+' : ''}${x.priceChange1h.toFixed(1)}% · 5m B/S ${x.buys5m}/${x.sells5m}\n\`${x.mint}\``).join('\n')}`);
    }
    if (interaction.commandName === 'wallet' || interaction.commandName === 'score') {
      const key = interaction.commandName === 'wallet' ? 'address' : 'wallet'; const address = interaction.options.getString(key, true).trim();
      if (!isSolAddress(address)) return interaction.reply({ content: 'Invalid Solana wallet address.', ephemeral: true });
      await interaction.deferReply(); return interaction.editReply({ embeds: [await walletAnalysisEmbed(address)] });
    }
    if (interaction.commandName === 'walletpnl') {
      const address = interaction.options.getString('wallet', true).trim(); if (!isSolAddress(address)) return interaction.reply({ content: 'Invalid Solana wallet address.', ephemeral: true });
      await interaction.deferReply(); return interaction.editReply({ embeds: [await walletPnlEmbed(address, interaction.options.getInteger('limit') || 100)] });
    }
    if (interaction.commandName === 'watch') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'list') return interaction.reply(store.data.watchlist.length ? `**👁️ Watchlist**\n${store.data.watchlist.map((x, i) => `${i + 1}. **${x.label || short(x.mint)}** · \`${x.mint}\``).join('\n')}` : 'Watchlist is empty.');
      const mint = interaction.options.getString('mint', true).trim(); if (!requireMint(interaction, mint)) return;
      if (sub === 'add') {
        const existing = store.data.watchlist.find(x => x.mint === mint);
        if (existing) return interaction.reply('That mint is already on the watchlist.');
        store.data.watchlist.push({ mint, label: interaction.options.getString('label') || null, addedAt: new Date().toISOString() }); store.save();
        return interaction.reply(`👁️ Added \`${mint}\` to the watchlist.`);
      }
      store.data.watchlist = store.data.watchlist.filter(x => x.mint !== mint); store.save(); return interaction.reply(`✅ Removed \`${mint}\` from the watchlist.`);
    }

    if (interaction.commandName === 'copy') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'list') return interaction.reply(store.data.leaders.length ? store.data.leaders.map((l, i) => `${i + 1}. ${leaderText(l)}`).join('\n') : 'No wallets configured.');
      const wallet = interaction.options.getString('wallet', true).trim();
      if (sub === 'add') {
        const size = interaction.options.getNumber('size'); if (size !== null && size > s.maxTradeSol) return interaction.reply({ content: `Fixed size cannot exceed max copied trade (${s.maxTradeSol} SOL).`, ephemeral: true });
        await interaction.deferReply();
        const leader = await addLeader(wallet, interaction.options.getString('label'), interaction.options.getString('mode') || 'paper', interaction.options.getString('tier') || 'B');
        applyCopyOptions(interaction, leader); store.save();
        return interaction.editReply(`✅ Added ${leaderText(leader)}\nExisting transactions were seeded/ignored; only new activity will be processed.`);
      }
      const leader = store.data.leaders.find(l => l.address === wallet); if (!leader) return interaction.reply({ content: 'Wallet is not on the copy list.', ephemeral: true });
      if (sub === 'remove') { store.data.leaders = store.data.leaders.filter(l => l !== leader); store.save(); return interaction.reply(`✅ Removed \`${wallet}\`.`); }
      if (sub === 'pause') leader.enabled = false;
      if (sub === 'resume') { leader.enabled = true; leader.nextPollAt = 0; }
      if (sub === 'edit') {
        const size = interaction.options.getNumber('size'); if (size !== null && size > s.maxTradeSol) return interaction.reply({ content: `Fixed size cannot exceed max copied trade (${s.maxTradeSol} SOL).`, ephemeral: true });
        applyCopyOptions(interaction, leader);
      }
      store.save(); return interaction.reply(`✅ Updated ${leaderText(leader)}`);
    }

    if (interaction.commandName === 'signal') {
      const pairs = [['minwallets','signalMinWallets','int'],['minweight','signalMinWeight','num'],['window','signalWindowSec','int'],['minbuy','minLeaderBuySol','num'],['cooldown','signalCooldownSec','int']];
      let changed = 0;
      for (const [opt,key,type] of pairs) { const v = type === 'int' ? interaction.options.getInteger(opt) : interaction.options.getNumber(opt); if (v !== null) { s[key] = v; changed++; } }
      store.save(); return interaction.reply(`${changed ? '✅ Signal engine updated.\n' : ''}Wallets **${s.signalMinWallets}** · weight **${Number(s.signalMinWeight).toFixed(2)}** · window **${s.signalWindowSec}s** · min buy **${s.minLeaderBuySol} SOL** · cooldown **${s.signalCooldownSec}s**`);
    }
    if (interaction.commandName === 'paper') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'on') { s.paperTrading = true; store.save(); return interaction.reply('🧪 Paper copy trading is **ON**.'); }
      if (sub === 'off') { s.paperTrading = false; store.save(); return interaction.reply('Paper copy trading is **OFF**. Monitoring still continues.'); }
      if (sub === 'reset') { const starting = interaction.options.getNumber('sol') || 10; resetPaper(store, starting); return interaction.reply(`✅ Paper portfolio reset to **${starting} SOL**.`); }
      await interaction.deferReply(); const p = await paperPortfolio(store); return interaction.editReply(`🧪 Paper **${s.paperTrading ? 'ON' : 'OFF'}** · Cash **${p.cashSol.toFixed(3)} SOL** · Positions **${p.positionsSol.toFixed(3)} SOL** · Equity **${p.equitySol.toFixed(3)} SOL** · PnL **${p.totalPnlSol >= 0 ? '+' : ''}${p.totalPnlSol.toFixed(3)} SOL**`);
    }

    if (interaction.commandName === 'blockmint' || interaction.commandName === 'unblockmint') {
      const mint = interaction.options.getString('mint', true).trim(); if (!requireMint(interaction, mint)) return;
      if (interaction.commandName === 'blockmint') { if (!store.data.blockedMints.includes(mint)) store.data.blockedMints.push(mint); store.save(); return interaction.reply(`⛔ Blocked \`${mint}\` from new copied/manual/strategy buys.`); }
      store.data.blockedMints = store.data.blockedMints.filter(x => x !== mint); store.save(); return interaction.reply(`✅ Removed \`${mint}\` from blocklist.`);
    }
    if (interaction.commandName === 'blocklist') return interaction.reply(store.data.blockedMints.length ? store.data.blockedMints.map((m, i) => `${i + 1}. \`${m}\``).join('\n') : 'No blocked mints.');
    if (interaction.commandName === 'leader') {
      const wallet = interaction.options.getString('wallet', true).trim(); await interaction.deferReply(); const leader = await addLeader(wallet, interaction.options.getString('label'), 'paper', 'B'); store.save(); return interaction.editReply(`✅ Watching ${leaderText(leader)}`);
    }
    if (interaction.commandName === 'removeleader') { const wallet = interaction.options.getString('wallet', true).trim(); const before = store.data.leaders.length; store.data.leaders = store.data.leaders.filter(l => l.address !== wallet); store.save(); return interaction.reply(before === store.data.leaders.length ? 'Wallet was not on the leader list.' : `✅ Removed \`${wallet}\`.`); }
    if (interaction.commandName === 'leaders') return interaction.reply(store.data.leaders.length ? store.data.leaders.map((l, i) => `${i + 1}. ${leaderText(l)}`).join('\n') : 'No leaders selected.');
    if (interaction.commandName === 'setchannel') { s.alertChannelId = interaction.channelId; store.save(); return interaction.reply(`✅ Trade, order and sniper alerts will be posted in <#${interaction.channelId}>.`); }
    if (interaction.commandName === 'copysize') { const v = interaction.options.getNumber('sol', true); if (v > s.maxTradeSol) return interaction.reply({ content: `Size cannot exceed max copied trade (${s.maxTradeSol} SOL).`, ephemeral: true }); s.copyBuySol = v; store.save(); return interaction.reply(`✅ Default copied buys use **${v} SOL**.`); }
    if (interaction.commandName === 'risk') {
      const numeric = [['maxtrade','maxTradeSol'],['maxmanual','maxManualTradeSol'],['maxdaily','maxDailyBuySol'],['minliquidity','minLiquidityUsd'],['maxmarketcap','maxMarketCapUsd'],['minorganic','minOrganicScore']];
      let changed = 0; for (const [opt,key] of numeric) { const v = interaction.options.getNumber(opt); if (v !== null) { s[key] = v; changed++; } }
      const delay = interaction.options.getInteger('maxdelay'); if (delay !== null) { s.maxEntryDelaySec = delay; changed++; }
      const skip = interaction.options.getBoolean('skipexisting'); if (skip !== null) { s.skipExistingPosition = skip; changed++; }
      const skipped = interaction.options.getBoolean('skippedalerts'); if (skipped !== null) { s.skippedAlerts = skipped; changed++; }
      if (s.copyBuySol > s.maxTradeSol) s.copyBuySol = s.maxTradeSol; store.save(); return interaction.reply(changed ? `✅ Risk settings updated.\n${settingsText()}` : settingsText());
    }
    if (interaction.commandName === 'pricealert') { const mint = interaction.options.getString('mint', true).trim(); if (!requireMint(interaction, mint)) return; const a = { id: store.data.nextPriceAlertId++, mint, direction: interaction.options.getString('direction', true), price: interaction.options.getNumber('price', true), active: true }; store.data.priceAlerts.push(a); store.save(); return interaction.reply(`🔔 Price alert **#${a.id}**: \`${mint}\` ${a.direction} **$${a.price}**.`); }
    if (interaction.commandName === 'pricealerts') { const rows = store.data.priceAlerts.filter(x => x.active); return interaction.reply(rows.length ? rows.map(x => `#${x.id} · \`${x.mint}\` · ${x.direction} $${x.price}`).join('\n') : 'No active price alerts.'); }
    if (interaction.commandName === 'delpricealert') { const a = store.data.priceAlerts.find(x => x.id === interaction.options.getInteger('id', true) && x.active); if (!a) return interaction.reply('No active alert with that ID.'); a.active = false; store.save(); return interaction.reply(`✅ Deleted price alert #${a.id}.`); }
    if (interaction.commandName === 'tradealerts') { const buys = interaction.options.getBoolean('buys'), sells = interaction.options.getBoolean('sells'); if (buys !== null) s.buyAlerts = buys; if (sells !== null) s.sellAlerts = sells; store.save(); return interaction.reply(`Buy alerts **${s.buyAlerts ? 'ON' : 'OFF'}** · Sell alerts **${s.sellAlerts ? 'ON' : 'OFF'}**`); }
    if (interaction.commandName === 'pause') { s.paused = true; store.save(); return interaction.reply('⏸️ Wallet monitoring, paper copies and V4 strategies paused.'); }
    if (interaction.commandName === 'resume') { s.paused = false; for (const l of store.data.leaders) l.nextPollAt = 0; store.save(); return interaction.reply('▶️ Monitoring and strategies resumed.'); }
    if (interaction.commandName === 'status') return interaction.reply(settingsText());
    if (interaction.commandName === 'help') return interaction.reply([
      '**🌙 Luna Meme Bot V4 — Trojan/GMGN-style Discord toolkit**',
      '**Trade:** `/buy` · `/sell` · `/limit` · `/dca` · `/autosell` · `/orders` · `/cancelorder`',
      '**Snipe/discover:** `/sniper` · `/discover` · `/token` · `/watch`',
      '**Smart money:** `/wallet` · `/walletpnl` · `/copy` · `/signals` · `/signal`',
      '**Portfolio/risk:** `/dashboard` · `/positions` · `/history` · `/paper` · `/risk` · `/blockmint`',
      '**Ops:** `/health` · `/setchannel` · `/pricealert` · `/pause` · `/resume` · `/status`',
      '',
      'Paper is the default. Manual live execution requires `ENABLE_LIVE_TRADING=true`; unattended live limit/DCA/TP-SL/sniper execution additionally requires `ENABLE_LIVE_AUTOMATION=true`.',
      'The V4 sniper is a launch-profile scanner, not a first-block/Jito sniper.',
    ].join('\n'));
  } catch (e) {
    console.error(e);
    const msg = `Error: ${String(e.message || e).slice(0, 1500)}`;
    if (interaction.deferred) await interaction.editReply({ content: msg, embeds: [] });
    else if (interaction.replied) await interaction.followUp({ content: msg, ephemeral: true });
    else await interaction.reply({ content: msg, ephemeral: true });
  }
});

await client.login(config.discordToken);

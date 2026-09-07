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

const store = new StateStore();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const startedAt = Date.now();

const adminOnly = async (i) => {
  if (i.user.id === config.adminUserId) return true;
  await i.reply({ content: 'This bot is restricted to its configured admin.', ephemeral: true });
  return false;
};

function isSolAddress(s) { try { return new PublicKey(s).toBase58() === s; } catch { return false; } }
function tierWeight(tier) { return tier === 'A' ? 1.5 : tier === 'C' ? 0.75 : 1; }
function modeIcon(mode) { return mode === 'paper' ? '🧪' : mode === 'track' ? '👀' : '⚠️'; }
function modeLabel(mode) { return mode === 'paper' ? 'PAPER' : mode === 'track' ? 'TRACK' : 'LEGACY / ALERTS ONLY'; }
function leaderText(l) {
  const weight = Number(l.weight || tierWeight(l.tier));
  return `${modeIcon(l.copyMode)} **${l.label || short(l.address)}** · Tier ${l.tier || 'B'} (${weight.toFixed(2)}x) · ${modeLabel(l.copyMode)} · ${l.enabled === false ? 'PAUSED' : 'ON'} · \`${l.address}\`${l.copyBuySol ? ` · ${l.copyBuySol} SOL` : ''}`;
}

function settingsText() {
  const s = store.data.settings;
  return [
    `Luna V3: **${s.paused ? 'PAUSED' : 'RUNNING'}**`,
    `Tracked wallets: **${store.data.leaders.length}**`,
    `Paper trading: **${s.paperTrading ? 'ON' : 'OFF'}**`,
    `Default paper copy size: **${s.copyBuySol} SOL**`,
    `Max paper trade: **${s.maxTradeSol} SOL**`,
    `Daily paper buy cap: **${s.maxDailyBuySol > 0 ? s.maxDailyBuySol + ' SOL' : 'OFF'}**`,
    `Min liquidity: **$${Number(s.minLiquidityUsd).toLocaleString()}**`,
    `Max market cap: **${s.maxMarketCapUsd > 0 ? '$' + Number(s.maxMarketCapUsd).toLocaleString() : 'OFF'}**`,
    `Min organic score: **${s.minOrganicScore || 'OFF'}**`,
    `Max entry delay: **${s.maxEntryDelaySec > 0 ? s.maxEntryDelaySec + 's' : 'OFF'}**`,
    `Signal consensus: **${s.signalMinWallets} wallet(s), ${Number(s.signalMinWeight).toFixed(2)} weight / ${s.signalWindowSec}s**`,
    `Minimum leader buy: **${s.minLeaderBuySol} SOL**`,
    `Signal cooldown: **${s.signalCooldownSec}s**`,
    `Blocked mints: **${store.data.blockedMints.length}**`,
    `Alert channel: ${s.alertChannelId ? `<#${s.alertChannelId}>` : '**not set**'}`,
  ].join('\n');
}

async function addLeader(wallet, label, mode = 'paper', size = null, tier = 'B', customWeight = null) {
  if (!isSolAddress(wallet)) throw new Error('Invalid Solana wallet address.');
  if (!['paper', 'track'].includes(mode)) throw new Error('V3 supports TRACK or PAPER mode.');
  if (!['A', 'B', 'C'].includes(tier)) throw new Error('Tier must be A, B or C.');
  if (store.data.leaders.some(l => l.address === wallet)) throw new Error('That wallet is already being watched.');

  let latest = null;
  try { latest = await getLatestSignature(wallet); } catch {}

  const leader = {
    address: wallet,
    label: label || `Trader ${wallet.slice(0, 4)}`,
    enabled: true,
    copyMode: mode,
    copyBuySol: size || null,
    tier,
    weight: customWeight ?? tierWeight(tier),
    lastSignature: latest?.signature || null,
    lastTimestamp: Number(latest?.blockTime || 0),
    lastActivityAt: 0,
    nextPollAt: 0,
    pollErrors: 0,
  };
  store.data.leaders.push(leader);
  store.save();
  return leader;
}

async function walletAnalysisEmbed(address) {
  const a = await analyzeWallet(address, 100);
  const age = a.newestAgeHours === null ? 'No parsed swaps' : a.newestAgeHours < 1 ? `${Math.max(1, Math.round(a.newestAgeHours * 60))}m ago` : `${a.newestAgeHours.toFixed(1)}h ago`;
  return new EmbedBuilder()
    .setTitle(`🧠 Luna V3 Score — ${a.score}/100 (${a.label})`)
    .setDescription(`\`${address}\``)
    .addFields(
      { name: 'Copyable swaps', value: `${a.copyableSwaps}/${a.swapTransactions}`, inline: true },
      { name: 'Buy / Sell', value: `${a.buys} / ${a.sells}`, inline: true },
      { name: 'Unique tokens', value: String(a.uniqueTokens), inline: true },
      { name: 'Median trade', value: `${fmt(a.medianTradeSol, 4)} SOL`, inline: true },
      { name: 'Parse/copyability rate', value: `${a.parseRatePct.toFixed(0)}%`, inline: true },
      { name: 'Latest parsed swap', value: age, inline: true },
      { name: 'Important', value: a.note, inline: false },
    )
    .setFooter({ text: 'V3 score measures activity/copyability; it is not verified profitability.' })
    .setTimestamp();
}

async function dashboardEmbed() {
  const p = await paperPortfolio(store);
  const active = store.data.leaders.filter(l => l.enabled !== false).length;
  const wins = store.data.tradeHistory.filter(t => t.mode === 'PAPER' && t.side === 'SELL' && Number(t.realizedPnlSol) > 0).length;
  const losses = store.data.tradeHistory.filter(t => t.mode === 'PAPER' && t.side === 'SELL' && Number(t.realizedPnlSol) < 0).length;
  const closed = wins + losses;
  const winRate = closed ? (wins / closed) * 100 : 0;
  const h = getHeliusStats();
  store.resetDailyIfNeeded();

  return new EmbedBuilder()
    .setTitle('🌙 Luna Meme Bot V3')
    .setDescription(store.data.settings.paused ? '⏸️ Monitoring paused' : h.coolingDown ? '🟠 Monitoring active · Helius cooldown' : '🟢 Monitoring active')
    .addFields(
      { name: 'Paper equity', value: `${p.equitySol.toFixed(3)} SOL`, inline: true },
      { name: 'Paper PnL', value: `${p.totalPnlSol >= 0 ? '+' : ''}${p.totalPnlSol.toFixed(3)} SOL`, inline: true },
      { name: 'Paper win rate', value: closed ? `${winRate.toFixed(1)}% (${closed} exits)` : 'No exits yet', inline: true },
      { name: 'Open positions', value: String(p.positions.length), inline: true },
      { name: 'Active wallets', value: `${active}/${store.data.leaders.length}`, inline: true },
      { name: 'Signals stored', value: String(store.data.signalHistory.length), inline: true },
      { name: 'Today bought', value: `${Number(store.data.daily.boughtSol || 0).toFixed(3)} / ${store.data.settings.maxDailyBuySol > 0 ? Number(store.data.settings.maxDailyBuySol).toFixed(3) : '∞'} SOL`, inline: true },
      { name: 'Helius requests', value: `${h.requests} · 429s ${h.rateLimited}`, inline: true },
      { name: 'Consensus', value: `${store.data.settings.signalMinWallets} wallet(s) · ${Number(store.data.settings.signalMinWeight).toFixed(2)} weight`, inline: true },
    )
    .setFooter({ text: 'V3 is paper-first. Use /health and /signal for monitoring controls.' })
    .setTimestamp();
}

function healthText() {
  const h = getHeliusStats();
  const botUptime = Math.floor((Date.now() - startedAt) / 1000);
  const cooldown = h.coolingDown ? `${Math.max(1, Math.ceil((h.backoffUntil - Date.now()) / 1000))}s` : 'none';
  const errorLeaders = store.data.leaders.filter(l => Number(l.pollErrors || 0) > 0);
  return [
    '**🩺 Luna V3 Health**',
    `Bot uptime: **${Math.floor(botUptime / 60)}m**`,
    `Helius requests this process: **${h.requests}**`,
    `Helius cache hits: **${h.cacheHits}**`,
    `Helius 429s: **${h.rateLimited}**`,
    `Helius failures: **${h.failures}**`,
    `Helius quota exhausted: **${h.quotaExhausted ? 'YES' : 'NO'}**`,
    `Helius cooldown: **${cooldown}**`,
    `Last Helius status: **${h.lastStatus || '—'}**`,
    `Wallet scheduler: **${config.walletSchedulerMs}ms**`,
    `Hot / idle poll: **${config.walletHotPollMs / 1000}s / ${config.walletIdlePollMs / 1000}s**`,
    `Hot hold: **${Math.round(config.walletHotHoldMs / 1000)}s**`,
    `Signature preflight: **enabled**`,
    `Wallets with poll errors: **${errorLeaders.length}**`,
    h.lastError ? `Last API error: \`${String(h.lastError).slice(0, 500)}\`` : 'Last API error: **none**',
  ].join('\n');
}

client.once('ready', () => {
  console.log(`Luna V3 logged in as ${client.user.tag}`);
  startMonitors(client, store);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (!(await adminOnly(interaction))) return;
    const s = store.data.settings;

    if (interaction.commandName === 'dashboard') {
      await interaction.deferReply();
      return interaction.editReply({ embeds: [await dashboardEmbed()] });
    }
    if (interaction.commandName === 'health') return interaction.reply(healthText());
    if (interaction.commandName === 'signals') {
      const rows = store.data.signalHistory.slice(0, 10);
      if (!rows.length) return interaction.reply('No V3 signals have qualified yet.');
      return interaction.reply(`**📡 Recent V3 signals**\n${rows.map((x, i) => `${i + 1}. BUY \`${short(x.mint)}\` · ${x.walletCount} wallets · weight ${Number(x.totalWeight).toFixed(2)} · <t:${Math.floor(new Date(x.at).getTime() / 1000)}:R>`).join('\n')}`);
    }
    if (interaction.commandName === 'positions') {
      await interaction.deferReply();
      const p = await paperPortfolio(store);
      if (!p.positions.length) return interaction.editReply(`No open paper positions. Paper cash: **${p.cashSol.toFixed(3)} SOL**.`);
      const lines = p.positions.slice(0, 20).map((x, i) => `${i + 1}. \`${short(x.mint)}\` · value **${x.valueSol.toFixed(3)} SOL** · PnL **${x.pnlSol >= 0 ? '+' : ''}${x.pnlSol.toFixed(3)} SOL (${x.pnlPct.toFixed(1)}%)** · ${x.leaderLabel || short(x.leaderAddress)}`);
      return interaction.editReply(`**🧪 Paper positions**\n${lines.join('\n')}\n\nCash: **${p.cashSol.toFixed(3)} SOL** · Equity: **${p.equitySol.toFixed(3)} SOL**`);
    }
    if (interaction.commandName === 'history') {
      const limit = interaction.options.getInteger('limit') || 10;
      const rows = store.data.tradeHistory.slice(0, limit);
      if (!rows.length) return interaction.reply('No V3 trade history yet.');
      return interaction.reply(`**Recent Luna history**\n${rows.map(t => `#${t.id} ${t.mode === 'PAPER' ? '🧪' : '•'} ${t.side} \`${short(t.mint)}\` · ${t.solAmount == null ? '—' : Number(t.solAmount).toFixed(4) + ' SOL'}${t.side === 'SELL' && t.realizedPnlSol != null ? ` · PnL ${Number(t.realizedPnlSol) >= 0 ? '+' : ''}${Number(t.realizedPnlSol).toFixed(4)} SOL` : ''}`).join('\n')}`);
    }
    if (interaction.commandName === 'wallet' || interaction.commandName === 'score') {
      const key = interaction.commandName === 'wallet' ? 'address' : 'wallet';
      const address = interaction.options.getString(key, true).trim();
      if (!isSolAddress(address)) return interaction.reply({ content: 'Invalid Solana wallet address.', ephemeral: true });
      await interaction.deferReply();
      return interaction.editReply({ embeds: [await walletAnalysisEmbed(address)] });
    }

    if (interaction.commandName === 'copy') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'add') {
        const wallet = interaction.options.getString('wallet', true).trim();
        const label = interaction.options.getString('label');
        const mode = interaction.options.getString('mode') || 'paper';
        const tier = interaction.options.getString('tier') || 'B';
        const weight = interaction.options.getNumber('weight');
        const size = interaction.options.getNumber('size');
        if (size !== null && size > s.maxTradeSol) return interaction.reply({ content: `Size cannot exceed max paper trade (${s.maxTradeSol} SOL).`, ephemeral: true });
        await interaction.deferReply();
        const leader = await addLeader(wallet, label, mode, size, tier, weight);
        return interaction.editReply(`✅ Added ${leaderText(leader)}.\nExisting transactions were ignored; only new swaps will be processed.`);
      }
      if (sub === 'list') return interaction.reply(store.data.leaders.length ? store.data.leaders.map((l, i) => `${i + 1}. ${leaderText(l)}`).join('\n') : 'No wallets configured.');

      const wallet = interaction.options.getString('wallet', true).trim();
      const leader = store.data.leaders.find(l => l.address === wallet);
      if (!leader) return interaction.reply({ content: 'Wallet is not on the copy list.', ephemeral: true });
      if (sub === 'remove') store.data.leaders = store.data.leaders.filter(l => l !== leader);
      if (sub === 'pause') leader.enabled = false;
      if (sub === 'resume') { leader.enabled = true; leader.nextPollAt = 0; }
      if (sub === 'edit') {
        const label = interaction.options.getString('label');
        const mode = interaction.options.getString('mode');
        const tier = interaction.options.getString('tier');
        const weight = interaction.options.getNumber('weight');
        const size = interaction.options.getNumber('size');
        if (size !== null && size > s.maxTradeSol) return interaction.reply({ content: `Size cannot exceed max paper trade (${s.maxTradeSol} SOL).`, ephemeral: true });
        if (label !== null) leader.label = label;
        if (mode !== null) leader.copyMode = mode;
        if (tier !== null) { leader.tier = tier; if (weight === null) leader.weight = tierWeight(tier); }
        if (weight !== null) leader.weight = weight;
        if (size !== null) leader.copyBuySol = size;
      }
      store.save();
      if (sub === 'remove') return interaction.reply(`✅ Removed \`${wallet}\`.`);
      return interaction.reply(`✅ Updated ${leaderText(leader)}.`);
    }

    if (interaction.commandName === 'signal') {
      const minwallets = interaction.options.getInteger('minwallets');
      const minweight = interaction.options.getNumber('minweight');
      const window = interaction.options.getInteger('window');
      const minbuy = interaction.options.getNumber('minbuy');
      const cooldown = interaction.options.getInteger('cooldown');
      let changed = 0;
      if (minwallets !== null) { s.signalMinWallets = minwallets; changed++; }
      if (minweight !== null) { s.signalMinWeight = minweight; changed++; }
      if (window !== null) { s.signalWindowSec = window; changed++; }
      if (minbuy !== null) { s.minLeaderBuySol = minbuy; changed++; }
      if (cooldown !== null) { s.signalCooldownSec = cooldown; changed++; }
      store.save();
      return interaction.reply(`${changed ? '✅ Signal engine updated.\n' : ''}**V3 signal engine**\nWallets: **${s.signalMinWallets}** · Weight: **${Number(s.signalMinWeight).toFixed(2)}** · Window: **${s.signalWindowSec}s** · Min leader buy: **${s.minLeaderBuySol} SOL** · Cooldown: **${s.signalCooldownSec}s**`);
    }

    if (interaction.commandName === 'paper') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'on') { s.paperTrading = true; store.save(); return interaction.reply('🧪 Paper copy trading is **ON**.'); }
      if (sub === 'off') { s.paperTrading = false; store.save(); return interaction.reply('Paper copy trading is **OFF**. Monitoring still continues.'); }
      if (sub === 'reset') {
        const starting = interaction.options.getNumber('sol') || 10;
        resetPaper(store, starting);
        return interaction.reply(`✅ Paper portfolio reset to **${starting} SOL**. Open positions and paper history were cleared.`);
      }
      await interaction.deferReply();
      const p = await paperPortfolio(store);
      return interaction.editReply(`🧪 Paper: **${s.paperTrading ? 'ON' : 'OFF'}** · Cash **${p.cashSol.toFixed(3)} SOL** · Positions **${p.positionsSol.toFixed(3)} SOL** · Equity **${p.equitySol.toFixed(3)} SOL** · Total PnL **${p.totalPnlSol >= 0 ? '+' : ''}${p.totalPnlSol.toFixed(3)} SOL**`);
    }

    if (interaction.commandName === 'blockmint' || interaction.commandName === 'unblockmint') {
      const mint = interaction.options.getString('mint', true).trim();
      if (!isSolAddress(mint)) return interaction.reply({ content: 'Invalid token mint.', ephemeral: true });
      if (interaction.commandName === 'blockmint') {
        if (!store.data.blockedMints.includes(mint)) store.data.blockedMints.push(mint);
        store.save(); return interaction.reply(`⛔ Blocked \`${mint}\` from future paper-copy buys.`);
      }
      store.data.blockedMints = store.data.blockedMints.filter(x => x !== mint);
      store.save(); return interaction.reply(`✅ Removed \`${mint}\` from the blocklist.`);
    }
    if (interaction.commandName === 'blocklist') return interaction.reply(store.data.blockedMints.length ? store.data.blockedMints.map((m, i) => `${i + 1}. \`${m}\``).join('\n') : 'No blocked mints.');

    if (interaction.commandName === 'leader') {
      const wallet = interaction.options.getString('wallet', true).trim();
      const label = interaction.options.getString('label');
      await interaction.deferReply();
      const leader = await addLeader(wallet, label, 'paper', null, 'B', null);
      return interaction.editReply(`✅ Watching ${leaderText(leader)}.`);
    }
    if (interaction.commandName === 'removeleader') {
      const wallet = interaction.options.getString('wallet', true).trim();
      const before = store.data.leaders.length;
      store.data.leaders = store.data.leaders.filter(l => l.address !== wallet);
      store.save();
      return interaction.reply(before === store.data.leaders.length ? 'Wallet was not on the leader list.' : `✅ Removed \`${wallet}\`.`);
    }
    if (interaction.commandName === 'leaders') return interaction.reply(store.data.leaders.length ? store.data.leaders.map((l, i) => `${i + 1}. ${leaderText(l)}`).join('\n') : 'No leaders selected.');
    if (interaction.commandName === 'setchannel') { s.alertChannelId = interaction.channelId; store.save(); return interaction.reply(`✅ Trade and price alerts will be posted in <#${interaction.channelId}>.`); }
    if (interaction.commandName === 'copysize') {
      const v = interaction.options.getNumber('sol', true);
      if (v > s.maxTradeSol) return interaction.reply({ content: `Paper copy size cannot exceed max trade (${s.maxTradeSol} SOL).`, ephemeral: true });
      s.copyBuySol = v; store.save(); return interaction.reply(`✅ Default paper copied buys will use **${v} SOL**.`);
    }
    if (interaction.commandName === 'risk') {
      const numeric = [['maxtrade','maxTradeSol'],['maxdaily','maxDailyBuySol'],['minliquidity','minLiquidityUsd'],['maxmarketcap','maxMarketCapUsd'],['minorganic','minOrganicScore']];
      let changed = 0;
      for (const [opt, key] of numeric) { const v = interaction.options.getNumber(opt); if (v !== null) { s[key] = v; changed++; } }
      const delay = interaction.options.getInteger('maxdelay'); if (delay !== null) { s.maxEntryDelaySec = delay; changed++; }
      const skip = interaction.options.getBoolean('skipexisting'); if (skip !== null) { s.skipExistingPosition = skip; changed++; }
      const skippedAlerts = interaction.options.getBoolean('skippedalerts'); if (skippedAlerts !== null) { s.skippedAlerts = skippedAlerts; changed++; }
      if (s.copyBuySol > s.maxTradeSol) s.copyBuySol = s.maxTradeSol;
      store.save(); return interaction.reply(changed ? `✅ Risk settings updated.\n${settingsText()}` : settingsText());
    }
    if (interaction.commandName === 'pricealert') {
      const mint = interaction.options.getString('mint', true).trim();
      if (!isSolAddress(mint)) return interaction.reply({ content: 'Invalid token mint.', ephemeral: true });
      const a = { id: store.data.nextPriceAlertId++, mint, direction: interaction.options.getString('direction', true), price: interaction.options.getNumber('price', true), active: true };
      store.data.priceAlerts.push(a); store.save();
      return interaction.reply(`🔔 Price alert **#${a.id}**: \`${mint}\` ${a.direction} **$${a.price}**.`);
    }
    if (interaction.commandName === 'pricealerts') {
      const a = store.data.priceAlerts.filter(x => x.active);
      return interaction.reply(a.length ? a.map(x => `#${x.id} · \`${x.mint}\` · ${x.direction} $${x.price}`).join('\n') : 'No active price alerts.');
    }
    if (interaction.commandName === 'delpricealert') {
      const id = interaction.options.getInteger('id', true);
      const a = store.data.priceAlerts.find(x => x.id === id && x.active);
      if (!a) return interaction.reply('No active alert with that ID.');
      a.active = false; store.save(); return interaction.reply(`✅ Deleted price alert #${id}.`);
    }
    if (interaction.commandName === 'tradealerts') {
      const buys = interaction.options.getBoolean('buys');
      const sells = interaction.options.getBoolean('sells');
      if (buys !== null) s.buyAlerts = buys;
      if (sells !== null) s.sellAlerts = sells;
      store.save(); return interaction.reply(`Buy alerts: **${s.buyAlerts ? 'ON' : 'OFF'}** · Sell alerts: **${s.sellAlerts ? 'ON' : 'OFF'}**`);
    }
    if (interaction.commandName === 'pause') { s.paused = true; store.save(); return interaction.reply('⏸️ All monitoring and paper copying paused.'); }
    if (interaction.commandName === 'resume') { s.paused = false; for (const l of store.data.leaders) l.nextPollAt = 0; store.save(); return interaction.reply('▶️ Monitoring resumed.'); }
    if (interaction.commandName === 'status') return interaction.reply(settingsText());
    if (interaction.commandName === 'help') return interaction.reply([
      '**🌙 Luna Meme Bot V3**',
      '`/dashboard` · `/health` · `/signals`',
      '`/wallet` · `/score` · `/copy add|edit|remove|pause|resume|list`',
      '`/signal` · `/risk` · `/paper status|on|off|reset`',
      '`/positions` · `/history` · `/blockmint` · `/blocklist`',
      '`/setchannel` · `/pricealert` · `/pricealerts`',
      '`/pause` · `/resume` · `/status`',
      '',
      '**Modes:** 👀 TRACK = signal/alerts only · 🧪 PAPER = eligible for simulated consensus copies.',
      '**Tiers:** A = 1.5x · B = 1.0x · C = 0.75x by default.',
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

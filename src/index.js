import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { PublicKey } from '@solana/web3.js';
import { config } from './config.js';
import { StateStore } from './state.js';
import { getRecentTransactions } from './helius.js';
import { startMonitors } from './monitor.js';
import { analyzeWallet } from './analytics.js';
import { paperPortfolio, resetPaper } from './paper.js';
import { short, fmt } from './swap.js';

const store = new StateStore();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const adminOnly = async (i) => {
  if (i.user.id === config.adminUserId) return true;
  await i.reply({ content: 'This bot is restricted to its configured admin.', ephemeral: true });
  return false;
};

function isSolAddress(s) { try { return new PublicKey(s).toBase58() === s; } catch { return false; } }
function modeIcon(mode) { return mode === 'paper' ? '🧪' : mode === 'track' ? '👀' : '⚠️'; }
function modeLabel(mode) { return mode === 'paper' ? 'PAPER' : mode === 'track' ? 'TRACK' : 'LEGACY LIVE / ALERTS ONLY'; }
function leaderText(l) { return `${modeIcon(l.copyMode)} **${l.label || short(l.address)}** · ${modeLabel(l.copyMode)} · ${l.enabled === false ? 'PAUSED' : 'ON'} · \`${l.address}\`${l.copyBuySol ? ` · ${l.copyBuySol} SOL` : ''}`; }

function settingsText() {
  const s = store.data.settings;
  return [
    `Luna V2: **${s.paused ? 'PAUSED' : 'RUNNING'}**`,
    `Tracked wallets: **${store.data.leaders.length}**`,
    `Paper trading: **${s.paperTrading ? 'ON' : 'OFF'}**`,
    `Default paper copy size: **${s.copyBuySol} SOL**`,
    `Max paper trade: **${s.maxTradeSol} SOL**`,
    `Min liquidity: **$${s.minLiquidityUsd.toLocaleString()}**`,
    `Max market cap: **${s.maxMarketCapUsd > 0 ? '$' + s.maxMarketCapUsd.toLocaleString() : 'OFF'}**`,
    `Min organic score: **${s.minOrganicScore || 'OFF'}**`,
    `Max entry delay: **${s.maxEntryDelaySec > 0 ? s.maxEntryDelaySec + 's' : 'OFF'}**`,
    `Skip existing paper position: **${s.skipExistingPosition ? 'YES' : 'NO'}**`,
    `Blocked mints: **${store.data.blockedMints.length}**`,
    `Alert channel: ${s.alertChannelId ? `<#${s.alertChannelId}>` : '**not set**'}`,
  ].join('\n');
}

async function addLeader(wallet, label, mode = 'paper', size = null) {
  if (!isSolAddress(wallet)) throw new Error('Invalid Solana wallet address.');
  if (!['paper', 'track'].includes(mode)) throw new Error('V2 can add wallets in TRACK or PAPER mode.');
  if (store.data.leaders.some(l => l.address === wallet)) throw new Error('That wallet is already being watched.');
  const txs = await getRecentTransactions(wallet, 1);
  const leader = {
    address: wallet,
    label: label || `Trader ${wallet.slice(0, 4)}`,
    enabled: true,
    copyMode: mode,
    copyBuySol: size || null,
    lastSignature: txs[0]?.signature || null,
  };
  store.data.leaders.push(leader);
  store.save();
  return leader;
}

async function walletAnalysisEmbed(address) {
  const a = await analyzeWallet(address, 100);
  const age = a.newestAgeHours === null ? 'No parsed swaps' : a.newestAgeHours < 1 ? `${Math.max(1, Math.round(a.newestAgeHours * 60))}m ago` : `${a.newestAgeHours.toFixed(1)}h ago`;
  return new EmbedBuilder()
    .setTitle(`🧠 Luna Score — ${a.score}/100 (${a.label})`)
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
    .setFooter({ text: 'V2 score is a copyability/activity heuristic, not verified profitability.' })
    .setTimestamp();
}

async function dashboardEmbed() {
  const p = await paperPortfolio(store);
  const active = store.data.leaders.filter(l => l.enabled !== false).length;
  const paperWins = store.data.tradeHistory.filter(t => t.mode === 'PAPER' && t.side === 'SELL' && Number(t.realizedPnlSol) > 0).length;
  const paperLosses = store.data.tradeHistory.filter(t => t.mode === 'PAPER' && t.side === 'SELL' && Number(t.realizedPnlSol) < 0).length;
  const closed = paperWins + paperLosses;
  const winRate = closed ? (paperWins / closed) * 100 : 0;

  return new EmbedBuilder()
    .setTitle('🌙 Luna Meme Bot V2')
    .setDescription(store.data.settings.paused ? '⏸️ Monitoring paused' : '🟢 Monitoring active')
    .addFields(
      { name: 'Paper equity', value: `${p.equitySol.toFixed(3)} SOL`, inline: true },
      { name: 'Paper PnL', value: `${p.totalPnlSol >= 0 ? '+' : ''}${p.totalPnlSol.toFixed(3)} SOL`, inline: true },
      { name: 'Paper win rate', value: closed ? `${winRate.toFixed(1)}% (${closed} exits)` : 'No exits yet', inline: true },
      { name: 'Open positions', value: String(p.positions.length), inline: true },
      { name: 'Active wallets', value: `${active}/${store.data.leaders.length}`, inline: true },
      { name: 'Paper switch', value: store.data.settings.paperTrading ? '🧪 ON' : 'OFF', inline: true },
      { name: 'Blocked mints', value: String(store.data.blockedMints.length), inline: true },
    )
    .setFooter({ text: 'V2 defaults to paper copy mode for newly added wallets.' })
    .setTimestamp();
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
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

    if (interaction.commandName === 'positions') {
      await interaction.deferReply();
      const p = await paperPortfolio(store);
      if (!p.positions.length) return interaction.editReply(`No open paper positions. Paper cash: **${p.cashSol.toFixed(3)} SOL**.`);
      const lines = p.positions.slice(0, 20).map((x, i) => `${i + 1}. \`${short(x.mint)}\` · value **${x.valueSol.toFixed(3)} SOL** · PnL **${x.pnlSol >= 0 ? '+' : ''}${x.pnlSol.toFixed(3)} SOL (${x.pnlPct.toFixed(1)}%)**`);
      return interaction.editReply(`**🧪 Paper positions**\n${lines.join('\n')}\n\nCash: **${p.cashSol.toFixed(3)} SOL** · Equity: **${p.equitySol.toFixed(3)} SOL**`);
    }

    if (interaction.commandName === 'history') {
      const limit = interaction.options.getInteger('limit') || 10;
      const rows = store.data.tradeHistory.slice(0, limit);
      if (!rows.length) return interaction.reply('No V2 trade history yet.');
      const text = rows.map(t => `#${t.id} ${t.mode === 'PAPER' ? '🧪' : '•'} ${t.side} \`${short(t.mint)}\` · ${t.solAmount == null ? '—' : Number(t.solAmount).toFixed(4) + ' SOL'}${t.realizedPnlSol == null || t.side !== 'SELL' ? '' : ` · PnL ${Number(t.realizedPnlSol) >= 0 ? '+' : ''}${Number(t.realizedPnlSol).toFixed(4)} SOL`}`).join('\n');
      return interaction.reply(`**Recent Luna history**\n${text}`);
    }

    if (interaction.commandName === 'wallet') {
      const address = interaction.options.getString('address', true).trim();
      if (!isSolAddress(address)) return interaction.reply({ content: 'Invalid Solana wallet address.', ephemeral: true });
      await interaction.deferReply();
      return interaction.editReply({ embeds: [await walletAnalysisEmbed(address)] });
    }

    if (interaction.commandName === 'score') {
      const address = interaction.options.getString('wallet', true).trim();
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
        const size = interaction.options.getNumber('size');
        if (size !== null && size > s.maxTradeSol) return interaction.reply({ content: `Size cannot exceed max paper trade (${s.maxTradeSol} SOL).`, ephemeral: true });
        await interaction.deferReply();
        const leader = await addLeader(wallet, label, mode, size);
        return interaction.editReply(`✅ Added ${leaderText(leader)}.\nExisting transactions were ignored; only new swaps will be processed.`);
      }
      const wallet = sub === 'list' ? null : interaction.options.getString('wallet', true).trim();
      if (sub === 'list') return interaction.reply(store.data.leaders.length ? store.data.leaders.map((l, i) => `${i + 1}. ${leaderText(l)}`).join('\n') : 'No wallets configured.');
      const leader = store.data.leaders.find(l => l.address === wallet);
      if (!leader) return interaction.reply({ content: 'Wallet is not on the copy list.', ephemeral: true });
      if (sub === 'remove') store.data.leaders = store.data.leaders.filter(l => l !== leader);
      if (sub === 'pause') leader.enabled = false;
      if (sub === 'resume') leader.enabled = true;
      store.save();
      return interaction.reply(sub === 'remove' ? `✅ Removed \`${wallet}\`.` : `✅ ${sub === 'pause' ? 'Paused' : 'Resumed'} **${leader.label}**.`);
    }

    if (interaction.commandName === 'paper') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'on') { s.paperTrading = true; store.save(); return interaction.reply('🧪 Paper copy trading is **ON**.'); }
      if (sub === 'off') { s.paperTrading = false; store.save(); return interaction.reply('Paper copy trading is **OFF**. Monitoring still continues.'); }
      if (sub === 'reset') {
        const starting = interaction.options.getNumber('sol') || 10;
        resetPaper(store, starting);
        return interaction.reply(`✅ Paper portfolio reset to **${starting} SOL**. Open paper positions and paper history were cleared.`);
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
      const leader = await addLeader(wallet, label, 'paper', null);
      return interaction.editReply(`✅ Watching **${leader.label}** in **PAPER** mode — \`${wallet}\`. Use \`/copy add\` for TRACK/PAPER mode on new wallets.`);
    }
    if (interaction.commandName === 'removeleader') {
      const wallet = interaction.options.getString('wallet', true).trim();
      const before = store.data.leaders.length;
      store.data.leaders = store.data.leaders.filter(l => l.address !== wallet);
      store.save();
      return interaction.reply(before === store.data.leaders.length ? 'Wallet was not on the leader list.' : `✅ Removed \`${wallet}\`.`);
    }
    if (interaction.commandName === 'leaders') return interaction.reply(store.data.leaders.length ? store.data.leaders.map((l, i) => `${i + 1}. ${leaderText(l)}`).join('\n') : 'No leaders selected.');
    if (interaction.commandName === 'setchannel') {
      s.alertChannelId = interaction.channelId; store.save();
      return interaction.reply(`✅ Trade and price alerts will be posted in <#${interaction.channelId}>.`);
    }
    if (interaction.commandName === 'copysize') {
      const v = interaction.options.getNumber('sol', true);
      if (v > s.maxTradeSol) return interaction.reply({ content: `Paper copy size cannot exceed max trade (${s.maxTradeSol} SOL).`, ephemeral: true });
      s.copyBuySol = v; store.save(); return interaction.reply(`✅ Default paper copied buys will use **${v} SOL**.`);
    }
    if (interaction.commandName === 'risk') {
      const numeric = [['maxtrade','maxTradeSol'],['minliquidity','minLiquidityUsd'],['maxmarketcap','maxMarketCapUsd'],['minorganic','minOrganicScore']];
      let changed = 0;
      for (const [opt, key] of numeric) { const v = interaction.options.getNumber(opt); if (v !== null) { s[key] = v; changed++; } }
      const delay = interaction.options.getInteger('maxdelay'); if (delay !== null) { s.maxEntryDelaySec = delay; changed++; }
      const skip = interaction.options.getBoolean('skipexisting'); if (skip !== null) { s.skipExistingPosition = skip; changed++; }
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
      const id = interaction.options.getInteger('id', true); const a = store.data.priceAlerts.find(x => x.id === id && x.active);
      if (!a) return interaction.reply('No active alert with that ID.'); a.active = false; store.save(); return interaction.reply(`✅ Deleted price alert #${id}.`);
    }
    if (interaction.commandName === 'tradealerts') {
      const b = interaction.options.getBoolean('buys'), se = interaction.options.getBoolean('sells');
      if (b !== null) s.buyAlerts = b; if (se !== null) s.sellAlerts = se; store.save();
      return interaction.reply(`Buy alerts: **${s.buyAlerts ? 'ON' : 'OFF'}** · Sell alerts: **${s.sellAlerts ? 'ON' : 'OFF'}**`);
    }
    if (interaction.commandName === 'pause') { s.paused = true; store.save(); return interaction.reply('⏸️ All monitoring and paper copying paused.'); }
    if (interaction.commandName === 'resume') { s.paused = false; store.save(); return interaction.reply('▶️ Monitoring resumed.'); }
    if (interaction.commandName === 'status') return interaction.reply(settingsText());
    if (interaction.commandName === 'help') return interaction.reply([
      '**🌙 Luna Meme Bot V2**',
      '`/dashboard` · `/positions` · `/history`',
      '`/wallet address:<wallet>` · `/score wallet:<wallet>`',
      '`/copy add|remove|pause|resume|list`',
      '`/paper status|on|off|reset`',
      '`/blockmint` · `/unblockmint` · `/blocklist`',
      '`/setchannel` · `/pricealert` · `/pricealerts`',
      '`/copysize` · `/risk`',
      '`/pause` · `/resume` · `/status`',
      '',
      '**Modes:** 👀 TRACK = alerts only · 🧪 PAPER = simulated copying.',
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

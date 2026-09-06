import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { PublicKey } from '@solana/web3.js';
import { config } from './config.js';
import { StateStore } from './state.js';
import { getRecentTransactions } from './helius.js';
import { loadExecutionWallet } from './jupiter.js';
import { startMonitors } from './monitor.js';

const store = new StateStore();
let executionWallet = null;
try { executionWallet = loadExecutionWallet(); } catch (e) { console.error('Execution wallet:', e.message); }

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const adminOnly = async (i) => {
  if (i.user.id === config.adminUserId) return true;
  await i.reply({ content: 'This bot is restricted to its configured admin.', ephemeral: true });
  return false;
};

function isSolAddress(s) { try { return new PublicKey(s).toBase58() === s; } catch { return false; } }
function settingsText() {
  const s = store.data.settings;
  return [
    `Monitoring: **${s.paused ? 'PAUSED' : 'RUNNING'}**`,
    `Leaders: **${store.data.leaders.length}**`,
    `Alert channel: ${s.alertChannelId ? `<#${s.alertChannelId}>` : '**not set**'}`,
    `Autocopy command: **${s.autocopy ? 'ON' : 'OFF'}**`,
    `Live-trading master switch: **${config.liveTradingEnabled ? 'ENABLED' : 'DISABLED'}**`,
    `Copy buy size: **${s.copyBuySol} SOL**`,
    `Max trade: **${s.maxTradeSol} SOL**`,
    `Max daily buys: **${s.maxDailyBuySol} SOL**`,
    `Min liquidity: **$${s.minLiquidityUsd.toLocaleString()}**`,
    `Max estimated impact: **${s.maxEstimatedImpactPct}%**`,
    `Min organic score: **${s.minOrganicScore}**`,
    `Execution wallet: **${executionWallet ? executionWallet.publicKey.toBase58() : 'not loaded'}**`,
  ].join('\n');
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  startMonitors(client, store, executionWallet);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (!(await adminOnly(interaction))) return;
    const s = store.data.settings;

    if (interaction.commandName === 'leader') {
      const wallet = interaction.options.getString('wallet', true).trim();
      const label = interaction.options.getString('label') || `Trader ${wallet.slice(0,4)}`;
      if (!isSolAddress(wallet)) return interaction.reply({ content: 'Invalid Solana wallet address.', ephemeral: true });
      if (store.data.leaders.some(l => l.address === wallet)) return interaction.reply({ content: 'That wallet is already being watched.', ephemeral: true });
      const txs = await getRecentTransactions(wallet, 1);
      store.data.leaders.push({ address: wallet, label, enabled: true, lastSignature: txs[0]?.signature || null });
      store.save();
      return interaction.reply(`✅ Watching **${label}** — \`${wallet}\`. Existing transactions were ignored; only new swaps will alert.`);
    }
    if (interaction.commandName === 'removeleader') {
      const wallet = interaction.options.getString('wallet', true).trim();
      const before = store.data.leaders.length;
      store.data.leaders = store.data.leaders.filter(l => l.address !== wallet);
      store.save();
      return interaction.reply(before === store.data.leaders.length ? 'Wallet was not on the leader list.' : `✅ Removed \`${wallet}\`.`);
    }
    if (interaction.commandName === 'leaders') {
      const text = store.data.leaders.length ? store.data.leaders.map((l,i) => `${i+1}. **${l.label}** — \`${l.address}\``).join('\n') : 'No leaders selected.';
      return interaction.reply(text);
    }
    if (interaction.commandName === 'setchannel') {
      s.alertChannelId = interaction.channelId; store.save();
      return interaction.reply(`✅ Trade and price alerts will be posted in <#${interaction.channelId}>.`);
    }
    if (interaction.commandName === 'autocopy') {
      const enabled = interaction.options.getBoolean('enabled', true);
      if (enabled && !config.liveTradingEnabled) return interaction.reply({ content: '⛔ Live trading is blocked by ENABLE_LIVE_TRADING=false. Keep it this way while testing alerts; when ready, add a dedicated bot-wallet key and enable the environment switch.', ephemeral: true });
      if (enabled && !executionWallet) return interaction.reply({ content: '⛔ No execution wallet is loaded.', ephemeral: true });
      s.autocopy = enabled; store.save();
      return interaction.reply(`Automatic copy trading is now **${enabled ? 'ON' : 'OFF'}**.`);
    }
    if (interaction.commandName === 'copysize') {
      const v = interaction.options.getNumber('sol', true);
      if (v > s.maxTradeSol) return interaction.reply({ content: `Copy size cannot exceed max trade (${s.maxTradeSol} SOL). Change /risk maxtrade first.`, ephemeral: true });
      s.copyBuySol = v; store.save(); return interaction.reply(`✅ Copied leader buys will use **${v} SOL**.`);
    }
    if (interaction.commandName === 'risk') {
      const map = [['maxtrade','maxTradeSol'],['maxdaily','maxDailyBuySol'],['minliquidity','minLiquidityUsd'],['maximpact','maxEstimatedImpactPct'],['minorganic','minOrganicScore']];
      let changed = 0;
      for (const [opt,key] of map) { const v = interaction.options.getNumber(opt); if (v !== null) { s[key] = v; changed++; } }
      if (s.copyBuySol > s.maxTradeSol) s.copyBuySol = s.maxTradeSol;
      store.save(); return interaction.reply(changed ? `✅ Risk settings updated.\n${settingsText()}` : settingsText());
    }
    if (interaction.commandName === 'pricealert') {
      const mint = interaction.options.getString('mint', true).trim();
      if (!isSolAddress(mint)) return interaction.reply({ content:'Invalid token mint.', ephemeral:true });
      const a = { id: store.data.nextPriceAlertId++, mint, direction: interaction.options.getString('direction', true), price: interaction.options.getNumber('price', true), active: true };
      store.data.priceAlerts.push(a); store.save();
      return interaction.reply(`🔔 Price alert **#${a.id}**: \`${mint}\` ${a.direction} **$${a.price}**.`);
    }
    if (interaction.commandName === 'pricealerts') {
      const a = store.data.priceAlerts.filter(x=>x.active);
      return interaction.reply(a.length ? a.map(x=>`#${x.id} · \`${x.mint}\` · ${x.direction} $${x.price}`).join('\n') : 'No active price alerts.');
    }
    if (interaction.commandName === 'delpricealert') {
      const id = interaction.options.getInteger('id', true); const a = store.data.priceAlerts.find(x=>x.id===id && x.active);
      if (!a) return interaction.reply('No active alert with that ID.'); a.active=false; store.save(); return interaction.reply(`✅ Deleted price alert #${id}.`);
    }
    if (interaction.commandName === 'tradealerts') {
      const b=interaction.options.getBoolean('buys'), se=interaction.options.getBoolean('sells');
      if (b!==null) s.buyAlerts=b; if (se!==null) s.sellAlerts=se; store.save();
      return interaction.reply(`Buy alerts: **${s.buyAlerts?'ON':'OFF'}** · Sell alerts: **${s.sellAlerts?'ON':'OFF'}**`);
    }
    if (interaction.commandName === 'pause') { s.paused=true; store.save(); return interaction.reply('⏸️ Monitoring and copy execution paused.'); }
    if (interaction.commandName === 'resume') { s.paused=false; store.save(); return interaction.reply('▶️ Monitoring resumed.'); }
    if (interaction.commandName === 'wallet') return interaction.reply(executionWallet ? `Execution wallet (public address only): \`${executionWallet.publicKey.toBase58()}\`` : 'No live execution wallet is loaded.');
    if (interaction.commandName === 'status') return interaction.reply(settingsText());
    if (interaction.commandName === 'help') return interaction.reply([
      '**Copy Trader commands**',
      '`/leader wallet label` — watch/select a trader',
      '`/removeleader wallet` · `/leaders`',
      '`/setchannel` — use current channel for alerts',
      '`/tradealerts` — buy/sell alert toggles',
      '`/pricealert mint direction price` · `/pricealerts` · `/delpricealert`',
      '`/copysize sol` · `/risk`',
      '`/autocopy enabled` — live execution switch',
      '`/pause` · `/resume` · `/status` · `/wallet`',
    ].join('\n'));
  } catch (e) {
    console.error(e);
    const msg = `Error: ${String(e.message || e).slice(0, 1500)}`;
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: msg, ephemeral: true });
    else await interaction.reply({ content: msg, ephemeral: true });
  }
});

await client.login(config.discordToken);

import { EmbedBuilder, MessageFlags } from 'discord.js';
import { PublicKey } from '@solana/web3.js';
import { config, WSOL } from './config.js';
import { getTokenIntel, money } from './market.js';
import { getPrices } from './jupiter.js';
import { calculateAlphaScore } from './alpha.js';
import { rankTrackedWallets } from './smart-wallet.js';
import { createExitLadder } from './strategy.js';

const V5_COMMANDS = new Set(['alpha', 'radar', 'v5risk', 'ladder', 'stream']);
function isAddress(value) { try { return new PublicKey(value).toBase58() === value; } catch { return false; } }
function short(v) { return v ? `${v.slice(0, 5)}…${v.slice(-5)}` : '—'; }
function age(seconds) {
  if (!Number.isFinite(Number(seconds))) return '—';
  const s = Number(seconds);
  return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
}

function alphaEmbed(intel, alpha) {
  const b = alpha.breakdown;
  const security = [
    intel.rugged ? '🚨 Rugged flag' : 'No rugged flag returned',
    intel.top10HolderPct == null ? null : `Top-10 holders ${Number(intel.top10HolderPct).toFixed(1)}%`,
    intel.creatorHoldingPct == null ? null : `Creator ${Number(intel.creatorHoldingPct).toFixed(1)}%`,
    intel.mintAuthority ? 'Mint authority present' : null,
    intel.freezeAuthority ? 'Freeze authority present' : null,
  ].filter(Boolean).join(' · ');
  return new EmbedBuilder()
    .setTitle(`🌙 Luna Alpha ${alpha.score}/100 — ${alpha.label}`)
    .setDescription(`**${intel.symbol || 'TOKEN'} — ${intel.name || 'Unknown'}**\n\`${intel.mint}\``)
    .addFields(
      { name: 'Smart money', value: `${b.smartMoney.score.toFixed(0)}/30\n${b.smartMoney.note}`, inline: true },
      { name: 'Safety', value: `${b.safety.score.toFixed(0)}/25\n${b.safety.note}`, inline: true },
      { name: 'Flow', value: `${b.flow.score.toFixed(0)}/20\n${b.flow.note}`, inline: true },
      { name: 'Entry', value: `${b.entry.score.toFixed(0)}/15\n${b.entry.note}`, inline: true },
      { name: 'Execution', value: `${b.execution.score.toFixed(0)}/10\n${b.execution.note}`, inline: true },
      { name: 'Market', value: `${money(intel.marketCapUsd)} mcap · ${money(intel.liquidityUsd)} liq · ${money(intel.volume1h)} 1h vol`, inline: true },
      { name: 'Holder/security snapshot', value: security || 'Extended holder data unavailable', inline: false },
    )
    .setFooter({ text: 'Alpha is a risk/entry heuristic, not a guarantee of profit.' })
    .setTimestamp();
}

export function startV5Discord(client, store, streamStatsProvider = null) {
  if (client.__lunaV5DiscordStarted) return;
  client.__lunaV5DiscordStarted = true;

  client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() || !V5_COMMANDS.has(interaction.commandName)) return;
    if (interaction.user.id !== config.adminUserId) {
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'This bot is restricted to its configured admin.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    try {
      if (interaction.commandName === 'alpha') {
        const mint = interaction.options.getString('mint', true).trim();
        if (!isAddress(mint)) return interaction.reply({ content: 'Invalid Solana token mint.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply();
        const [intel, prices] = await Promise.all([getTokenIntel(mint), getPrices([WSOL])]);
        const alpha = calculateAlphaScore({ intel, solPriceUsd: Number(prices?.[WSOL]?.usdPrice || 0) });
        return interaction.editReply({ embeds: [alphaEmbed(intel, alpha)] });
      }

      if (interaction.commandName === 'radar') {
        await interaction.deferReply();
        const rows = await rankTrackedWallets(store, interaction.options.getInteger('limit') || 8);
        if (!rows.length) return interaction.editReply('No enabled tracked wallets are available to rank.');
        return interaction.editReply(`**🧠 Luna V5 Smart Wallet Radar**\n_Observed-window score; sniper-like wallets are penalized._\n${rows.map((x, i) => `${i + 1}. **${x.labelName || short(x.address)} — ${x.score}/100 ${x.label}** · PnL ${x.realizedPnlSol >= 0 ? '+' : ''}${x.realizedPnlSol.toFixed(2)} SOL · WR ${x.winRate.toFixed(1)}% · hold ${x.medianHoldSec == null ? '—' : age(x.medianHoldSec)}${x.sniperLike ? ' · ⚠️ sniper-like' : ''}\n\`${x.address}\``).join('\n')}`);
      }

      if (interaction.commandName === 'v5risk') {
        const s = store.data.settings;
        const maxChase = interaction.options.getNumber('maxchase');
        const minAlpha = interaction.options.getNumber('minalpha');
        const quoteAge = interaction.options.getInteger('quoteage');
        const slippage = interaction.options.getInteger('slippagebps');
        if (maxChase !== null) s.maxChasePct = maxChase;
        if (minAlpha !== null) s.minAlphaScore = minAlpha;
        if (quoteAge !== null) s.maxQuoteAgeMs = quoteAge;
        if (slippage !== null) s.fixedSlippageBps = slippage;
        store.save();
        return interaction.reply([
          '**🛡️ V5 entry/execution protection**',
          `Max chase: **${Number(s.maxChasePct || 0) > 0 ? `${s.maxChasePct}%` : 'OFF'}**`,
          `Minimum Alpha: **${Number(s.minAlphaScore || 0) > 0 ? `${s.minAlphaScore}/100` : 'OFF'}**`,
          `Max live quote age: **${s.maxQuoteAgeMs}ms**`,
          `Slippage: **${Number(s.fixedSlippageBps || 0) > 0 ? `${s.fixedSlippageBps} bps fixed` : 'Jupiter RTSE'}**`,
        ].join('\n'));
      }

      if (interaction.commandName === 'ladder') {
        const mint = interaction.options.getString('mint', true).trim();
        if (!isAddress(mint)) return interaction.reply({ content: 'Invalid Solana token mint.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply();
        const rows = await createExitLadder({
          store,
          mint,
          tp1Pct: interaction.options.getNumber('tp1') || 0,
          sell1Pct: interaction.options.getNumber('sell1') || 25,
          tp2Pct: interaction.options.getNumber('tp2') || 0,
          sell2Pct: interaction.options.getNumber('sell2') || 25,
          stopLossPct: interaction.options.getNumber('stoploss') || 0,
          trailingPct: interaction.options.getNumber('trailing') || 0,
          mode: interaction.options.getString('mode') || 'paper',
        });
        return interaction.editReply(`✅ **Position-aware exit ladder created**\n${rows.map(o => `#${o.id} · ${String(o.kind).toUpperCase()} · ${o.kind === 'trailing-stop' ? `${o.trailPct}% trail` : `$${Number(o.target).toPrecision(6)}`} · sell ${o.sellPct}% of remaining`).join('\n')}\n\nPartial take-profits no longer cancel the downside protection for the remaining position.`);
      }

      if (interaction.commandName === 'stream') {
        const st = streamStatsProvider?.() || {};
        const persistence = store.getPersistenceStatus?.() || { mode: 'local' };
        return interaction.reply([
          '**⚡ Luna V5 runtime**',
          `Realtime accelerator: **${st.enabled ? (st.connected ? 'CONNECTED' : 'RECONNECTING') : 'OFF'}**`,
          `Subscriptions: **${st.subscriptions || 0}** · notifications: **${st.notifications || 0}** · reconnects: **${st.reconnects || 0}**`,
          `Last stream event: **${st.lastEventAt ? age((Date.now() - st.lastEventAt) / 1000) + ' ago' : 'none yet'}**`,
          `Persistence: **${String(persistence.mode || 'local').toUpperCase()}**${persistence.ready === false ? ' · initializing/fallback' : ''}`,
          st.lastError ? `Stream error: \`${String(st.lastError).slice(0, 300)}\`` : '',
        ].filter(Boolean).join('\n'));
      }
    } catch (e) {
      const text = `V5 error: ${String(e.message || e).slice(0, 1200)}`;
      if (interaction.deferred) await interaction.editReply({ content: text, embeds: [] }).catch(() => {});
      else if (!interaction.replied) await interaction.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });
}

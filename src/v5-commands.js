import { SlashCommandBuilder } from 'discord.js';

const executionChoices = [
  { name: 'Paper', value: 'paper' },
  { name: 'Live (requires env opt-in)', value: 'live' },
];

export const v5Commands = [
  new SlashCommandBuilder().setName('alpha').setDescription('Score a token with the Luna V5 Alpha Engine')
    .addStringOption(o => o.setName('mint').setDescription('Solana token mint').setRequired(true)),

  new SlashCommandBuilder().setName('radar').setDescription('Rank your tracked wallets by V5 smart-wallet quality')
    .addIntegerOption(o => o.setName('limit').setDescription('Wallets to show').setMinValue(1).setMaxValue(10)),

  new SlashCommandBuilder().setName('v5risk').setDescription('Configure V5 entry-quality and execution protection')
    .addNumberOption(o => o.setName('maxchase').setDescription('Maximum % above leader entry (0 disables)').setMinValue(0).setMaxValue(500))
    .addNumberOption(o => o.setName('minalpha').setDescription('Minimum Luna Alpha score for copied buys (0 disables)').setMinValue(0).setMaxValue(100))
    .addIntegerOption(o => o.setName('quoteage').setDescription('Maximum live quote age in milliseconds').setMinValue(500).setMaxValue(10000))
    .addIntegerOption(o => o.setName('slippagebps').setDescription('Fixed slippage bps; 0 keeps Jupiter RTSE').setMinValue(0).setMaxValue(5000)),

  new SlashCommandBuilder().setName('ladder').setDescription('Create a position-aware TP ladder with downside protection')
    .addStringOption(o => o.setName('mint').setDescription('Token mint').setRequired(true))
    .addNumberOption(o => o.setName('tp1').setDescription('First take-profit % above current price').setMinValue(0.01).setMaxValue(10000))
    .addNumberOption(o => o.setName('sell1').setDescription('% of remaining position to sell at TP1').setMinValue(0.01).setMaxValue(100))
    .addNumberOption(o => o.setName('tp2').setDescription('Second take-profit % above current price').setMinValue(0.01).setMaxValue(10000))
    .addNumberOption(o => o.setName('sell2').setDescription('% of remaining position to sell at TP2').setMinValue(0.01).setMaxValue(100))
    .addNumberOption(o => o.setName('stoploss').setDescription('Stop-loss % below current price').setMinValue(0.01).setMaxValue(99.9))
    .addNumberOption(o => o.setName('trailing').setDescription('Trailing stop %').setMinValue(0.01).setMaxValue(99.9))
    .addStringOption(o => o.setName('mode').setDescription('Paper or live automation').addChoices(...executionChoices)),

  new SlashCommandBuilder().setName('stream').setDescription('Show realtime wallet-stream and persistence status'),
].map(c => c.toJSON());

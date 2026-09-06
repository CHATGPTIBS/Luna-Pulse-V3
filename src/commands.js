import { SlashCommandBuilder, ChannelType } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('leader').setDescription('Add/select a trader wallet to watch')
    .addStringOption(o => o.setName('wallet').setDescription('Solana wallet address').setRequired(true))
    .addStringOption(o => o.setName('label').setDescription('Name for this trader').setRequired(false)),
  new SlashCommandBuilder().setName('removeleader').setDescription('Stop watching a trader wallet')
    .addStringOption(o => o.setName('wallet').setDescription('Solana wallet address').setRequired(true)),
  new SlashCommandBuilder().setName('leaders').setDescription('List watched trader wallets'),
  new SlashCommandBuilder().setName('setchannel').setDescription('Send trade and price alerts to this channel'),
  new SlashCommandBuilder().setName('autocopy').setDescription('Enable or disable automatic copy trading')
    .addBooleanOption(o => o.setName('enabled').setDescription('Enable live copy trading').setRequired(true)),
  new SlashCommandBuilder().setName('copysize').setDescription('Set fixed SOL size copied on each leader buy')
    .addNumberOption(o => o.setName('sol').setDescription('SOL per copied buy').setMinValue(0.001).setRequired(true)),
  new SlashCommandBuilder().setName('risk').setDescription('Set copy-trading risk limits')
    .addNumberOption(o => o.setName('maxtrade').setDescription('Maximum SOL per copied buy').setMinValue(0.001))
    .addNumberOption(o => o.setName('maxdaily').setDescription('Maximum total SOL bought per UTC day').setMinValue(0.001))
    .addNumberOption(o => o.setName('minliquidity').setDescription('Minimum token liquidity in USD').setMinValue(0))
    .addNumberOption(o => o.setName('maximpact').setDescription('Maximum estimated price impact %').setMinValue(0.1).setMaxValue(50))
    .addNumberOption(o => o.setName('minorganic').setDescription('Minimum Jupiter organic score (0 disables)').setMinValue(0).setMaxValue(100)),
  new SlashCommandBuilder().setName('pricealert').setDescription('Create a one-shot token price alert')
    .addStringOption(o => o.setName('mint').setDescription('Token mint').setRequired(true))
    .addStringOption(o => o.setName('direction').setDescription('Trigger direction').setRequired(true).addChoices(
      { name: 'Above', value: 'above' }, { name: 'Below', value: 'below' }))
    .addNumberOption(o => o.setName('price').setDescription('USD trigger price').setMinValue(0).setRequired(true)),
  new SlashCommandBuilder().setName('pricealerts').setDescription('List active price alerts'),
  new SlashCommandBuilder().setName('delpricealert').setDescription('Delete a price alert')
    .addIntegerOption(o => o.setName('id').setDescription('Alert ID').setMinValue(1).setRequired(true)),
  new SlashCommandBuilder().setName('tradealerts').setDescription('Turn detected buy/sell alerts on or off')
    .addBooleanOption(o => o.setName('buys').setDescription('Post leader buy alerts'))
    .addBooleanOption(o => o.setName('sells').setDescription('Post leader sell alerts')),
  new SlashCommandBuilder().setName('pause').setDescription('Pause monitoring/copy execution'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume monitoring/copy execution'),
  new SlashCommandBuilder().setName('status').setDescription('Show bot status and current settings'),
  new SlashCommandBuilder().setName('wallet').setDescription('Show the execution wallet public address'),
  new SlashCommandBuilder().setName('help').setDescription('Show command help'),
].map(c => c.toJSON());

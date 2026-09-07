import { SlashCommandBuilder } from 'discord.js';

const tierChoices = [
  { name: 'A — highest conviction', value: 'A' },
  { name: 'B — standard', value: 'B' },
  { name: 'C — experimental', value: 'C' },
];
const modeChoices = [
  { name: 'Track only', value: 'track' },
  { name: 'Paper copy', value: 'paper' },
];

export const commands = [
  new SlashCommandBuilder().setName('dashboard').setDescription('Show the Luna V3 trading dashboard'),
  new SlashCommandBuilder().setName('health').setDescription('Show V3 API, Helius and monitor health'),
  new SlashCommandBuilder().setName('signals').setDescription('Show recent V3 smart-money signals'),
  new SlashCommandBuilder().setName('positions').setDescription('Show current paper positions and unrealized PnL'),
  new SlashCommandBuilder().setName('history').setDescription('Show recent paper-copy history')
    .addIntegerOption(o => o.setName('limit').setDescription('Number of trades (1-20)').setMinValue(1).setMaxValue(20)),
  new SlashCommandBuilder().setName('wallet').setDescription('Analyze a Solana wallet')
    .addStringOption(o => o.setName('address').setDescription('Wallet address to analyze').setRequired(true)),
  new SlashCommandBuilder().setName('score').setDescription('Calculate a Luna V3 wallet copyability score')
    .addStringOption(o => o.setName('wallet').setDescription('Solana wallet address').setRequired(true)),

  new SlashCommandBuilder().setName('copy').setDescription('Manage tracked/paper-copy wallets')
    .addSubcommand(sc => sc.setName('add').setDescription('Add a trader wallet')
      .addStringOption(o => o.setName('wallet').setDescription('Solana wallet address').setRequired(true))
      .addStringOption(o => o.setName('label').setDescription('Trader label'))
      .addStringOption(o => o.setName('mode').setDescription('How to follow the wallet').addChoices(...modeChoices))
      .addStringOption(o => o.setName('tier').setDescription('Signal confidence tier').addChoices(...tierChoices))
      .addNumberOption(o => o.setName('weight').setDescription('Custom signal weight (0.1-5)').setMinValue(0.1).setMaxValue(5))
      .addNumberOption(o => o.setName('size').setDescription('Paper SOL per copied buy').setMinValue(0.001)))
    .addSubcommand(sc => sc.setName('edit').setDescription('Edit a trader wallet')
      .addStringOption(o => o.setName('wallet').setDescription('Solana wallet address').setRequired(true))
      .addStringOption(o => o.setName('label').setDescription('New trader label'))
      .addStringOption(o => o.setName('mode').setDescription('How to follow the wallet').addChoices(...modeChoices))
      .addStringOption(o => o.setName('tier').setDescription('Signal confidence tier').addChoices(...tierChoices))
      .addNumberOption(o => o.setName('weight').setDescription('Signal weight (0.1-5)').setMinValue(0.1).setMaxValue(5))
      .addNumberOption(o => o.setName('size').setDescription('Paper SOL per copied buy').setMinValue(0.001)))
    .addSubcommand(sc => sc.setName('remove').setDescription('Remove a trader wallet')
      .addStringOption(o => o.setName('wallet').setDescription('Solana wallet address').setRequired(true)))
    .addSubcommand(sc => sc.setName('pause').setDescription('Pause one trader wallet')
      .addStringOption(o => o.setName('wallet').setDescription('Solana wallet address').setRequired(true)))
    .addSubcommand(sc => sc.setName('resume').setDescription('Resume one trader wallet')
      .addStringOption(o => o.setName('wallet').setDescription('Solana wallet address').setRequired(true)))
    .addSubcommand(sc => sc.setName('list').setDescription('List tracked/paper-copy wallets')),

  new SlashCommandBuilder().setName('signal').setDescription('Configure the V3 smart-money signal engine')
    .addIntegerOption(o => o.setName('minwallets').setDescription('Distinct wallets required to qualify').setMinValue(1).setMaxValue(10))
    .addNumberOption(o => o.setName('minweight').setDescription('Combined wallet weight required').setMinValue(0).setMaxValue(20))
    .addIntegerOption(o => o.setName('window').setDescription('Consensus window in seconds').setMinValue(30).setMaxValue(3600))
    .addNumberOption(o => o.setName('minbuy').setDescription('Minimum leader buy size in SOL').setMinValue(0))
    .addIntegerOption(o => o.setName('cooldown').setDescription('Duplicate signal cooldown in seconds').setMinValue(0).setMaxValue(86400)),

  new SlashCommandBuilder().setName('paper').setDescription('Manage V3 paper trading')
    .addSubcommand(sc => sc.setName('status').setDescription('Show paper portfolio status'))
    .addSubcommand(sc => sc.setName('on').setDescription('Enable paper copy execution'))
    .addSubcommand(sc => sc.setName('off').setDescription('Disable paper copy execution'))
    .addSubcommand(sc => sc.setName('reset').setDescription('Reset paper portfolio and history')
      .addNumberOption(o => o.setName('sol').setDescription('Starting paper SOL balance').setMinValue(0.1))),

  new SlashCommandBuilder().setName('blockmint').setDescription('Block a token mint from new paper-copy buys')
    .addStringOption(o => o.setName('mint').setDescription('Token mint').setRequired(true)),
  new SlashCommandBuilder().setName('unblockmint').setDescription('Remove a mint from the copy blocklist')
    .addStringOption(o => o.setName('mint').setDescription('Token mint').setRequired(true)),
  new SlashCommandBuilder().setName('blocklist').setDescription('List token mints blocked from copied buys'),

  new SlashCommandBuilder().setName('leader').setDescription('Add a trader wallet in paper mode (legacy shortcut)')
    .addStringOption(o => o.setName('wallet').setDescription('Solana wallet address').setRequired(true))
    .addStringOption(o => o.setName('label').setDescription('Name for this trader')),
  new SlashCommandBuilder().setName('removeleader').setDescription('Stop watching a trader wallet (legacy shortcut)')
    .addStringOption(o => o.setName('wallet').setDescription('Solana wallet address').setRequired(true)),
  new SlashCommandBuilder().setName('leaders').setDescription('List watched trader wallets'),
  new SlashCommandBuilder().setName('setchannel').setDescription('Send trade and price alerts to this channel'),
  new SlashCommandBuilder().setName('copysize').setDescription('Set default paper SOL size copied on each buy')
    .addNumberOption(o => o.setName('sol').setDescription('Paper SOL per copied buy').setMinValue(0.001).setRequired(true)),
  new SlashCommandBuilder().setName('risk').setDescription('Set V3 paper-copy risk filters')
    .addNumberOption(o => o.setName('maxtrade').setDescription('Maximum paper SOL per copied buy').setMinValue(0.001))
    .addNumberOption(o => o.setName('maxdaily').setDescription('Maximum paper SOL bought per UTC day (0 disables)').setMinValue(0))
    .addNumberOption(o => o.setName('minliquidity').setDescription('Minimum token liquidity in USD').setMinValue(0))
    .addNumberOption(o => o.setName('maxmarketcap').setDescription('Maximum market cap USD (0 disables)').setMinValue(0))
    .addNumberOption(o => o.setName('minorganic').setDescription('Minimum Jupiter organic score (0 disables)').setMinValue(0).setMaxValue(100))
    .addIntegerOption(o => o.setName('maxdelay').setDescription('Maximum copied entry delay in seconds (0 disables)').setMinValue(0).setMaxValue(3600))
    .addBooleanOption(o => o.setName('skipexisting').setDescription('Skip buys when Luna already has a paper position'))
    .addBooleanOption(o => o.setName('skippedalerts').setDescription('Post alerts for tiny/filtered buys')),
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
  new SlashCommandBuilder().setName('pause').setDescription('Pause all monitoring/paper copying'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume all monitoring'),
  new SlashCommandBuilder().setName('status').setDescription('Show bot status and current settings'),
  new SlashCommandBuilder().setName('help').setDescription('Show V3 command help'),
].map(c => c.toJSON());

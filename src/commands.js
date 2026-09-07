import { SlashCommandBuilder } from 'discord.js';

const tierChoices = [
  { name: 'A — highest conviction', value: 'A' },
  { name: 'B — standard', value: 'B' },
  { name: 'C — experimental', value: 'C' },
];
const copyModeChoices = [
  { name: 'Track only', value: 'track' },
  { name: 'Paper copy', value: 'paper' },
];
const executionChoices = [
  { name: 'Paper', value: 'paper' },
  { name: 'Live (requires env opt-in)', value: 'live' },
];
const sideChoices = [
  { name: 'Buy', value: 'buy' },
  { name: 'Sell', value: 'sell' },
];

function copyOptions(sc, editing = false) {
  sc.addStringOption(o => o.setName('wallet').setDescription('Solana wallet address').setRequired(true));
  sc.addStringOption(o => o.setName('label').setDescription(editing ? 'New trader label' : 'Trader label'));
  sc.addStringOption(o => o.setName('mode').setDescription('How to follow the wallet').addChoices(...copyModeChoices));
  sc.addStringOption(o => o.setName('tier').setDescription('Signal confidence tier').addChoices(...tierChoices));
  sc.addNumberOption(o => o.setName('weight').setDescription('Signal weight (0.1-5)').setMinValue(0.1).setMaxValue(5));
  sc.addNumberOption(o => o.setName('size').setDescription('Fixed paper SOL per copied buy').setMinValue(0.001));
  sc.addNumberOption(o => o.setName('copypercent').setDescription('% of leader buy to copy (0 uses fixed size)').setMinValue(0).setMaxValue(500));
  sc.addBooleanOption(o => o.setName('copysells').setDescription('Mirror this wallet’s sells'));
  sc.addBooleanOption(o => o.setName('duplicates').setDescription('Allow repeated buys of the same open token'));
  sc.addNumberOption(o => o.setName('minbuy').setDescription('Minimum leader buy in SOL').setMinValue(0));
  sc.addNumberOption(o => o.setName('minliq').setDescription('Per-wallet minimum liquidity USD').setMinValue(0));
  sc.addNumberOption(o => o.setName('minmcap').setDescription('Per-wallet minimum market cap USD').setMinValue(0));
  sc.addNumberOption(o => o.setName('maxmcap').setDescription('Per-wallet maximum market cap USD (0 off)').setMinValue(0));
  sc.addNumberOption(o => o.setName('tp').setDescription('Auto take-profit % after copied entry (0 off)').setMinValue(0).setMaxValue(10000));
  sc.addNumberOption(o => o.setName('sl').setDescription('Auto stop-loss % after copied entry (0 off)').setMinValue(0).setMaxValue(99.9));
  sc.addNumberOption(o => o.setName('trailing').setDescription('Trailing stop % after copied entry (0 off)').setMinValue(0).setMaxValue(99.9));
  return sc;
}

export const commands = [
  new SlashCommandBuilder().setName('dashboard').setDescription('Show the Luna V4 trading dashboard'),
  new SlashCommandBuilder().setName('health').setDescription('Show API, Helius and strategy health'),
  new SlashCommandBuilder().setName('signals').setDescription('Show recent smart-money signals'),
  new SlashCommandBuilder().setName('positions').setDescription('Show current paper positions and unrealized PnL'),
  new SlashCommandBuilder().setName('history').setDescription('Show recent paper/live history')
    .addIntegerOption(o => o.setName('limit').setDescription('Number of trades (1-20)').setMinValue(1).setMaxValue(20)),

  new SlashCommandBuilder().setName('buy').setDescription('Buy a Solana token now')
    .addStringOption(o => o.setName('mint').setDescription('Token mint').setRequired(true))
    .addNumberOption(o => o.setName('sol').setDescription('SOL amount').setMinValue(0.001).setRequired(true))
    .addStringOption(o => o.setName('mode').setDescription('Paper or explicitly enabled live execution').addChoices(...executionChoices)),
  new SlashCommandBuilder().setName('sell').setDescription('Sell a percentage of a token position now')
    .addStringOption(o => o.setName('mint').setDescription('Token mint').setRequired(true))
    .addNumberOption(o => o.setName('percent').setDescription('Percent to sell').setMinValue(0.01).setMaxValue(100).setRequired(true))
    .addStringOption(o => o.setName('mode').setDescription('Paper or explicitly enabled live execution').addChoices(...executionChoices)),

  new SlashCommandBuilder().setName('limit').setDescription('Create a price or market-cap limit order')
    .addStringOption(o => o.setName('side').setDescription('Buy or sell').setRequired(true).addChoices(...sideChoices))
    .addStringOption(o => o.setName('mint').setDescription('Token mint').setRequired(true))
    .addStringOption(o => o.setName('targettype').setDescription('Target price or market cap').setRequired(true).addChoices(
      { name: 'Price USD', value: 'price' }, { name: 'Market cap USD', value: 'mcap' }))
    .addStringOption(o => o.setName('direction').setDescription('Trigger above or below target').setRequired(true).addChoices(
      { name: 'Above', value: 'above' }, { name: 'Below', value: 'below' }))
    .addNumberOption(o => o.setName('target').setDescription('Target USD value').setMinValue(0).setRequired(true))
    .addNumberOption(o => o.setName('sol').setDescription('SOL to buy (buy orders)').setMinValue(0.001))
    .addNumberOption(o => o.setName('percent').setDescription('% to sell (sell orders)').setMinValue(0.01).setMaxValue(100))
    .addStringOption(o => o.setName('mode').setDescription('Paper or live automation').addChoices(...executionChoices)),

  new SlashCommandBuilder().setName('dca').setDescription('Create a DCA buy or sell strategy')
    .addStringOption(o => o.setName('side').setDescription('Buy or sell').setRequired(true).addChoices(...sideChoices))
    .addStringOption(o => o.setName('mint').setDescription('Token mint').setRequired(true))
    .addIntegerOption(o => o.setName('interval').setDescription('Seconds between runs (min 10)').setMinValue(10).setMaxValue(604800).setRequired(true))
    .addIntegerOption(o => o.setName('runs').setDescription('Number of executions').setMinValue(1).setMaxValue(100).setRequired(true))
    .addNumberOption(o => o.setName('sol').setDescription('SOL per buy run').setMinValue(0.001))
    .addNumberOption(o => o.setName('percent').setDescription('% to sell each run').setMinValue(0.01).setMaxValue(100))
    .addStringOption(o => o.setName('mode').setDescription('Paper or live automation').addChoices(...executionChoices)),

  new SlashCommandBuilder().setName('autosell').setDescription('Attach TP, SL and/or trailing stop orders')
    .addStringOption(o => o.setName('mint').setDescription('Token mint').setRequired(true))
    .addNumberOption(o => o.setName('takeprofit').setDescription('Take-profit % (0/off)').setMinValue(0).setMaxValue(10000))
    .addNumberOption(o => o.setName('stoploss').setDescription('Stop-loss % (0/off)').setMinValue(0).setMaxValue(99.9))
    .addNumberOption(o => o.setName('trailing').setDescription('Trailing-stop % (0/off)').setMinValue(0).setMaxValue(99.9))
    .addNumberOption(o => o.setName('percent').setDescription('% of position to sell').setMinValue(0.01).setMaxValue(100))
    .addStringOption(o => o.setName('mode').setDescription('Paper or live automation').addChoices(...executionChoices)),
  new SlashCommandBuilder().setName('orders').setDescription('List open V4 strategy orders'),
  new SlashCommandBuilder().setName('cancelorder').setDescription('Cancel an open V4 order')
    .addIntegerOption(o => o.setName('id').setDescription('Order ID').setMinValue(1).setRequired(true)),

  new SlashCommandBuilder().setName('sniper').setDescription('Manage launch-profile autosniper setups')
    .addSubcommand(sc => sc.setName('add').setDescription('Create a launch-profile autosniper')
      .addStringOption(o => o.setName('label').setDescription('Setup label'))
      .addNumberOption(o => o.setName('sol').setDescription('SOL per snipe').setMinValue(0.001).setRequired(true))
      .addNumberOption(o => o.setName('minliq').setDescription('Minimum liquidity USD').setMinValue(0))
      .addNumberOption(o => o.setName('maxmcap').setDescription('Maximum market cap USD (0 off)').setMinValue(0))
      .addIntegerOption(o => o.setName('maxsnipes').setDescription('Stop after this many successful snipes').setMinValue(1).setMaxValue(100))
      .addStringOption(o => o.setName('mode').setDescription('Paper or live automation').addChoices(...executionChoices)))
    .addSubcommand(sc => sc.setName('list').setDescription('List autosniper setups'))
    .addSubcommand(sc => sc.setName('pause').setDescription('Pause a setup').addIntegerOption(o => o.setName('id').setDescription('Sniper ID').setRequired(true)))
    .addSubcommand(sc => sc.setName('resume').setDescription('Resume a setup').addIntegerOption(o => o.setName('id').setDescription('Sniper ID').setRequired(true)))
    .addSubcommand(sc => sc.setName('remove').setDescription('Remove a setup').addIntegerOption(o => o.setName('id').setDescription('Sniper ID').setRequired(true))),

  new SlashCommandBuilder().setName('token').setDescription('Show token market/security intelligence')
    .addStringOption(o => o.setName('mint').setDescription('Token mint').setRequired(true)),
  new SlashCommandBuilder().setName('discover').setDescription('Show Solana discovery radar from live DexScreener activity')
    .addIntegerOption(o => o.setName('limit').setDescription('Tokens to show').setMinValue(3).setMaxValue(15)),
  new SlashCommandBuilder().setName('wallet').setDescription('Analyze a Solana wallet copyability score')
    .addStringOption(o => o.setName('address').setDescription('Wallet address').setRequired(true)),
  new SlashCommandBuilder().setName('score').setDescription('Calculate Luna wallet copyability score')
    .addStringOption(o => o.setName('wallet').setDescription('Wallet address').setRequired(true)),
  new SlashCommandBuilder().setName('walletpnl').setDescription('Estimate recent wallet PnL/win rate from observed swaps')
    .addStringOption(o => o.setName('wallet').setDescription('Wallet address').setRequired(true))
    .addIntegerOption(o => o.setName('limit').setDescription('Recent transactions to sample').setMinValue(20).setMaxValue(100)),

  new SlashCommandBuilder().setName('watch').setDescription('Manage token watchlist')
    .addSubcommand(sc => sc.setName('add').setDescription('Add token to watchlist')
      .addStringOption(o => o.setName('mint').setDescription('Token mint').setRequired(true))
      .addStringOption(o => o.setName('label').setDescription('Optional label')))
    .addSubcommand(sc => sc.setName('remove').setDescription('Remove token from watchlist')
      .addStringOption(o => o.setName('mint').setDescription('Token mint').setRequired(true)))
    .addSubcommand(sc => sc.setName('list').setDescription('List watched tokens')),

  new SlashCommandBuilder().setName('copy').setDescription('Manage smart-money tracked/paper-copy wallets')
    .addSubcommand(sc => copyOptions(sc.setName('add').setDescription('Add a trader wallet'), false))
    .addSubcommand(sc => copyOptions(sc.setName('edit').setDescription('Edit a trader wallet'), true))
    .addSubcommand(sc => sc.setName('remove').setDescription('Remove a trader wallet').addStringOption(o => o.setName('wallet').setDescription('Wallet address').setRequired(true)))
    .addSubcommand(sc => sc.setName('pause').setDescription('Pause one trader wallet').addStringOption(o => o.setName('wallet').setDescription('Wallet address').setRequired(true)))
    .addSubcommand(sc => sc.setName('resume').setDescription('Resume one trader wallet').addStringOption(o => o.setName('wallet').setDescription('Wallet address').setRequired(true)))
    .addSubcommand(sc => sc.setName('list').setDescription('List tracked/paper-copy wallets')),

  new SlashCommandBuilder().setName('signal').setDescription('Configure smart-money consensus')
    .addIntegerOption(o => o.setName('minwallets').setDescription('Distinct wallets required').setMinValue(1).setMaxValue(10))
    .addNumberOption(o => o.setName('minweight').setDescription('Combined wallet weight required').setMinValue(0).setMaxValue(20))
    .addIntegerOption(o => o.setName('window').setDescription('Consensus window seconds').setMinValue(30).setMaxValue(3600))
    .addNumberOption(o => o.setName('minbuy').setDescription('Global minimum leader buy SOL').setMinValue(0))
    .addIntegerOption(o => o.setName('cooldown').setDescription('Duplicate signal cooldown seconds').setMinValue(0).setMaxValue(86400)),

  new SlashCommandBuilder().setName('paper').setDescription('Manage paper trading')
    .addSubcommand(sc => sc.setName('status').setDescription('Show paper portfolio status'))
    .addSubcommand(sc => sc.setName('on').setDescription('Enable paper copy execution'))
    .addSubcommand(sc => sc.setName('off').setDescription('Disable paper copy execution'))
    .addSubcommand(sc => sc.setName('reset').setDescription('Reset paper portfolio and history')
      .addNumberOption(o => o.setName('sol').setDescription('Starting paper SOL balance').setMinValue(0.1))),

  new SlashCommandBuilder().setName('blockmint').setDescription('Block a token mint from new buys')
    .addStringOption(o => o.setName('mint').setDescription('Token mint').setRequired(true)),
  new SlashCommandBuilder().setName('unblockmint').setDescription('Remove a mint from blocklist')
    .addStringOption(o => o.setName('mint').setDescription('Token mint').setRequired(true)),
  new SlashCommandBuilder().setName('blocklist').setDescription('List blocked token mints'),

  new SlashCommandBuilder().setName('leader').setDescription('Add trader wallet in paper mode (legacy shortcut)')
    .addStringOption(o => o.setName('wallet').setDescription('Wallet address').setRequired(true))
    .addStringOption(o => o.setName('label').setDescription('Name for trader')),
  new SlashCommandBuilder().setName('removeleader').setDescription('Stop watching trader wallet (legacy shortcut)')
    .addStringOption(o => o.setName('wallet').setDescription('Wallet address').setRequired(true)),
  new SlashCommandBuilder().setName('leaders').setDescription('List watched trader wallets'),
  new SlashCommandBuilder().setName('setchannel').setDescription('Send trade/order alerts to this channel'),
  new SlashCommandBuilder().setName('copysize').setDescription('Set default paper SOL size copied on each buy')
    .addNumberOption(o => o.setName('sol').setDescription('Paper SOL per copied buy').setMinValue(0.001).setRequired(true)),
  new SlashCommandBuilder().setName('risk').setDescription('Set trading/copy risk filters')
    .addNumberOption(o => o.setName('maxtrade').setDescription('Maximum copied SOL per buy').setMinValue(0.001))
    .addNumberOption(o => o.setName('maxmanual').setDescription('Maximum manual/strategy SOL per buy').setMinValue(0.001))
    .addNumberOption(o => o.setName('maxdaily').setDescription('Maximum paper SOL bought per UTC day (0 off)').setMinValue(0))
    .addNumberOption(o => o.setName('minliquidity').setDescription('Minimum token liquidity USD').setMinValue(0))
    .addNumberOption(o => o.setName('maxmarketcap').setDescription('Maximum market cap USD (0 off)').setMinValue(0))
    .addNumberOption(o => o.setName('minorganic').setDescription('Minimum Jupiter organic score (0 off)').setMinValue(0).setMaxValue(100))
    .addIntegerOption(o => o.setName('maxdelay').setDescription('Maximum copied entry delay seconds (0 off)').setMinValue(0).setMaxValue(3600))
    .addBooleanOption(o => o.setName('skipexisting').setDescription('Skip existing paper positions'))
    .addBooleanOption(o => o.setName('skippedalerts').setDescription('Post alerts for filtered buys')),

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
  new SlashCommandBuilder().setName('pause').setDescription('Pause monitoring and strategies'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume monitoring and strategies'),
  new SlashCommandBuilder().setName('status').setDescription('Show bot status and settings'),
  new SlashCommandBuilder().setName('help').setDescription('Show Luna V4 command help'),
].map(c => c.toJSON());

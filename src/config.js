import 'dotenv/config';

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'ADMIN_USER_ID', 'HELIUS_API_KEY', 'JUPITER_API_KEY'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

function numberEnv(name, fallback, min = 0) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

export const config = {
  discordToken: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID || null,
  adminUserId: process.env.ADMIN_USER_ID,
  heliusApiKey: process.env.HELIUS_API_KEY,
  jupiterApiKey: process.env.JUPITER_API_KEY,

  // Live execution stays opt-in. V3 is paper-first by design.
  liveTradingEnabled: String(process.env.ENABLE_LIVE_TRADING).toLowerCase() === 'true',
  privateKey: process.env.BS58_PRIVATE_KEY || '',

  // V3 monitoring: the scheduler ticks often, but each wallet has its own
  // adaptive next-poll time. This prevents N wallets from causing N requests
  // every few seconds.
  walletSchedulerMs: numberEnv('WALLET_SCHEDULER_MS', 2000, 1000),
  walletHotPollMs: numberEnv('WALLET_HOT_POLL_MS', 15000, 5000),
  walletIdlePollMs: numberEnv('WALLET_IDLE_POLL_MS', 60000, 10000),
  pricePollMs: numberEnv('PRICE_POLL_MS', 30000, 10000),
  recentTxLimit: Math.floor(numberEnv('HELIUS_TX_LIMIT', 20, 5)),

  // Central Helius rate limiter / 429 protection.
  heliusMinIntervalMs: numberEnv('HELIUS_MIN_INTERVAL_MS', 250, 100),
  heliusCacheMs: numberEnv('HELIUS_CACHE_MS', 2000, 0),
  heliusMaxRetries: Math.floor(numberEnv('HELIUS_MAX_RETRIES', 2, 0)),
  heliusBackoffBaseMs: numberEnv('HELIUS_BACKOFF_BASE_MS', 30000, 1000),
  heliusBackoffMaxMs: numberEnv('HELIUS_BACKOFF_MAX_MS', 900000, 10000),
};

export const WSOL = 'So11111111111111111111111111111111111111112';
export const LAMPORTS_PER_SOL = 1_000_000_000;

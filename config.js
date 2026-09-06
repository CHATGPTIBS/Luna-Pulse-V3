import 'dotenv/config';

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'ADMIN_USER_ID', 'HELIUS_API_KEY', 'JUPITER_API_KEY'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

export const config = {
  discordToken: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID || null,
  adminUserId: process.env.ADMIN_USER_ID,
  heliusApiKey: process.env.HELIUS_API_KEY,
  jupiterApiKey: process.env.JUPITER_API_KEY,
  liveTradingEnabled: String(process.env.ENABLE_LIVE_TRADING).toLowerCase() === 'true',
  privateKey: process.env.BS58_PRIVATE_KEY || '',
  walletPollMs: Math.max(3000, Number(process.env.WALLET_POLL_MS || 5000)),
  pricePollMs: Math.max(10000, Number(process.env.PRICE_POLL_MS || 15000)),
};

export const WSOL = 'So11111111111111111111111111111111111111112';
export const LAMPORTS_PER_SOL = 1_000_000_000;

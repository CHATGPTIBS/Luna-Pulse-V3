# Solana Copy Trader Discord Bot — V1

A Discord bot that watches selected Solana trader wallets, posts BUY/SELL alerts, creates one-shot USD price alerts, and can optionally mirror SOL↔token swaps from a dedicated execution wallet.

## What V1 does

- Watch one or more leader/trader wallets with `/leader`.
- Detect new Helius-parsed `SWAP` transactions.
- Detect SOL → token as a **BUY** and token → SOL as a **SELL**.
- Post Discord alerts with token mint, leader amount, price/liquidity where available, and transaction link.
- Set one-shot USD price alerts.
- Optional automatic copy buys using a fixed SOL amount.
- Optional proportional copy sells: if the leader sells ~40% of their position, the bot tries to sell ~40% of its copied position.
- Buy safety gates: max trade, max daily buy spend, minimum Jupiter liquidity, optional minimum organic score, and estimated price-impact limit.
- Separate environment-level `ENABLE_LIVE_TRADING` kill switch plus Discord `/autocopy` switch.

## Important V1 limitation

V1 deliberately copies only **SOL↔SPL-token swaps**. Token↔token swaps are still visible to Helius but are ignored by the copy engine. This is intentional for a safer first memecoin-focused version.

## APIs used

- **Helius Enhanced Transactions** for parsed wallet transaction monitoring.
- **Jupiter Tokens V2** for token metadata / organic score.
- **Jupiter Price V3** for price and liquidity.
- **Jupiter Swap V2 `/order` + `/execute`** for live execution.
- **Discord API / discord.js v14** for slash commands and alerts.

## 1. Create the Discord bot

1. Open Discord Developer Portal and create an application. 1546063517319176213
2. Add a Bot.
3. Copy the **bot token** into `DISCORD_TOKEN`.
4. From General Information copy **Application ID** into `DISCORD_CLIENT_ID`.
5. Enable Discord Developer Mode, right-click your test server, and copy its server ID into `DISCORD_GUILD_ID`.
6. Right-click your own Discord user and copy your User ID into `ADMIN_USER_ID`.
7. Invite the bot with the `bot` and `applications.commands` scopes. It needs permission to View Channels, Send Messages, and Embed Links in the alert channel.

## 2. Get API keys

Create a Helius API key and a Jupiter Developer API key. Add them to `.env`.

## 3. Local setup

```bash
cp .env.example .env
npm install
npm run deploy-commands
npm start
```

For fast development, keep `DISCORD_GUILD_ID` set; guild slash commands update quickly.

## 4. Configure the bot in Discord

Recommended order:

```text
/setchannel
/leader wallet:<TRADER_WALLET> label:Trader1
/status
/pricealert mint:<TOKEN_MINT> direction:above price:0.001
```

At this point alerts work and **no trades are executed**.

## 5. Enable live copy trading only after testing

Use a **new dedicated Solana wallet with a small balance**. Never use your main wallet and never paste a seed phrase into Discord.

Put the dedicated wallet's base58 private key in the host's secret environment variable `BS58_PRIVATE_KEY`, then set:

```text
ENABLE_LIVE_TRADING=true
```

Restart the service. Verify `/wallet` shows the expected **public address**. Then set conservative limits, for example:

```text
/risk maxtrade:0.03 maxdaily:0.10 minliquidity:50000 maximpact:5 minorganic:0
/copysize sol:0.02
/autocopy enabled:true
```

Two independent switches must therefore be on before a trade can execute: the host environment switch and `/autocopy`.

## Commands

- `/leader wallet label`
- `/removeleader wallet`
- `/leaders`
- `/setchannel`
- `/tradealerts buys sells`
- `/pricealert mint direction price`
- `/pricealerts`
- `/delpricealert id`
- `/copysize sol`
- `/risk maxtrade maxdaily minliquidity maximpact minorganic`
- `/autocopy enabled`
- `/pause`
- `/resume`
- `/status`
- `/wallet`
- `/help`

## Render deployment

This repo includes `render.yaml` for a Background Worker. Add all environment variables in Render rather than committing `.env`.

**Persistence:** V1 stores configuration in `data/state.json`. Render's default filesystem is ephemeral. For a permanent deployment, attach a persistent disk or move state to Postgres/Redis before relying on it long-term.

## Security notes

- Never commit `.env`.
- Never use your main wallet for bot execution.
- Start with `ENABLE_LIVE_TRADING=false`.
- Memecoins can gap through expected prices and liquidity can disappear quickly.
- Copy trading inherits the leader's mistakes and adds latency/slippage; it cannot guarantee matching fills or profitability.
- A leader wallet can behave maliciously. Risk filters reduce risk; they do not eliminate it.

## Next upgrades

- Helius Parsed Streams/LaserStream instead of polling for lower latency.
- Rug/security checks before every new mint buy.
- Per-leader copy sizes and allow/deny lists.
- Position/PnL dashboard and paper-trading mode.
- Trailing stops / take-profit automation.
- PostgreSQL persistence.

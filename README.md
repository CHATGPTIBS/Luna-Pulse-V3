# Luna Meme Bot V2 — Solana Discord Wallet Intelligence + Paper Copying

V2 upgrades the original bot with wallet scoring, a dashboard, paper portfolio accounting, PnL/history, stronger entry filters, per-wallet tracking modes, and improved alerts.

## Important

This installed V2 runs in **TRACK** and **PAPER** modes. It does not automatically submit real-money swaps. Any wallet left over from V1 with a legacy `live` mode is treated as **alerts-only** by the V2 monitor.

## Main commands

- `/dashboard` — paper equity, PnL, win rate, open positions and active wallets.
- `/wallet address:<wallet>` — analyze a Solana wallet.
- `/score wallet:<wallet>` — calculate the Luna V2 copyability/activity score.
- `/copy add|remove|pause|resume|list` — manage tracked/paper-copy wallets.
- `/positions` — show current paper positions and unrealized PnL.
- `/history` — show recent paper-copy history.
- `/paper status|on|off|reset` — control/reset the simulated portfolio.
- `/risk` — set liquidity, market-cap, entry-delay and paper position filters.
- `/blockmint`, `/unblockmint`, `/blocklist` — maintain the mint deny-list.
- `/pricealert`, `/pricealerts`, `/delpricealert` — one-shot price alerts.

## Wallet modes

- **TRACK** — Discord alerts only.
- **PAPER** — simulate the leader's buys/sells using the configured paper SOL size.

New wallets default to PAPER mode.

## Luna Score V2

The score uses recent parsed SOL↔token swaps and measures activity/copyability signals such as:

- number of parsed swaps
- recency of activity
- buy/sell follow-through
- token diversity
- median trade size
- percentage of swaps that can be cleanly interpreted by the copy engine

It is a heuristic, not a verified profitability or win-rate guarantee.

## Render deployment

The existing Render Background Worker can be reused. `render.yaml` still uses Node 20 and `npm start`.

Environment variables used by this V2 path:

```text
DISCORD_TOKEN
DISCORD_CLIENT_ID
DISCORD_GUILD_ID
ADMIN_USER_ID
HELIUS_API_KEY
JUPITER_API_KEY
WALLET_POLL_MS
PRICE_POLL_MS
```

After deploying, register the updated Discord commands once with:

```bash
npm run deploy-commands
```

Then in Discord:

1. Run `/setchannel` in the alerts channel.
2. Run `/dashboard`.
3. Add a wallet with `/copy add` and choose **Paper copy**.
4. Use `/score` to inspect wallets before following them.

## Persistence

State is stored in `data/state.json`. Render's default filesystem can be ephemeral, so use a persistent disk or a database before relying on long-term PnL/history.

## Security

- Never commit `.env`, seed phrases or private keys.
- The bot's V2 paper results do not include every real-world execution effect such as failed transactions, latency and changing liquidity.
- Treat wallet scores and paper results as decision-support signals, not guarantees.

## Rollback

A pre-V2 backup branch exists at `backup-v1-2026-09-07`.

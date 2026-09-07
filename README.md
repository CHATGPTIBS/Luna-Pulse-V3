# Luna Meme Bot V3 — Solana Discord Smart-Money Signal Engine

Luna V3 turns the V2 wallet watcher into an adaptive, paper-first Solana trading intelligence bot. It tracks selected wallets, scores copyability, combines multiple wallet buys into weighted smart-money signals, applies token/risk filters, paper-copies qualified signals, follows the source trader's sells, and exposes health/usage data directly in Discord.

## What V3 changes

### Helius usage protection

V2 polled every wallet every few seconds. V3 uses one adaptive scheduler:

- active wallets use the **hot** interval
- idle wallets use the **idle** interval
- only one due wallet is polled per scheduler tick
- all Helius calls pass through a central request queue
- short-lived responses are cached
- HTTP 429 responses honor cooldown/backoff
- `max usage reached` is treated as quota exhaustion and does **not** create a retry storm
- `/health` shows requests, cache hits, 429s, failures and cooldown state

The defaults are intentionally conservative enough to make multi-wallet tracking far less wasteful than V2.

### Weighted smart-money signals

Each wallet has a tier and a signal weight:

- **Tier A** — default weight `1.50`
- **Tier B** — default weight `1.00`
- **Tier C** — default weight `0.75`

A BUY can qualify when both configured conditions are met inside the signal window:

1. minimum number of distinct wallets
2. minimum combined wallet weight

The bot also supports a minimum leader buy size and a duplicate-signal cooldown.

Example stricter consensus setup:

```text
/signal minwallets:2 minweight:2 window:120 minbuy:0.05 cooldown:300
```

That requires at least two tracked wallets with at least 2.0 combined weight to buy the same token within two minutes.

## Safety model

V3 remains **paper-first**. TRACK and PAPER modes are supported by the monitor:

- **TRACK** — contributes to signals and produces alerts, but is not selected as a paper execution source.
- **PAPER** — contributes to signals and can be selected as the source wallet for a simulated buy.

The highest-weight participating PAPER wallet becomes the source for a qualified paper buy. V3 then follows sells from that source wallet for the corresponding paper position.

Existing legacy live-mode wallets are not used for automatic V3 execution.

## Main commands

- `/dashboard` — equity, PnL, win rate, positions, wallet count, daily exposure, signal count and Helius status.
- `/health` — API/monitor health, Helius request count, 429 count and cooldown state.
- `/signals` — recent qualified smart-money signals.
- `/wallet address:<wallet>` — inspect wallet activity/copyability.
- `/score wallet:<wallet>` — calculate the Luna wallet score.
- `/copy add` — add a trader with mode, tier, weight and optional paper size.
- `/copy edit` — change an existing trader's label, mode, tier, weight or paper size.
- `/copy remove|pause|resume|list` — manage tracked traders.
- `/signal` — configure consensus wallets, combined weight, time window, minimum leader buy and cooldown.
- `/risk` — configure max trade, daily buy cap, liquidity, market cap, organic score, max delay and duplicate-position handling.
- `/positions` — current paper positions and unrealized PnL.
- `/history` — recent paper trades.
- `/paper status|on|off|reset` — control/reset the simulated portfolio.
- `/blockmint`, `/unblockmint`, `/blocklist` — token deny-list.
- `/pricealert`, `/pricealerts`, `/delpricealert` — one-shot token price alerts.
- `/pause`, `/resume`, `/status`, `/help` — operations controls.

## V3 risk gates

Before a qualified signal can create a paper buy, Luna can reject it for:

- blocked mint
- leader buy below the configured minimum
- stale transaction / excessive entry delay
- an existing open paper position
- daily paper SOL cap
- insufficient Jupiter liquidity
- insufficient organic score
- market cap above the configured maximum
- unavailable token/liquidity data

Every qualified signal is stored in `signalHistory`, while simulated trades continue to use `tradeHistory`.

## Environment variables

Required:

```text
DISCORD_TOKEN
DISCORD_CLIENT_ID
ADMIN_USER_ID
HELIUS_API_KEY
JUPITER_API_KEY
```

Optional Discord setting:

```text
DISCORD_GUILD_ID
```

Adaptive monitoring defaults:

```text
WALLET_SCHEDULER_MS=2000
WALLET_HOT_POLL_MS=15000
WALLET_IDLE_POLL_MS=60000
PRICE_POLL_MS=30000
HELIUS_TX_LIMIT=20
```

Helius protection defaults:

```text
HELIUS_MIN_INTERVAL_MS=250
HELIUS_CACHE_MS=2000
HELIUS_MAX_RETRIES=2
HELIUS_BACKOFF_BASE_MS=30000
HELIUS_BACKOFF_MAX_MS=900000
```

## Render deployment

The existing Render Background Worker can be reused. `render.yaml` still runs Node 20 with `npm start`.

After deploying V3, register the new Discord command definitions once:

```bash
npm run deploy-commands
```

Then in Discord:

1. `/setchannel`
2. `/health`
3. `/dashboard`
4. `/copy add` for your selected wallets
5. `/signal` to choose one-wallet or consensus mode
6. `/risk` to choose your paper exposure limits

V3 defaults to `signalMinWallets=1`, so existing V2-style one-wallet paper copying continues to work. For a stronger smart-money filter, change it to two or more wallets.

## Persistence

State is stored in `data/state.json`. V2 state is automatically normalized into the V3 schema when loaded. The V3 schema adds wallet tiers/weights, adaptive polling fields and signal history.

Render filesystems can be ephemeral. If you want long-term PnL/history to survive redeploys/restarts, attach a persistent disk or move state to a database.

## Security

- Never commit `.env`, seed phrases, API secrets or private keys.
- Keep live execution disabled while evaluating wallet selection and V3 signal settings.
- Paper results do not reproduce every real execution effect such as latency, price movement, failed transactions and slippage.
- Luna scores and wallet consensus are decision-support heuristics, not guarantees of profitability.

## Rollback

The repository still contains the pre-V2 backup branch `backup-v1-2026-09-07`. V3 itself is developed on `luna-v3` until merged.

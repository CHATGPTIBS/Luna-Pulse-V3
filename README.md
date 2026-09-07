# Luna Meme Bot V4 — Solana Discord Trading + Smart-Money Toolkit

Luna V4 builds on the V3 adaptive wallet signal engine with a Discord-native feature set inspired by the useful parts of Trojan and GMGN: instant swaps, advanced orders, DCA, TP/SL/trailing exits, token discovery/security intelligence, wallet PnL estimates, richer copy-trade controls, watchlists and a launch-profile autosniper.

## V4 feature map

### Trading
- `/buy` — immediate PAPER buy or explicitly enabled LIVE Jupiter swap.
- `/sell` — immediate percentage sell.
- `/limit` — price- or market-cap-triggered buy/sell orders.
- `/dca` — repeated buy/sell executions by interval and run count.
- `/autosell` — OCO-style take-profit / stop-loss / trailing-stop group.
- `/orders` and `/cancelorder` — inspect/cancel open strategies.

### Discovery / token intelligence
- `/token` — Jupiter + DexScreener market data and RugCheck risk signals.
- `/discover` — live Solana radar from DexScreener boost/activity data.
- `/watch add|remove|list` — token watchlist.
- `/sniper` — launch-profile scanner that reacts to newly seen Solana token profiles and applies liquidity / market-cap / blocklist / rugged filters.

**Sniper scope:** V4's sniper is a launch-profile autosniper. It is not advertised as a first-block/Jito sniper; that class of execution needs specialized low-latency broadcast infrastructure.

### Smart money / copy trading
V3 weighted consensus remains intact and gains per-wallet controls through `/copy add` and `/copy edit`:
- TRACK or PAPER mode
- A/B/C tier and custom signal weight
- fixed copied SOL size or percentage of leader buy size
- mirror sells on/off
- duplicate buys on/off
- wallet-specific minimum leader buy
- wallet-specific minimum liquidity / min market cap / max market cap
- automatic copied-position take-profit / stop-loss / trailing stop

Use `/wallet` for copyability and `/walletpnl` for an observed-window realized-PnL/win-rate estimate. The PnL command is explicitly an estimate from recent parseable swaps, not a complete tax-lot or all-time ledger.

## Live-trading safety model

V4 defaults to PAPER.

Manual live swaps require both a key and this explicit switch:

```text
ENABLE_LIVE_TRADING=true
BS58_PRIVATE_KEY=...
```

Unattended LIVE limit orders, DCA, TP/SL/trailing orders, and the launch-profile sniper require a **second** switch:

```text
ENABLE_LIVE_AUTOMATION=true
```

If only `ENABLE_LIVE_TRADING=true` is set, manual live `/buy` and `/sell` can execute but automated LIVE strategies remain blocked.

Never commit private keys or `.env` files.

## Main commands

```text
/dashboard /health /status
/buy /sell /limit /dca /autosell /orders /cancelorder
/sniper add|list|pause|resume|remove
/token /discover /watch add|remove|list
/wallet /walletpnl /score
/copy add|edit|remove|pause|resume|list
/signals /signal
/positions /history /paper
/risk /blockmint /unblockmint /blocklist
/pricealert /pricealerts /delpricealert
/setchannel /pause /resume /help
```

## Environment

Required:

```text
DISCORD_TOKEN
DISCORD_CLIENT_ID
ADMIN_USER_ID
HELIUS_API_KEY
JUPITER_API_KEY
```

Optional:

```text
DISCORD_GUILD_ID
SOLANA_SIGNATURE_RPC_URL=https://api.mainnet-beta.solana.com

WALLET_SCHEDULER_MS=2000
WALLET_HOT_POLL_MS=15000
WALLET_HOT_HOLD_MS=300000
WALLET_IDLE_POLL_MS=60000
PRICE_POLL_MS=30000
HELIUS_TX_LIMIT=20

STRATEGY_POLL_MS=3000
LAUNCH_POLL_MS=10000

HELIUS_MIN_INTERVAL_MS=250
HELIUS_CACHE_MS=2000
HELIUS_MAX_RETRIES=2
HELIUS_BACKOFF_BASE_MS=30000
HELIUS_BACKOFF_MAX_MS=900000

ENABLE_LIVE_TRADING=false
ENABLE_LIVE_AUTOMATION=false
BS58_PRIVATE_KEY=
```

## Deploy / update Discord commands

The existing Render worker can continue to use Node 20 and `npm start`.

After deploying V4, register the changed slash commands once:

```bash
npm install
npm run check
npm run deploy-commands
```

Then in Discord run:

1. `/setchannel`
2. `/health`
3. `/dashboard`
4. Test `/buy ... mode:Paper`
5. Test `/limit`, `/dca` and `/autosell` in PAPER mode
6. Add smart wallets with `/copy add`
7. Configure `/signal` and `/risk`
8. Only enable live environment switches after paper testing

## Persistence

State remains in `data/state.json`. V3 state migrates automatically to schema V4 and retains leaders, paper portfolio, signal history, trade history and blocklist. V4 adds orders, snipers and watchlist state.

Use a persistent Render disk or database if state must survive every redeploy/restart.

## Data caveats

- DexScreener discovery/boost data measures current activity; it is not a recommendation or proof of organic demand.
- RugCheck/Jupiter/token metadata are risk signals and can be incomplete or unavailable.
- Wallet PnL is estimated from the sampled parseable transactions and can miss earlier cost basis, transfers or unparsed routes.
- Paper results do not reproduce real slippage, failed transactions, MEV, latency or rapidly changing liquidity.

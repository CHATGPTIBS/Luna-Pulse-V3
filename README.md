# Luna Meme Bot V5 — Alpha Engine

Luna V5 keeps the V4 Trojan/GMGN-style Discord toolkit and upgrades the parts that matter most for copy-trading quality: realtime wallet wakeups, entry-chase protection, a 100-point Alpha score, position-aware exits, smarter token discovery, stronger token-risk data, tracked-wallet ranking, quote freshness protection, and optional durable Postgres state.

## What changed in V5

### Realtime smart-money detection
- Standard Solana/Helius WebSocket `logsSubscribe` subscriptions wake tracked wallets as soon as activity appears.
- Adaptive Helius transaction polling remains the authoritative parser and fallback if the stream disconnects or misses an event.
- `/stream` shows connection, subscription, notification and persistence status.

### Luna Alpha score
Every qualified copied buy can be scored from 0–100 across:
- **Smart money — 30:** wallet count and combined signal weight.
- **Token safety — 25:** RugCheck risks, holder concentration when available, creator holdings, authorities and liquidity.
- **Live flow — 20:** buy/sell flow, turnover and momentum quality.
- **Entry quality — 15:** how far current price has moved from the source wallet's implied entry.
- **Execution quality — 10:** liquidity and proposed trade-size/liquidity ratio.

Default paper-copy protection:
- maximum chase: **12%** above source entry
- minimum Alpha: **60/100**

Use `/v5risk` to adjust those values. `/alpha <mint>` gives a standalone token Alpha report.

### Position-aware exit ladders
V4 cancelled all sibling TP/SL/trailing orders when any one sibling filled. V5 only cancels the remaining protective siblings when the position is actually closed. A partial take-profit therefore leaves the unsold position protected.

Use `/ladder` for two take-profit levels plus a 100% stop-loss and/or trailing stop. TP percentages are percentages of the **remaining** position at the time each level executes.

### Smarter discovery and token intelligence
- `/discover` now ranks candidates by liquidity, turnover, buyer/seller flow, momentum quality and age instead of treating paid boost activity as alpha.
- `/alpha` and `/token` use expanded RugCheck/Jupiter/DexScreener data.
- High-severity launch risks are filtered from the V5 launch-profile sniper.

### Smart Wallet Radar
`/radar` ranks the wallets you already track using observed PnL, win rate, copyability, recency, trade behavior and hold time. Very short-hold sniper-like wallets are penalized because they are often poor copy targets even if their headline PnL looks strong.

### Jupiter execution protection
V5 keeps Jupiter Swap V2 `/order` + `/execute`, so the default live path retains Jupiter-managed RTSE slippage, priority-fee strategy and transaction landing. V5 adds:
- stale-quote detection and automatic requote
- configurable maximum quote age
- optional fixed `slippageBps`; `0` keeps Jupiter RTSE

### Durable state
V5 still supports `data/state.json` with atomic local writes. If `DATABASE_URL` is configured, it automatically creates/uses a `luna_state` Postgres table and mirrors the complete state there. On a fresh container it can hydrate from Postgres before the live loops proceed.

## V5 commands

```text
/alpha <mint>             Token Alpha score
/radar                     Rank tracked wallets
/v5risk                    Chase / Alpha / quote-age / slippage controls
/ladder                    Position-aware TP/SL/trailing ladder
/stream                    Realtime + persistence status
```

All V4 commands remain available:

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

Recommended V5 settings:

```text
REALTIME_WALLET_STREAM=true
SOLANA_WS_URL=
WALLET_SCHEDULER_MS=1000
WALLET_HOT_POLL_MS=15000
WALLET_IDLE_POLL_MS=60000
STRATEGY_POLL_MS=2000

# Optional durable state
DATABASE_URL=
DATABASE_SSL=false
```

Live money remains separately opt-in:

```text
ENABLE_LIVE_TRADING=false
ENABLE_LIVE_AUTOMATION=false
BS58_PRIVATE_KEY=
```

`ENABLE_LIVE_TRADING=true` unlocks manual live swaps. Unattended LIVE limit/DCA/TP-SL/sniper execution additionally requires `ENABLE_LIVE_AUTOMATION=true`.

## Deploy

```bash
npm install
npm run check
npm start
```

`npm start` registers the complete V4+V5 Discord command set before starting the bot.

## Recommended rollout

1. Keep `ENABLE_LIVE_TRADING=false` and `ENABLE_LIVE_AUTOMATION=false`.
2. Run `/stream` and confirm the realtime accelerator is connected.
3. Run `/radar` on tracked wallets and remove obvious sniper-like/weak sources.
4. Paper-copy with the default 12% chase and 60 Alpha gates.
5. Use `/ladder` to test partial-profit behavior.
6. Review `/history`, `/signals` and paper PnL before loosening/tightening `/v5risk`.
7. Add Postgres before relying on unattended strategies across Render redeploys.
8. Only then consider enabling live switches.

## Caveats

- Alpha is a heuristic, not a guarantee of profit.
- Wallet PnL is estimated from a recent parseable window and can miss transfers, earlier cost basis and unsupported routes.
- RugCheck/Jupiter/DexScreener data can be incomplete or temporarily unavailable.
- The launch-profile sniper is not a first-block/Jito sniper.
- Paper results do not reproduce live slippage, failed transactions, MEV, latency or rapidly changing liquidity.

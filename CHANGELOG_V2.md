# V2 upgrade summary

## Added
- `/dashboard` paper portfolio/status dashboard.
- `/positions` paper positions with unrealized PnL.
- `/history` paper-copy history.
- `/wallet address:` and `/score` wallet copyability analysis.
- `/copy add|remove|pause|resume|list` with per-wallet Track/Paper modes.
- Per-wallet paper copy size overrides.
- Paper portfolio with starting SOL, cash, equity, realized/unrealized PnL and reset support.
- Mint blocklist.
- Max market-cap, max-entry-delay and existing-position filters.
- Persistent V2 history/state migration for V1 state files.

## Changed
- Newly added wallets default to PAPER mode.
- Legacy `/leader` adds a paper-mode wallet.
- Existing legacy `live` wallets are treated as alerts-only by the V2 monitor.
- Alerts show configured wallet mode and rejection/paper-copy outcome.

## Preserved
- Helius wallet monitoring.
- Jupiter token metadata and price APIs.
- Price alerts.
- Proportional leader sell tracking for paper positions.
- Max trade, liquidity and organic-score filters.

## Not yet implemented
- Historical wallet profitability/win-rate reconstruction.
- Streaming/websocket wallet feed.
- Automated stop-loss/take-profit exits.
- PostgreSQL persistence.
- Multi-user accounts/permissions.

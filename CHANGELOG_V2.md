# V2 upgrade summary

## Added
- `/dashboard` portfolio/status dashboard.
- `/positions` paper positions with unrealized PnL.
- `/history` paper/live execution history.
- `/wallet address:` and `/score` wallet copyability analysis.
- `/copy add|remove|pause|resume|list` with per-wallet Track/Paper/Live modes.
- Per-wallet copy buy size overrides.
- Paper portfolio with starting SOL, cash, equity, realized/unrealized PnL and reset support.
- Mint blocklist.
- Max market-cap, max-entry-delay and existing-position filters.
- Live wallet SOL balance on dashboard.
- Persistent V2 history/state migrations for V1 state files.

## Changed
- Newly added wallets default to PAPER mode.
- Legacy `/leader` adds a paper-mode wallet.
- `/autocopy` is explicitly the global LIVE execution switch.
- Alerts show configured wallet mode and rejection/copy outcome.

## Preserved
- Helius wallet monitoring.
- Jupiter token/price APIs and swap execution.
- Price alerts.
- Proportional leader sells.
- Max trade, daily live spend, liquidity, organic-score and price-impact protections.
- Environment-level live trading kill switch.

## Not yet implemented
- Historical wallet PnL/win-rate reconstruction.
- Streaming/websocket wallet feed.
- Automated stop-loss/take-profit exits.
- PostgreSQL persistence.
- Multi-user accounts/permissions.

# Luna Meme Bot V4 Changelog

## Trading engine
- Added manual PAPER/LIVE `/buy` and `/sell`.
- Added price and market-cap limit buys/sells.
- Added DCA buy/sell schedules.
- Added take-profit, stop-loss and trailing-stop strategy orders.
- Added order listing/cancellation and persistent order state.
- Added a second environment opt-in for unattended LIVE strategy execution.

## Discovery / safety intelligence
- Added DexScreener-backed `/discover` radar.
- Added `/token` market intelligence with liquidity, market cap, volume, transaction flow, pair age, Jupiter organic score and RugCheck risk signals.
- Added token watchlist.
- Added launch-profile autosniper with liquidity, market-cap, blocklist and rugged filters.

## Wallet intelligence / copy trading
- Added `/walletpnl` observed-window PnL and win-rate estimate.
- Added proportional copy sizing.
- Added per-wallet copy-sell and duplicate-buy controls.
- Added per-wallet min-buy, liquidity and market-cap filters.
- Added automatic TP/SL/trailing exits for copied paper positions.
- Preserved V3 weighted multi-wallet consensus, adaptive Helius monitoring and quota protection.

## State / deployment
- Schema version 4 with automatic V3 migration.
- Added persistent orders, snipers and watchlist.
- Version bumped to 0.4.0.
- Added V4 strategy cadence and live-automation environment settings.

# Luna Meme Bot V3 Changelog

## Monitoring / API reliability

- Replaced all-wallet fixed-interval polling with an adaptive per-wallet scheduler.
- Added separate hot and idle polling intervals.
- Added a central Helius request queue and minimum request spacing.
- Added short-lived Helius response caching.
- Added HTTP 429 handling with retry/backoff and cooldown state.
- Added special handling for `max usage reached` so quota exhaustion does not cause retry storms.
- Added Helius request, cache-hit, 429, failure and cooldown telemetry.

## Smart-money signal engine

- Added wallet tiers A/B/C.
- Added configurable wallet signal weights.
- Added multi-wallet BUY consensus.
- Added minimum combined signal weight.
- Added configurable consensus time window.
- Added minimum leader buy size.
- Added per-token duplicate signal cooldown.
- Added persistent signal history.
- Qualified paper buys select the highest-weight participating PAPER wallet as the source trader.

## Risk management

- Enforced the existing maximum daily paper-buy SOL setting.
- Preserved max trade, liquidity, market-cap, organic-score, entry-delay, blocklist and duplicate-position gates.
- Added optional skipped-trade alerts.

## Discord UX

- Added `/health`.
- Added `/signals`.
- Added `/signal` configuration command.
- Added `/copy edit`.
- Added tier/weight controls to `/copy add`.
- Added `maxdaily` and `skippedalerts` to `/risk`.
- Upgraded `/dashboard`, `/status`, `/help`, wallet lists and alert embeds for V3.

## State / compatibility

- Added schema version 3.
- Existing V2 leaders are normalized automatically to Tier B / weight 1.0 unless they already have V3 values.
- Existing V2 paper portfolio, trade history, blocklist and alerts are retained.

## Deployment

- Version bumped to `0.3.0`.
- Existing Render Node 20 worker remains compatible.
- Updated `.env.example` with V3 adaptive polling and Helius protection settings.

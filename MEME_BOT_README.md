# Luna Meme Bot V1

This package is Luna Pulse V3.3 plus a standalone Solana meme-coin **paper trading**
engine. It runs in the same FastAPI/Render process as the existing crypto and
Forex paper engines.

## Data source

The bot uses DexScreener public endpoints:
- token boosts / profiles for candidate discovery
- token batch lookup for live pair metrics

No new API key is required for the meme bot.

Paid boosts are treated only as a discovery hint. They are deliberately given
very little scoring weight because a paid boost is not evidence that a token is
safe or likely to rise.

## Default paper rules

- Solana only
- Scan every 60 seconds
- Minimum liquidity: $150,000
- Minimum 1h volume: $50,000
- Minimum 5m volume: $5,000
- Minimum pair age: 20 minutes
- Auto entry: Luna score >= 7.8
- Risk: 0.20% of account cash per trade
- Max meme positions: 4
- Max meme portfolio risk: 1%
- Reward:risk target: 2:1
- 60 minute cooldown after a stop
- Simulated slippage: 0.35% each side
- Simulated DEX/route cost: 0.50% each side
- Stop adapts between roughly 6% and 15% to recent momentum
- Break-even/trailing protection after a trade moves in favor
- Momentum-fade exit when both price and buy pressure collapse

All values can be tuned through Render environment variables.

## New API endpoints

Authenticated endpoints:
- GET  /api/meme/status
- GET  /api/meme/trending
- POST /api/meme/scan
- POST /api/meme/auto
- POST /api/meme/paper/open
- POST /api/meme/positions/{id}/close
- GET  /api/meme/trades

Example auto toggle:
POST /api/meme/auto
{"enabled": true}

## Important

This is not a rug-pull detector and cannot prove a token is safe. DexScreener
provides market metrics, not complete smart-contract / holder / authority risk
analysis. Before any future live-wallet version, add dedicated token-security
checks and keep wallet signing isolated behind hard limits.

There is no wallet key, transaction signer, swap endpoint, or real-money order
code in this package.

## Control panel

The existing Meme Coins sidebar page is now a Luna Meme Bot control page with Scan, Auto Paper toggle, ranked Solana candidates, manual paper entry, open positions and meme trade history.

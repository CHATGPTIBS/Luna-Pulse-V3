# Luna Pulse V3

V3 moves Luna Pulse from a phone-only webpage to a server-based 24/7 paper-trading architecture.

## What is in V3

- 24/7 FastAPI server brain
- Dynamic Binance USDT spot universe
- Dynamic Binance USDT perpetual-futures universe
- Liquidity filtering
- 5-minute momentum analysis
- Long and short scoring on perps
- Volume, breakout/breakdown, EMA, ATR, 24h momentum and funding-rate inputs
- Dynamic trending/opportunity ranking
- Known-memecoin tagging
- Up to 8 simultaneous paper positions
- Portfolio-wide risk cap
- Separate risk settings for core spot, memecoins and perps
- Automatic stop-loss and 2R target simulation
- Automatic paper-entry mode
- SQLite persistence
- iPhone-friendly PWA dashboard
- No real-money order execution

## Important difference from V2

GitHub Pages can host V2 because V2 is only a static webpage.

V3 needs a continuously running Python server. GitHub should hold the code, but the app must be deployed to a service that can run the included Dockerfile or Python web process.

## Local computer test

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn backend.main:app --reload
```

Then open:

```text
http://127.0.0.1:8000
```

## Server command

```bash
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

The included Dockerfile can also be used on a container hosting service.

## Paper-risk defaults

- Starting virtual balance: 10,000 USDT
- Maximum simultaneous positions: 8
- Maximum total portfolio risk: 3%
- Core spot risk/trade: 0.5%
- Memecoin spot risk/trade: 0.25%
- Perp risk/trade: 0.35%
- Perpetual leverage: 1x simulated
- Target: 2R

These are intentionally conservative starting settings.

## Data

V3 uses public Binance spot and futures market-data endpoints. It does not require Binance credentials.

## Safety / architecture

There are intentionally:
- no API-key input fields
- no withdrawal code
- no real-order endpoints
- no exchange authentication routines

Every trade in V3 is simulated.

## Next upgrades

Good V3.x upgrades after gathering enough paper trades:
- persist open-interest history instead of only the latest level
- adaptive strategy weights from out-of-sample paper results
- correlation-aware portfolio exposure
- trailing stops / partial exits
- notifications
- broader exchange support
- proper walk-forward backtesting

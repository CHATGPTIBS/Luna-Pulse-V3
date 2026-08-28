# Luna Pulse V3.3

Luna Pulse V3.3 is a private, authenticated paper-trading research dashboard.

## What's new

### Professional login
- Username + password login.
- No public sign-up route.
- Only an admin/owner can create accounts.
- Passwords are hashed with Python scrypt before storage.
- Sessions use a random HTTP-only cookie.
- Trading API routes require authentication.

### New navigation
The sidebar contains:
- Dashboard
- Forex
- Crypto
- Perps
- Meme Coins
- History

The online indicator has moved to the bottom profile card.
The top-right header now displays the current paper balance/equity.

### Forex page
Pairs:
- EUR/USD
- GBP/USD
- AUD/USD
- USD/JPY

The chart uses TradingView's embeddable Advanced Chart widget.

The Invest modal has:
1. AI
   - Analyses both 15-minute and 1-hour candles.
   - Produces a directional Luna confidence score.
   - Can open an AI paper trade.
   - Can enable automatic Forex paper trading.
2. Manual
   - Buy / Sell
   - Market / Limit / Stop
   - Lot size
   - Pending-entry trigger price
   - Stop loss in pips
   - Take profit in pips
   - Comment
   - AI Analysis button

Forex automated analysis needs a Twelve Data API key.
TradingView supplies the visual chart; Luna's automated model does NOT scrape TradingView.

### Crypto page
- TradingView spot chart.
- Invest modal with AI and Manual tabs.
- AI tab shows the current Luna scanner analysis.
- Manual tab opens the selected spot paper position through the existing risk engine.
- Manual trading includes an AI Analysis button.

### Perps / Meme Coins
- Trending scanner lists.
- Tap a coin to open a TradingView chart.
- Existing Kraken market-data scanner remains the backend source.

## IMPORTANT: paper only

V3.3 contains no live-money exchange or Forex broker execution.
All automated/manual trade execution remains simulated.

## Render setup

Before deploying V3.3, add these environment variables to the SAME Render Web Service:

Required:
- LUNA_ADMIN_USERNAME = your private owner username
- LUNA_ADMIN_PASSWORD = a strong password of at least 10 characters
- LUNA_ADMIN_DISPLAY_NAME = your display name

Recommended:
- TWELVE_DATA_API_KEY = your Twelve Data API key
  Required for live 15-minute + 1-hour Forex analysis and Forex paper orders.

Optional:
- LUNA_SESSION_HOURS = 168
- LUNA_COOKIE_SECURE = 1
- LUNA_FOREX_AUTO_CONFIDENCE = 68
- LUNA_FOREX_SCAN_SECONDS = 900

Then commit the V3.3 files to GitHub. Render should redeploy the same service.

## Owner-only account creation

There is no registration page or `/signup` API.

After the owner logs in:
1. Tap the profile card at the bottom of the sidebar.
2. The owner sees "Create user account".
3. Create the username/display name/password.
4. Normal users do not receive that owner control and the backend rejects non-admin requests to create accounts.

## Existing V3 trade history

V3.3 includes a migration path for an existing SQLite V3 database:
- Legacy positions/trades are assigned to the bootstrap admin account.
- The previous paper balance and Crypto Auto state are copied to the admin account once.

However, Render's free-service filesystem is ephemeral. A redeploy/restart can still remove SQLite data.
For reliable users, passwords, balances and history, the next infrastructure upgrade should move the DB to persistent Postgres.

## Forex data

TradingView charts and Luna Forex analysis are separate:
- TradingView = visual interactive chart in the browser.
- Twelve Data = candle data used by Luna's backend analysis.

The Luna Forex "confidence" value is a strategy score from technical signals. It is not a guaranteed or statistically calibrated probability of future price movement.

## Files changed / added

backend/auth.py
backend/config.py
backend/db.py
backend/engine.py
backend/forex.py
backend/main.py
backend/market.py
static/index.html
static/manifest.json
static/sw.js

## Notes

This version interprets the requested "15 hour" chart as a 15-minute chart, paired with the 1-hour chart.

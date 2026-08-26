"""
Luna Pulse V3.1 — Kraken market-data adapter
============================================

DROP-IN REPLACEMENT FOR:
    backend/market.py

Why Kraken?
-----------
The Render instance is in Virginia (US). Binance returned HTTP 451 and Bybit
officially blocks US IP addresses. This module uses Kraken's public spot and
futures market-data APIs instead.

IMPORTANT:
- Public market data only.
- No Kraken API key.
- No order placement.
- No withdrawals.
- Paper trading remains handled by Luna Pulse's existing engine.py.

This file preserves the MarketClient interface expected by V3's engine.py.
"""

import asyncio
from statistics import mean
from typing import Any

import httpx

from .config import SETTINGS, MEME_SYMBOLS


KRAKEN_SPOT = "https://api.kraken.com"
KRAKEN_FUTURES = "https://futures.kraken.com"

# Kraken historically uses XBT for Bitcoin and XDG for Dogecoin in parts of its API.
ASSET_ALIASES = {
    "XBT": "BTC",
    "XXBT": "BTC",
    "XDG": "DOGE",
    "XXDG": "DOGE",
    "XETH": "ETH",
    "ETH": "ETH",
}

# Assets that are generally not useful for a momentum scanner.
EXCLUDED_BASE_ASSETS = {
    "USD", "USDT", "USDC", "EUR", "GBP", "AUD", "CAD", "JPY", "CHF",
    "DAI", "PYUSD", "EURT",
}


def clean_asset(asset: str) -> str:
    asset = (asset or "").upper()
    # Kraken internal symbols can carry leading X/Z naming.
    if asset in ASSET_ALIASES:
        return ASSET_ALIASES[asset]
    if asset.startswith("X") and len(asset) > 3 and asset[1:] in {"ETH", "LTC", "ETC", "XMR"}:
        asset = asset[1:]
    return ASSET_ALIASES.get(asset, asset)


def asset_from_symbol(symbol: str) -> str:
    s = (symbol or "").upper()

    # Kraken perpetual format: PF_XBTUSD, PF_SOLUSD, etc.
    if s.startswith(("PF_", "PI_")):
        core = s.split("_", 1)[1]
        for quote in ("USDT", "USDC", "USD"):
            if core.endswith(quote):
                return clean_asset(core[:-len(quote)])
        return clean_asset(core)

    # Kraken spot alt names: XBTUSD, ETHUSD, DOGEUSD, etc.
    for quote in ("USDT", "USDC", "USD"):
        if s.endswith(quote):
            return clean_asset(s[:-len(quote)])

    return clean_asset(s)


def is_meme(symbol: str) -> bool:
    return asset_from_symbol(symbol) in MEME_SYMBOLS


def ema(values, period):
    if not values:
        return 0.0
    k = 2 / (period + 1)
    x = values[0]
    for v in values[1:]:
        x = v * k + x * (1 - k)
    return x


def _f(value, default=0.0):
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def analyze_candles(
    candles: list[dict],
    market: str,
    symbol: str,
    change_24h: float,
    funding: float = 0.0,
    oi_bias: float = 0.0,
):
    """
    Returns the same opportunity shape used by Luna Pulse V3.

    candles must contain:
      open_time, open, high, low, close, volume
    """
    if len(candles) < 30:
        raise ValueError(f"not enough candle data for {symbol}")

    # Public OHLC endpoints generally include the current/incomplete candle.
    c = candles[:-1] if len(candles) > 30 else candles
    if len(c) < 29:
        raise ValueError(f"not enough closed candles for {symbol}")

    closes = [x["close"] for x in c]
    highs = [x["high"] for x in c]
    lows = [x["low"] for x in c]
    vols = [x["volume"] for x in c]
    i = len(c) - 1

    r1 = closes[i] / closes[i - 1] - 1 if closes[i - 1] else 0
    r3 = closes[i] / closes[i - 3] - 1 if closes[i - 3] else 0
    r6 = closes[i] / closes[i - 6] - 1 if closes[i - 6] else 0

    hist_vols = vols[max(0, i - 20):i]
    vavg = mean(hist_vols) if hist_vols else 0
    vol_ratio = vols[i] / vavg if vavg else 1.0

    recent_high = max(highs[max(0, i - 20):i])
    recent_low = min(lows[max(0, i - 20):i])
    e9 = ema(closes[-35:], 9)
    e21 = ema(closes[-35:], 21)

    trs = []
    for j in range(1, len(c)):
        trs.append(
            max(
                highs[j] - lows[j],
                abs(highs[j] - closes[j - 1]),
                abs(lows[j] - closes[j - 1]),
            )
        )
    atr = mean(trs[-14:]) if trs else closes[-1] * 0.01

    # LONG score
    long_score = 0.0
    long_reasons = []

    if r3 >= 0.012:
        long_score += 1.8
        long_reasons.append("3-candle momentum")
    if r6 >= 0.020:
        long_score += 1.6
        long_reasons.append("6-candle momentum")
    if vol_ratio >= 1.5:
        long_score += 1.7
        long_reasons.append(f"volume {vol_ratio:.1f}x")
    if closes[i] > recent_high:
        long_score += 1.8
        long_reasons.append("20-candle breakout")
    if e9 > e21:
        long_score += 1.4
        long_reasons.append("EMA trend up")
    if change_24h > 0:
        long_score += min(0.8, change_24h / 25)
    if r1 >= 0.045:
        long_score -= 2.5
        long_reasons.append("overextended")

    if is_meme(symbol) and change_24h > 35:
        long_score -= 1.5
        long_reasons.append("meme overheated")

    if market == "perp":
        if funding > 0.001:
            long_score -= 0.8
            long_reasons.append("crowded positive funding")
        elif funding < -0.0005:
            long_score += 0.5
            long_reasons.append("negative funding")
        long_score += max(-0.5, min(0.5, oi_bias))

    # SHORT score — only used by perp markets.
    short_score = 0.0
    short_reasons = []

    if r3 <= -0.012:
        short_score += 1.8
        short_reasons.append("3-candle downside momentum")
    if r6 <= -0.020:
        short_score += 1.6
        short_reasons.append("6-candle downside momentum")
    if vol_ratio >= 1.5:
        short_score += 1.7
        short_reasons.append(f"volume {vol_ratio:.1f}x")
    if closes[i] < recent_low:
        short_score += 1.8
        short_reasons.append("20-candle breakdown")
    if e9 < e21:
        short_score += 1.4
        short_reasons.append("EMA trend down")
    if change_24h < 0:
        short_score += min(0.8, abs(change_24h) / 25)
    if r1 <= -0.045:
        short_score -= 2.5
        short_reasons.append("down move overextended")

    if market == "perp":
        if funding > 0.001:
            short_score += 0.5
            short_reasons.append("crowded longs")
        elif funding < -0.001:
            short_score -= 0.8
            short_reasons.append("crowded shorts")
        short_score -= max(-0.5, min(0.5, oi_bias))

    long_score = max(0.0, min(10.0, long_score))
    short_score = max(0.0, min(10.0, short_score))

    if market == "spot":
        side = "LONG"
        score = long_score
        reasons = long_reasons
    else:
        if short_score > long_score:
            side = "SHORT"
            score = short_score
            reasons = short_reasons
        else:
            side = "LONG"
            score = long_score
            reasons = long_reasons

    return {
        "asset": asset_from_symbol(symbol),
        "symbol": symbol,
        "market": market,
        "side": side,
        "score": round(score, 2),
        "long_score": round(long_score, 2),
        "short_score": round(short_score, 2),
        "price": closes[-1],
        "atr": atr,
        "change_24h": change_24h,
        "vol_ratio": round(vol_ratio, 2),
        "funding": funding,
        "is_meme": is_meme(symbol),
        "reasons": reasons,
        "closes": closes[-50:],
        "provider": "kraken",
    }


class MarketClient:
    """
    Public Kraken spot + public Kraken futures scanner.

    The rest of Luna Pulse V3 can keep using:
        await client.scan()
    """

    def __init__(self):
        self.client = httpx.AsyncClient(
            timeout=15.0,
            headers={
                "User-Agent": "LunaPulseV3.1/1.0",
                "Accept": "application/json",
            },
            follow_redirects=True,
        )
        # Keep this conservative for public API limits.
        self.sem = asyncio.Semaphore(4)

    async def close(self):
        await self.client.aclose()

    async def _get(self, url: str, params: dict | None = None):
        async with self.sem:
            response = await self.client.get(url, params=params)

        response.raise_for_status()
        data = response.json()

        # Kraken spot REST returns errors in JSON even with HTTP 200.
        if isinstance(data, dict) and data.get("error"):
            errors = data.get("error") or []
            if errors:
                raise RuntimeError("Kraken API: " + "; ".join(map(str, errors)))

        return data

    # ------------------------------------------------------------------
    # SPOT
    # ------------------------------------------------------------------

    async def _spot_pairs(self) -> list[dict]:
        data = await self._get(f"{KRAKEN_SPOT}/0/public/AssetPairs")
        result = data.get("result", {})

        rows = []
        for internal_key, p in result.items():
            alt = str(p.get("altname") or "")
            wsname = str(p.get("wsname") or "")
            if not alt or not wsname:
                continue
            if ".d" in alt.lower():
                continue

            # Favor normal USD markets. Use USDT as a fallback.
            if wsname.endswith("/USD"):
                quote = "USD"
                quote_rank = 0
            elif wsname.endswith("/USDT"):
                quote = "USDT"
                quote_rank = 1
            else:
                continue

            base_ws = wsname.split("/", 1)[0].upper()
            base = clean_asset(base_ws)
            if base in EXCLUDED_BASE_ASSETS:
                continue

            rows.append({
                "internal": internal_key,
                "symbol": alt.upper(),
                "asset": base,
                "quote": quote,
                "quote_rank": quote_rank,
            })

        # Prefer USD over USDT when both exist for the same asset.
        rows.sort(key=lambda x: (x["asset"], x["quote_rank"]))
        deduped = {}
        for row in rows:
            deduped.setdefault(row["asset"], row)
        return list(deduped.values())

    async def _spot_ticker_batch(self, pairs: list[dict]) -> list[dict]:
        """
        Kraken's legacy Ticker endpoint supports multiple comma-separated pairs.
        Result keys normally use Kraken's internal pair keys, so we map those back
        to our AssetPairs metadata.
        """
        if not pairs:
            return []

        query = ",".join(p["symbol"] for p in pairs)
        data = await self._get(
            f"{KRAKEN_SPOT}/0/public/Ticker",
            {"pair": query},
        )
        result = data.get("result", {})

        by_internal = {p["internal"]: p for p in pairs}
        rows = []

        for key, ticker in result.items():
            meta = by_internal.get(key)

            # If Kraken returned a differently normalized key, try matching by
            # asset/alt name as a defensive fallback.
            if meta is None:
                # Usually result count/order still matches the request, but avoid
                # relying on ordering unless there is exactly one item.
                if len(pairs) == 1:
                    meta = pairs[0]
                else:
                    continue

            last = _f((ticker.get("c") or [0])[0])
            vol24 = _f((ticker.get("v") or [0, 0])[-1])
            vwap24 = _f((ticker.get("p") or [last, last])[-1], last)
            quote_volume = vol24 * (vwap24 or last)

            # "o" is the opening price exposed by Kraken ticker. It is sufficient
            # as a ranking hint; exact candle momentum is computed from OHLC later.
            open_price = _f(ticker.get("o"), last)
            change = ((last / open_price) - 1) * 100 if open_price else 0.0

            if last <= 0 or quote_volume <= 0:
                continue

            rows.append({
                **meta,
                "price": last,
                "change": change,
                "quote_volume": quote_volume,
            })

        return rows

    async def spot_universe(self):
        pairs = await self._spot_pairs()

        rows = []
        batch_size = 20
        for i in range(0, len(pairs), batch_size):
            batch = pairs[i:i + batch_size]
            try:
                rows.extend(await self._spot_ticker_batch(batch))
            except Exception:
                # Don't kill the entire spot scanner because one ticker batch fails.
                continue

        rows = [
            r for r in rows
            if r["quote_volume"] >= SETTINGS.min_quote_volume_usdt
        ]
        rows.sort(key=lambda x: x["quote_volume"], reverse=True)
        return rows[:SETTINGS.spot_universe_size]

    async def _spot_candles(self, symbol: str) -> list[dict]:
        interval_map = {
            "1m": 1,
            "5m": 5,
            "15m": 15,
            "30m": 30,
            "1h": 60,
            "4h": 240,
            "1d": 1440,
        }
        interval = interval_map.get(SETTINGS.candle_interval, 5)

        data = await self._get(
            f"{KRAKEN_SPOT}/0/public/OHLC",
            {"pair": symbol, "interval": interval},
        )
        result = data.get("result", {})
        pair_keys = [k for k in result.keys() if k != "last"]
        if not pair_keys:
            raise RuntimeError(f"Kraken returned no OHLC for {symbol}")

        raw = result[pair_keys[0]]
        raw = raw[-max(SETTINGS.candle_limit, 40):]

        candles = []
        for k in raw:
            # Kraken OHLC: time, open, high, low, close, vwap, volume, count
            candles.append({
                "open_time": int(float(k[0])) * 1000,
                "open": _f(k[1]),
                "high": _f(k[2]),
                "low": _f(k[3]),
                "close": _f(k[4]),
                "volume": _f(k[6]),
            })
        return candles

    # ------------------------------------------------------------------
    # PERPETUAL FUTURES
    # ------------------------------------------------------------------

    async def perp_universe(self):
        data = await self._get(
            f"{KRAKEN_FUTURES}/derivatives/api/v3/tickers"
        )
        tickers = data.get("tickers", [])

        rows = []
        for t in tickers:
            symbol = str(
                t.get("symbol")
                or t.get("product_id")
                or ""
            ).upper()

            if not symbol:
                continue

            tag = str(t.get("tag") or "").lower()
            suspended = bool(t.get("suspended", False))

            # PF_ is Kraken's perpetual linear family in current public feeds.
            # tag=="perpetual" is accepted as an additional defensive check.
            if not (symbol.startswith("PF_") or tag == "perpetual"):
                continue
            if suspended:
                continue

            asset = asset_from_symbol(symbol)
            if asset in EXCLUDED_BASE_ASSETS:
                continue

            last = _f(t.get("last") or t.get("markPrice") or t.get("mark_price"))
            change = _f(t.get("change") or t.get("change24h"))
            volume_quote = _f(
                t.get("volumeQuote")
                or t.get("volume_quote")
                or 0
            )

            # Some responses expose only base volume. Estimate quote volume.
            if volume_quote <= 0:
                base_volume = _f(t.get("volume"))
                volume_quote = base_volume * last

            if last <= 0 or volume_quote < SETTINGS.min_quote_volume_usdt:
                continue

            funding = _f(
                t.get("relativeFundingRate")
                or t.get("relative_funding_rate")
                or t.get("fundingRate")
                or t.get("funding_rate")
            )
            open_interest = _f(
                t.get("openInterest")
                or t.get("open_interest")
            )

            rows.append({
                "symbol": symbol,
                "asset": asset,
                "change": change,
                "quote_volume": volume_quote,
                "price": last,
                "funding": funding,
                "open_interest": open_interest,
            })

        rows.sort(key=lambda x: x["quote_volume"], reverse=True)
        return rows[:SETTINGS.perp_universe_size]

    async def _perp_candles(self, symbol: str) -> list[dict]:
        resolution = SETTINGS.candle_interval
        allowed = {"1m", "5m", "15m", "30m", "1h", "4h", "12h", "1d", "1w"}
        if resolution not in allowed:
            resolution = "5m"

        data = await self._get(
            f"{KRAKEN_FUTURES}/api/charts/v1/trade/{symbol}/{resolution}",
            {"count": max(SETTINGS.candle_limit, 40)},
        )
        raw = data.get("candles", [])

        candles = []
        for k in raw:
            candles.append({
                "open_time": int(k.get("time") or 0),
                "open": _f(k.get("open")),
                "high": _f(k.get("high")),
                "low": _f(k.get("low")),
                "close": _f(k.get("close")),
                "volume": _f(k.get("volume")),
            })

        candles.sort(key=lambda x: x["open_time"])
        return candles

    # ------------------------------------------------------------------
    # ANALYSIS / SCANNER
    # ------------------------------------------------------------------

    async def analyze_one(self, market: str, row: dict):
        symbol = row["symbol"]

        if market == "spot":
            candles = await self._spot_candles(symbol)
            result = analyze_candles(
                candles,
                "spot",
                symbol,
                row.get("change", 0.0),
            )
            # Use the fresher ticker last price for paper entries.
            result["price"] = row.get("price") or result["price"]
            result["quote_volume"] = row.get("quote_volume", 0)
            return result

        candles = await self._perp_candles(symbol)
        result = analyze_candles(
            candles,
            "perp",
            symbol,
            row.get("change", 0.0),
            funding=row.get("funding", 0.0),
            oi_bias=0.0,
        )
        result["price"] = row.get("price") or result["price"]
        result["quote_volume"] = row.get("quote_volume", 0)
        result["open_interest"] = row.get("open_interest", 0.0)
        return result

    async def scan(self):
        """
        Scan spot and perps independently.

        A temporary Kraken futures issue will no longer take the spot scanner down,
        and vice versa. Only raise if both market families fail.
        """
        universe_results = await asyncio.gather(
            self.spot_universe(),
            self.perp_universe(),
            return_exceptions=True,
        )

        spot_rows = (
            universe_results[0]
            if not isinstance(universe_results[0], Exception)
            else []
        )
        perp_rows = (
            universe_results[1]
            if not isinstance(universe_results[1], Exception)
            else []
        )

        if not spot_rows and not perp_rows:
            messages = []
            for result in universe_results:
                if isinstance(result, Exception):
                    messages.append(str(result))
            raise RuntimeError(
                "Kraken spot and futures scanners both failed"
                + (": " + " | ".join(messages) if messages else "")
            )

        tasks = []
        for row in spot_rows:
            tasks.append(self.analyze_one("spot", row))
        for row in perp_rows:
            tasks.append(self.analyze_one("perp", row))

        analyzed = await asyncio.gather(*tasks, return_exceptions=True)

        clean = []
        for item in analyzed:
            if isinstance(item, Exception):
                continue
            clean.append(item)

        if not clean:
            raise RuntimeError(
                "Kraken universes loaded, but no markets returned enough OHLC data."
            )

        clean.sort(key=lambda x: x["score"], reverse=True)
        return clean

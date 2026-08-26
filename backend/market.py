import asyncio
import math
from statistics import mean
import httpx

from .config import SETTINGS, MEME_SYMBOLS

SPOT = "https://api.binance.com"
PERP = "https://fapi.binance.com"

def asset_from_symbol(symbol: str) -> str:
    return symbol[:-4] if symbol.endswith("USDT") else symbol

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

def analyze_klines(raw, market: str, symbol: str, change_24h: float, funding: float = 0.0, oi_bias: float = 0.0):
    candles = [{
        "open_time": int(k[0]),
        "open": float(k[1]), "high": float(k[2]), "low": float(k[3]),
        "close": float(k[4]), "volume": float(k[5]), "close_time": int(k[6])
    } for k in raw]

    if len(candles) < 30:
        raise ValueError("not enough candle data")

    c = candles[:-1]  # last candle may still be open
    closes = [x["close"] for x in c]
    highs = [x["high"] for x in c]
    lows = [x["low"] for x in c]
    vols = [x["volume"] for x in c]
    i = len(c) - 1

    r1 = closes[i] / closes[i-1] - 1
    r3 = closes[i] / closes[i-3] - 1
    r6 = closes[i] / closes[i-6] - 1

    vavg = mean(vols[i-20:i]) if mean(vols[i-20:i]) else 1
    vol_ratio = vols[i] / vavg
    recent_high = max(highs[i-20:i])
    recent_low = min(lows[i-20:i])
    e9, e21 = ema(closes[-35:], 9), ema(closes[-35:], 21)

    trs = []
    for j in range(1, len(c)):
        trs.append(max(
            highs[j] - lows[j],
            abs(highs[j] - closes[j-1]),
            abs(lows[j] - closes[j-1]),
        ))
    atr = mean(trs[-14:])

    # LONG score
    long_score = 0.0
    long_reasons = []
    if r3 >= 0.012:
        long_score += 1.8; long_reasons.append("3-candle momentum")
    if r6 >= 0.020:
        long_score += 1.6; long_reasons.append("6-candle momentum")
    if vol_ratio >= 1.5:
        long_score += 1.7; long_reasons.append(f"volume {vol_ratio:.1f}x")
    if closes[i] > recent_high:
        long_score += 1.8; long_reasons.append("20-candle breakout")
    if e9 > e21:
        long_score += 1.4; long_reasons.append("EMA trend up")
    if change_24h > 0:
        long_score += min(0.8, change_24h / 25)
    if r1 >= 0.045:
        long_score -= 2.5; long_reasons.append("overextended")
    if is_meme(symbol) and change_24h > 35:
        long_score -= 1.5; long_reasons.append("meme overheated")
    if market == "perp":
        if funding > 0.001:
            long_score -= 0.8; long_reasons.append("crowded positive funding")
        elif funding < -0.0005:
            long_score += 0.5; long_reasons.append("negative funding")
        long_score += max(-0.5, min(0.5, oi_bias))

    # SHORT score
    short_score = 0.0
    short_reasons = []
    if r3 <= -0.012:
        short_score += 1.8; short_reasons.append("3-candle downside momentum")
    if r6 <= -0.020:
        short_score += 1.6; short_reasons.append("6-candle downside momentum")
    if vol_ratio >= 1.5:
        short_score += 1.7; short_reasons.append(f"volume {vol_ratio:.1f}x")
    if closes[i] < recent_low:
        short_score += 1.8; short_reasons.append("20-candle breakdown")
    if e9 < e21:
        short_score += 1.4; short_reasons.append("EMA trend down")
    if change_24h < 0:
        short_score += min(0.8, abs(change_24h) / 25)
    if r1 <= -0.045:
        short_score -= 2.5; short_reasons.append("down move overextended")
    if market == "perp":
        if funding > 0.001:
            short_score += 0.5; short_reasons.append("crowded longs")
        elif funding < -0.001:
            short_score -= 0.8; short_reasons.append("crowded shorts")
        short_score -= max(-0.5, min(0.5, oi_bias))

    long_score = max(0.0, min(10.0, long_score))
    short_score = max(0.0, min(10.0, short_score))

    if market == "spot":
        side = "LONG"
        score = long_score
        reasons = long_reasons
    else:
        if short_score > long_score:
            side, score, reasons = "SHORT", short_score, short_reasons
        else:
            side, score, reasons = "LONG", long_score, long_reasons

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
    }

class MarketClient:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=12.0, headers={"User-Agent": "LunaPulseV3/1.0"})
        self.sem = asyncio.Semaphore(8)

    async def close(self):
        await self.client.aclose()

    async def _get(self, url, params=None):
        async with self.sem:
            r = await self.client.get(url, params=params)
            r.raise_for_status()
            return r.json()

    async def spot_universe(self):
        info, tickers = await asyncio.gather(
            self._get(f"{SPOT}/api/v3/exchangeInfo"),
            self._get(f"{SPOT}/api/v3/ticker/24hr")
        )
        tradable = {
            s["symbol"] for s in info["symbols"]
            if s["status"] == "TRADING" and s.get("quoteAsset") == "USDT"
            and s.get("isSpotTradingAllowed", True)
        }
        rows = []
        for t in tickers:
            if t["symbol"] not in tradable:
                continue
            qv = float(t.get("quoteVolume") or 0)
            if qv < SETTINGS.min_quote_volume_usdt:
                continue
            rows.append({
                "symbol": t["symbol"],
                "change": float(t["priceChangePercent"]),
                "quote_volume": qv,
            })
        rows.sort(key=lambda x: x["quote_volume"], reverse=True)
        return rows[:SETTINGS.spot_universe_size]

    async def perp_universe(self):
        info, tickers = await asyncio.gather(
            self._get(f"{PERP}/fapi/v1/exchangeInfo"),
            self._get(f"{PERP}/fapi/v1/ticker/24hr")
        )
        tradable = {
            s["symbol"] for s in info["symbols"]
            if s["status"] == "TRADING" and s.get("quoteAsset") == "USDT"
            and s.get("contractType") == "PERPETUAL"
        }
        rows = []
        for t in tickers:
            if t["symbol"] not in tradable:
                continue
            qv = float(t.get("quoteVolume") or 0)
            if qv < SETTINGS.min_quote_volume_usdt:
                continue
            rows.append({
                "symbol": t["symbol"],
                "change": float(t["priceChangePercent"]),
                "quote_volume": qv,
            })
        rows.sort(key=lambda x: x["quote_volume"], reverse=True)
        return rows[:SETTINGS.perp_universe_size]

    async def analyze_one(self, market: str, row: dict):
        symbol = row["symbol"]
        if market == "spot":
            raw = await self._get(
                f"{SPOT}/api/v3/klines",
                {"symbol": symbol, "interval": SETTINGS.candle_interval, "limit": SETTINGS.candle_limit}
            )
            return analyze_klines(raw, "spot", symbol, row["change"])

        raw_task = self._get(
            f"{PERP}/fapi/v1/klines",
            {"symbol": symbol, "interval": SETTINGS.candle_interval, "limit": SETTINGS.candle_limit}
        )
        premium_task = self._get(f"{PERP}/fapi/v1/premiumIndex", {"symbol": symbol})
        oi_task = self._get(f"{PERP}/fapi/v1/openInterest", {"symbol": symbol})
        raw, premium, oi = await asyncio.gather(raw_task, premium_task, oi_task)

        funding = float(premium.get("lastFundingRate") or 0)
        # OI level alone isn't directional. We keep a tiny neutral placeholder until
        # we collect time-series OI in a future learning upgrade.
        oi_bias = 0.0
        result = analyze_klines(raw, "perp", symbol, row["change"], funding, oi_bias)
        result["open_interest"] = float(oi.get("openInterest") or 0)
        return result

    async def scan(self):
        spot_rows, perp_rows = await asyncio.gather(self.spot_universe(), self.perp_universe())

        tasks = [self.analyze_one("spot", r) for r in spot_rows]
        tasks += [self.analyze_one("perp", r) for r in perp_rows]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        clean = []
        for r in results:
            if isinstance(r, Exception):
                continue
            clean.append(r)

        clean.sort(key=lambda x: x["score"], reverse=True)
        return clean

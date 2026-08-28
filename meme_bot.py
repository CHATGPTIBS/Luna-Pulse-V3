import asyncio
import math
from datetime import datetime, timezone, timedelta

import httpx

from .config import SETTINGS
from . import db


DEX_BASE = "https://api.dexscreener.com"
SOLANA = "solana"
STABLES = {"USDC", "USDT", "USD", "DAI", "PYUSD"}
WRAPPED_SOL = "So11111111111111111111111111111111111111112"


def _f(v, default=0.0):
    try:
        if v is None or v == "":
            return default
        x = float(v)
        return x if math.isfinite(x) else default
    except (TypeError, ValueError):
        return default


def _bucket(obj, key):
    x = (obj or {}).get(key) or {}
    return {
        "buys": int(x.get("buys") or 0),
        "sells": int(x.get("sells") or 0),
    }


def _metric(obj, key):
    return _f((obj or {}).get(key), 0.0)


def _age_minutes(pair):
    ts = pair.get("pairCreatedAt")
    if not ts:
        return 10**9
    try:
        created = datetime.fromtimestamp(float(ts) / 1000.0, tz=timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - created).total_seconds() / 60.0)
    except Exception:
        return 10**9


def score_pair(pair: dict, discovery_boost: float = 0.0) -> dict | None:
    """Score a DexScreener Solana pair. Returns None when a hard safety filter fails."""
    base = pair.get("baseToken") or {}
    quote = pair.get("quoteToken") or {}
    symbol = str(base.get("symbol") or "").upper()
    address = str(base.get("address") or "")
    quote_symbol = str(quote.get("symbol") or "").upper()

    price = _f(pair.get("priceUsd"))
    liquidity = _f((pair.get("liquidity") or {}).get("usd"))
    market_cap = _f(pair.get("marketCap") or pair.get("fdv"))
    age_min = _age_minutes(pair)
    vol5 = _metric(pair.get("volume"), "m5")
    vol1h = _metric(pair.get("volume"), "h1")
    vol24 = _metric(pair.get("volume"), "h24")
    ch5 = _metric(pair.get("priceChange"), "m5")
    ch1h = _metric(pair.get("priceChange"), "h1")
    ch24 = _metric(pair.get("priceChange"), "h24")

    tx5 = _bucket(pair.get("txns"), "m5")
    tx1h = _bucket(pair.get("txns"), "h1")
    tx5_total = tx5["buys"] + tx5["sells"]
    tx1_total = tx1h["buys"] + tx1h["sells"]
    buy_ratio5 = tx5["buys"] / tx5_total if tx5_total else 0.0
    buy_ratio1h = tx1h["buys"] / tx1_total if tx1_total else 0.0
    velocity = vol5 / max(vol1h / 12.0, 1.0)

    # Hard filters. These do not prove a token is safe; they remove obvious
    # low-liquidity / hyper-extended setups from the paper strategy.
    if not address or not symbol or price <= 0:
        return None
    if address == WRAPPED_SOL or symbol in STABLES:
        return None
    if quote_symbol not in {"SOL", "WSOL", "USDC", "USDT"}:
        return None
    if liquidity < SETTINGS.meme_bot_min_liquidity:
        return None
    if age_min < SETTINGS.meme_bot_min_pair_age_minutes:
        return None
    if vol1h < SETTINGS.meme_bot_min_h1_volume or vol5 < SETTINGS.meme_bot_min_m5_volume:
        return None
    if tx5_total < 10 or buy_ratio5 < 0.48:
        return None
    if ch5 > 40 or ch1h > 120 or ch24 > 800:
        return None
    if ch5 < -25 or ch1h < -60:
        return None
    if market_cap > 0 and liquidity / market_cap < 0.012:
        return None

    score = 0.0
    reasons = []
    warnings = []

    # Liquidity
    if liquidity >= 1_000_000:
        score += 1.3; reasons.append("deep liquidity")
    elif liquidity >= 500_000:
        score += 1.0; reasons.append("strong liquidity")
    elif liquidity >= 250_000:
        score += 0.7; reasons.append("acceptable liquidity")
    else:
        score += 0.35

    # Volume acceleration
    if vol5 >= 50_000:
        score += 1.2; reasons.append("heavy 5m volume")
    elif vol5 >= 20_000:
        score += 0.8; reasons.append("rising 5m volume")
    elif vol5 >= 10_000:
        score += 0.45

    if velocity >= 3.0:
        score += 1.4; reasons.append(f"volume velocity {velocity:.1f}x")
    elif velocity >= 1.8:
        score += 0.9; reasons.append(f"volume velocity {velocity:.1f}x")
    elif velocity >= 1.2:
        score += 0.4

    # Buy pressure
    if buy_ratio5 >= 0.72:
        score += 1.5; reasons.append(f"5m buys {buy_ratio5*100:.0f}%")
    elif buy_ratio5 >= 0.62:
        score += 1.0; reasons.append(f"5m buys {buy_ratio5*100:.0f}%")
    elif buy_ratio5 >= 0.55:
        score += 0.55

    if buy_ratio1h >= 0.58:
        score += 0.45; reasons.append("1h buyers dominant")
    elif buy_ratio1h < 0.45:
        score -= 0.5; warnings.append("weak 1h order flow")

    # Momentum: reward movement, but not vertical chasing.
    if 3 <= ch5 <= 15:
        score += 1.25; reasons.append(f"5m momentum +{ch5:.1f}%")
    elif 0.5 <= ch5 < 3:
        score += 0.55
    elif 15 < ch5 <= 30:
        score += 0.55; warnings.append("fast 5m extension")
    elif ch5 < 0:
        score -= 0.7

    if 5 <= ch1h <= 45:
        score += 1.25; reasons.append(f"1h momentum +{ch1h:.1f}%")
    elif 0 < ch1h < 5:
        score += 0.45
    elif 45 < ch1h <= 80:
        score += 0.35; warnings.append("1h extended")
    elif ch1h < -5:
        score -= 0.8

    # Activity
    if tx5_total >= 120:
        score += 0.65; reasons.append(f"{tx5_total} txns/5m")
    elif tx5_total >= 50:
        score += 0.35

    # Pair age: avoid the first minutes but still favor fresh momentum.
    if 30 <= age_min <= 60 * 24 * 7:
        score += 0.55
    elif age_min > 60 * 24 * 30:
        score += 0.1

    # Liquidity relative to valuation.
    liq_ratio = liquidity / market_cap if market_cap > 0 else 0
    if liq_ratio >= 0.10:
        score += 0.5; reasons.append("healthy liquidity/mcap")
    elif 0 < liq_ratio < 0.025:
        score -= 0.4; warnings.append("thin vs valuation")

    # Boosting is only a tiny discovery hint because boosts can be paid.
    score += min(0.25, max(0.0, discovery_boost))

    # Penalize extreme 24h pumps even when they pass the hard cutoff.
    if ch24 > 300:
        score -= 1.6; warnings.append("extreme 24h pump")
    elif ch24 > 150:
        score -= 0.8; warnings.append("large 24h pump")

    score = max(0.0, min(10.0, score))
    stop_pct = max(0.06, min(0.15, max(abs(ch5) * 0.004, abs(ch1h) * 0.0015)))

    info = pair.get("info") or {}
    image = info.get("imageUrl")
    return {
        "chain": "solana",
        "token_address": address,
        "pair_address": pair.get("pairAddress") or "",
        "dex_id": pair.get("dexId") or "",
        "symbol": symbol,
        "name": base.get("name") or symbol,
        "price": price,
        "liquidity": liquidity,
        "market_cap": market_cap,
        "volume_m5": vol5,
        "volume_h1": vol1h,
        "volume_h24": vol24,
        "change_m5": ch5,
        "change_h1": ch1h,
        "change_h24": ch24,
        "txns_m5": tx5_total,
        "buy_ratio_m5": buy_ratio5,
        "buy_ratio_h1": buy_ratio1h,
        "volume_velocity": velocity,
        "age_minutes": age_min,
        "score": round(score, 2),
        "stop_pct": stop_pct,
        "reasons": reasons[:6],
        "warnings": warnings[:5],
        "image": image,
        "url": pair.get("url"),
        "source": "dexscreener",
    }


class DexScreenerMarket:
    def __init__(self):
        self.client = httpx.AsyncClient(
            timeout=15.0,
            follow_redirects=True,
            headers={"User-Agent": "LunaMemeBot/1.0", "Accept": "application/json"},
        )
        self.sem = asyncio.Semaphore(4)

    async def close(self):
        await self.client.aclose()

    async def get(self, path):
        async with self.sem:
            r = await self.client.get(DEX_BASE + path)
        r.raise_for_status()
        return r.json()

    async def candidate_addresses(self):
        results = await asyncio.gather(
            self.get("/token-boosts/top/v1"),
            self.get("/token-boosts/latest/v1"),
            self.get("/token-profiles/latest/v1"),
            return_exceptions=True,
        )
        seen = {}
        for source_i, data in enumerate(results):
            if isinstance(data, Exception):
                continue
            if isinstance(data, dict):
                data = [data]
            for row in data or []:
                if str(row.get("chainId") or "").lower() != SOLANA:
                    continue
                addr = str(row.get("tokenAddress") or "")
                if not addr:
                    continue
                # Paid boosts are discovery only, not a strong quality signal.
                boost = 0.15 if source_i in (0, 1) else 0.0
                if addr not in seen:
                    seen[addr] = boost
                else:
                    seen[addr] = max(seen[addr], boost)
                if len(seen) >= SETTINGS.meme_bot_candidate_limit:
                    break
        return seen

    async def token_pairs(self, addresses):
        rows = []
        addresses = list(addresses)
        for i in range(0, len(addresses), 30):
            batch = addresses[i:i+30]
            path = "/tokens/v1/solana/" + ",".join(batch)
            try:
                data = await self.get(path)
                if isinstance(data, list):
                    rows.extend(data)
            except Exception:
                continue
        return rows

    async def best_pairs(self, candidate_map):
        rows = await self.token_pairs(candidate_map.keys())
        grouped = {}
        for pair in rows:
            base = pair.get("baseToken") or {}
            addr = str(base.get("address") or "")
            if addr not in candidate_map:
                continue
            liq = _f((pair.get("liquidity") or {}).get("usd"))
            current = grouped.get(addr)
            if current is None or liq > _f((current.get("liquidity") or {}).get("usd")):
                grouped[addr] = pair

        scored = []
        for addr, pair in grouped.items():
            x = score_pair(pair, candidate_map.get(addr, 0.0))
            if x:
                scored.append(x)
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored

    async def fetch_open_tokens(self, addresses):
        if not addresses:
            return {}
        rows = await self.token_pairs(addresses)
        best = {}
        wanted = set(addresses)
        for pair in rows:
            addr = str((pair.get("baseToken") or {}).get("address") or "")
            if addr not in wanted:
                continue
            liq = _f((pair.get("liquidity") or {}).get("usd"))
            cur = best.get(addr)
            if cur is None or liq > _f((cur.get("liquidity") or {}).get("usd")):
                best[addr] = pair
        return best


class LunaMemeBot:
    def __init__(self):
        self.market = DexScreenerMarket()
        self.opportunities = []
        self.last_scan = None
        self.last_error = None
        self.prices = {}
        self.market_rows = {}
        self.running = False
        self.task = None

    async def start(self):
        if self.running:
            return
        self.running = True
        self.task = asyncio.create_task(self.loop())

    async def stop(self):
        self.running = False
        if self.task:
            self.task.cancel()
        await self.market.close()

    async def loop(self):
        while self.running:
            try:
                await self.scan_once()
            except Exception as e:
                self.last_error = str(e)
            await asyncio.sleep(SETTINGS.meme_bot_scan_seconds)

    async def scan_once(self):
        candidates = await self.market.candidate_addresses()
        opportunities = await self.market.best_pairs(candidates)

        # Always refresh open tokens, even if they drop out of trending discovery.
        open_positions = db.list_meme_positions(None)
        open_addrs = sorted({p["token_address"] for p in open_positions})
        open_pairs = await self.market.fetch_open_tokens(open_addrs)

        self.opportunities = opportunities
        self.last_scan = datetime.now(timezone.utc).isoformat()
        self.last_error = None
        self.prices = {x["token_address"]: x["price"] for x in opportunities}
        self.market_rows = {x["token_address"]: x for x in opportunities}

        for addr, pair in open_pairs.items():
            price = _f(pair.get("priceUsd"))
            if price > 0:
                self.prices[addr] = price
                # score_pair can fail because the token is no longer an entry candidate;
                # still retain raw exit metrics.
                scored = score_pair(pair, 0.0)
                if scored:
                    self.market_rows[addr] = scored
                else:
                    tx = _bucket(pair.get("txns"), "m5")
                    total = tx["buys"] + tx["sells"]
                    self.market_rows[addr] = {
                        "token_address": addr,
                        "price": price,
                        "change_m5": _metric(pair.get("priceChange"), "m5"),
                        "buy_ratio_m5": tx["buys"] / total if total else 0.5,
                    }

        self.manage_open_positions()
        for uid in db.list_meme_auto_user_ids():
            self.auto_entries(uid)
        return opportunities

    def unrealized(self, user_id):
        total = 0.0
        for p in db.list_meme_positions(user_id):
            price = self.prices.get(p["token_address"], p["entry"])
            total += (price - p["entry"]) * p["qty"]
        return total

    def current_total_risk(self, user_id):
        return sum(float(p["risk_cash"]) for p in db.list_meme_positions(user_id))

    def open_position(self, user_id, opp, source="manual"):
        existing = db.list_meme_positions(user_id)
        if len(existing) >= SETTINGS.meme_bot_max_positions:
            return {"ok": False, "error": "Maximum meme paper positions reached."}
        if any(p["token_address"] == opp["token_address"] for p in existing):
            return {"ok": False, "error": "That token already has an open meme position."}
        if source == "auto" and opp["score"] < SETTINGS.meme_bot_entry_score:
            return {"ok": False, "error": "Luna meme score is below the auto-entry threshold."}
        if db.meme_recent_stop(user_id, opp["token_address"], SETTINGS.meme_bot_cooldown_minutes):
            return {"ok": False, "error": "Token is cooling down after a recent stop."}

        account = db.get_account(user_id)
        equity_base = max(float(account["cash"]), 1.0)
        risk_cash = equity_base * SETTINGS.meme_bot_risk_pct
        if self.current_total_risk(user_id) + risk_cash > equity_base * SETTINGS.meme_bot_max_total_risk_pct:
            return {"ok": False, "error": "Meme portfolio risk cap reached."}

        market_price = float(opp["price"])
        entry = market_price * (1.0 + SETTINGS.meme_bot_slippage_rate)
        stop_pct = float(opp.get("stop_pct") or 0.08)
        stop = entry * (1.0 - stop_pct)
        risk_distance = entry - stop
        target = entry + risk_distance * SETTINGS.meme_bot_reward_risk
        qty = risk_cash / max(risk_distance, entry * 0.01)

        p = {
            "token_address": opp["token_address"],
            "pair_address": opp.get("pair_address", ""),
            "dex_id": opp.get("dex_id", ""),
            "symbol": opp["symbol"],
            "name": opp.get("name", opp["symbol"]),
            "entry": entry,
            "stop": stop,
            "target": target,
            "qty": qty,
            "risk_cash": risk_cash,
            "score": opp["score"],
            "peak_price": entry,
            "source": source,
            "reason": ", ".join(opp.get("reasons", [])),
        }
        p["id"] = db.add_meme_position(user_id, p)
        return {"ok": True, "position": p}

    def close_position(self, user_id, position_id, reason="manual"):
        p = next((x for x in db.list_meme_positions(user_id) if x["id"] == position_id), None)
        if not p:
            return {"ok": False, "error": "Meme position not found."}
        price = self.prices.get(p["token_address"])
        if price is None:
            return {"ok": False, "error": "No current DexScreener price for this token."}
        return self._close(p, price, reason)

    def _close(self, p, market_price, reason):
        # Simulate sell-side slippage and DEX/route costs.
        exit_price = float(market_price) * (1.0 - SETTINGS.meme_bot_slippage_rate)
        gross = (exit_price - p["entry"]) * p["qty"]
        fees = (p["entry"] + exit_price) * p["qty"] * SETTINGS.meme_bot_fee_rate
        pnl = gross - fees
        db.close_meme_position(p["id"], exit_price, pnl, fees, reason)
        return {"ok": True, "exit": exit_price, "pnl": pnl, "reason": reason}

    def manage_open_positions(self):
        for p in db.list_meme_positions(None):
            price = self.prices.get(p["token_address"])
            if price is None:
                continue

            if price > p["peak_price"]:
                db.update_meme_peak(p["id"], price)
                p["peak_price"] = price

            r = p["entry"] - p["stop"]
            # After +1R, protect the trade; after +1.5R, trail the peak.
            if r > 0 and price >= p["entry"] + r:
                new_stop = max(p["stop"], p["entry"] * 1.006)
                if price >= p["entry"] + 1.5 * r:
                    new_stop = max(new_stop, p["peak_price"] - 0.75 * r)
                if new_stop > p["stop"]:
                    db.update_meme_stop(p["id"], new_stop)
                    p["stop"] = new_stop

            if price <= p["stop"]:
                self._close(p, p["stop"], "stop")
                continue
            if price >= p["target"]:
                self._close(p, p["target"], "target")
                continue

            row = self.market_rows.get(p["token_address"]) or {}
            # Exit when short-term price and order flow both collapse.
            if _f(row.get("change_m5")) <= -8 and _f(row.get("buy_ratio_m5"), 0.5) < 0.40:
                self._close(p, price, "momentum_fade")

    def auto_entries(self, user_id):
        for opp in self.opportunities:
            if len(db.list_meme_positions(user_id)) >= SETTINGS.meme_bot_max_positions:
                break
            if opp["score"] < SETTINGS.meme_bot_entry_score:
                continue
            result = self.open_position(user_id, opp, source="auto")
            if not result["ok"] and "risk cap" in result.get("error", "").lower():
                break


MEME_BOT = LunaMemeBot()

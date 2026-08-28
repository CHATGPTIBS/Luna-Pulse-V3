import asyncio
import math
from datetime import datetime, timezone
from statistics import mean

import httpx

from .config import SETTINGS, FOREX_PAIRS
from . import db


def _f(x, default=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def ema(values, period):
    if not values:
        return 0.0
    k = 2 / (period + 1)
    x = values[0]
    for v in values[1:]:
        x = v * k + x * (1 - k)
    return x


def rsi(values, period=14):
    if len(values) <= period:
        return 50.0
    gains, losses = [], []
    for i in range(1, len(values)):
        d = values[i] - values[i - 1]
        gains.append(max(d, 0))
        losses.append(max(-d, 0))
    ag = mean(gains[-period:]) if gains[-period:] else 0
    al = mean(losses[-period:]) if losses[-period:] else 0
    if al == 0:
        return 100.0 if ag > 0 else 50.0
    rs = ag / al
    return 100 - (100 / (1 + rs))


def atr(candles, period=14):
    if len(candles) < 2:
        return 0.0
    trs = []
    for i in range(1, len(candles)):
        h, l, pc = candles[i]["high"], candles[i]["low"], candles[i - 1]["close"]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return mean(trs[-period:]) if trs else 0.0


def pip_size(pair: str):
    return 0.01 if pair.endswith("/JPY") else 0.0001


def pnl_usd(pair: str, side: str, entry: float, exit_price: float, qty_base: float):
    direction = 1 if side == "LONG" else -1
    quote_pnl = (exit_price - entry) * qty_base * direction
    if pair.endswith("/JPY"):
        return quote_pnl / max(exit_price, 1e-9)
    return quote_pnl


def risk_usd(pair: str, entry: float, stop: float, qty_base: float):
    quote_risk = abs(entry - stop) * qty_base
    if pair.endswith("/JPY"):
        return quote_risk / max(entry, 1e-9)
    return quote_risk


def fees_usd(pair: str, entry: float, exit_price: float, qty_base: float):
    # Tiny simulated transaction-cost allowance; this is not a broker-specific spread model.
    notional_quote = (entry + exit_price) * qty_base
    if pair.endswith("/JPY"):
        notional_quote /= max(exit_price, 1e-9)
    return notional_quote * SETTINGS.forex_fee_rate


class ForexClient:
    BASE = "https://api.twelvedata.com"

    def __init__(self):
        self.client = httpx.AsyncClient(
            timeout=15.0,
            headers={"User-Agent": "LunaPulseV3.3/1.0", "Accept": "application/json"},
        )

    @property
    def configured(self):
        return bool(SETTINGS.twelve_data_api_key)

    async def close(self):
        await self.client.aclose()

    async def candles(self, pair: str, interval: str, outputsize: int = 120):
        if not self.configured:
            raise RuntimeError("Forex AI data feed not configured. Add TWELVE_DATA_API_KEY in Render.")

        r = await self.client.get(
            f"{self.BASE}/time_series",
            params={
                "symbol": pair,
                "interval": interval,
                "outputsize": outputsize,
                "apikey": SETTINGS.twelve_data_api_key,
                "timezone": "UTC",
            },
        )
        r.raise_for_status()
        data = r.json()
        if data.get("status") == "error" or "values" not in data:
            raise RuntimeError(data.get("message") or f"Forex data unavailable for {pair} {interval}")

        rows = []
        # Twelve Data returns newest first; reverse to chronological order.
        for x in reversed(data["values"]):
            rows.append({
                "datetime": x.get("datetime"),
                "open": _f(x.get("open")),
                "high": _f(x.get("high")),
                "low": _f(x.get("low")),
                "close": _f(x.get("close")),
            })
        if len(rows) < 30:
            raise RuntimeError(f"Not enough Forex candles for {pair} {interval}")
        return rows


def timeframe_signal(candles):
    closes = [x["close"] for x in candles]
    e9 = ema(closes[-60:], 9)
    e21 = ema(closes[-60:], 21)
    r = rsi(closes, 14)
    a = atr(candles, 14)
    mom3 = closes[-1] / closes[-4] - 1 if closes[-4] else 0
    mom6 = closes[-1] / closes[-7] - 1 if closes[-7] else 0

    score = 0.0
    reasons = []

    if e9 > e21:
        score += 1.0
        reasons.append("EMA trend up")
    else:
        score -= 1.0
        reasons.append("EMA trend down")

    if mom3 > 0:
        score += 0.6
        reasons.append("short momentum positive")
    elif mom3 < 0:
        score -= 0.6
        reasons.append("short momentum negative")

    if mom6 > 0:
        score += 0.4
    elif mom6 < 0:
        score -= 0.4

    if 52 <= r <= 70:
        score += 0.5
        reasons.append(f"RSI supportive {r:.0f}")
    elif 30 <= r <= 48:
        score -= 0.5
        reasons.append(f"RSI weak {r:.0f}")
    elif r > 76:
        score -= 0.25
        reasons.append("RSI overbought")
    elif r < 24:
        score += 0.25
        reasons.append("RSI oversold")

    return {
        "score": score,
        "ema9": e9,
        "ema21": e21,
        "rsi": r,
        "atr": a,
        "momentum_3": mom3,
        "momentum_6": mom6,
        "price": closes[-1],
        "reasons": reasons,
    }


def combine_analysis(pair, s15, s1h):
    # 1-hour trend is weighted more heavily than the 15-minute trigger.
    combined = s15["score"] * 0.9 + s1h["score"] * 1.35
    side = "LONG" if combined >= 0 else "SHORT"
    magnitude = abs(combined)

    # "Confidence" is a bounded strategy score, not a statistically calibrated probability.
    confidence = 50 + min(30, magnitude * 8)

    # Reward agreement between both timeframes and penalize disagreement.
    sign15 = 1 if s15["score"] >= 0 else -1
    sign1h = 1 if s1h["score"] >= 0 else -1
    if sign15 == sign1h:
        confidence += 5
        agreement = True
    else:
        confidence -= 8
        agreement = False
    confidence = max(50, min(85, confidence))

    reasons = [
        f"15m: {', '.join(s15['reasons'][:3])}",
        f"1h: {', '.join(s1h['reasons'][:3])}",
        "timeframes agree" if agreement else "timeframes disagree",
    ]

    return {
        "pair": pair,
        "side": side,
        "confidence": round(confidence, 1),
        "price": s15["price"],
        "atr15": s15["atr"],
        "atr1h": s1h["atr"],
        "rsi15": round(s15["rsi"], 1),
        "rsi1h": round(s1h["rsi"], 1),
        "ema15": {"fast": s15["ema9"], "slow": s15["ema21"]},
        "ema1h": {"fast": s1h["ema9"], "slow": s1h["ema21"]},
        "timeframe_agreement": agreement,
        "reasons": reasons,
        "method": "Luna multi-timeframe technical model",
        "warning": "Confidence is a strategy score, not a guaranteed or calibrated probability.",
    }


class ForexEngine:
    def __init__(self):
        self.market = ForexClient()
        self.analyses = {}
        self.prices = {}
        self.last_scan = None
        self.last_error = None
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
            if self.market.configured:
                try:
                    await self.scan_once()
                except Exception as e:
                    self.last_error = str(e)
            await asyncio.sleep(SETTINGS.forex_scan_interval_seconds)

    async def analyze_pair(self, pair: str):
        if pair not in FOREX_PAIRS:
            raise ValueError("Unsupported Forex pair.")
        c15, c1h = await asyncio.gather(
            self.market.candles(pair, "15min", 120),
            self.market.candles(pair, "1h", 120),
        )
        analysis = combine_analysis(pair, timeframe_signal(c15), timeframe_signal(c1h))
        analysis["updated_at"] = datetime.now(timezone.utc).isoformat()
        self.analyses[pair] = analysis
        self.prices[pair] = analysis["price"]
        return analysis

    async def scan_once(self):
        if not self.market.configured:
            raise RuntimeError("Forex AI data feed not configured.")

        results = await asyncio.gather(
            *(self.analyze_pair(pair) for pair in FOREX_PAIRS),
            return_exceptions=True,
        )
        ok = [x for x in results if not isinstance(x, Exception)]
        if not ok:
            errors = [str(x) for x in results if isinstance(x, Exception)]
            raise RuntimeError("Forex scan failed: " + " | ".join(errors[:2]))

        self.last_scan = datetime.now(timezone.utc).isoformat()
        self.last_error = None

        self.manage_orders()
        self.manage_positions()
        for user_id in db.list_forex_auto_user_ids():
            self.auto_entries(user_id)
        return ok

    def unrealized(self, user_id: int):
        total = 0.0
        for p in db.list_fx_positions(user_id):
            px = self.prices.get(p["pair"], p["entry"])
            total += pnl_usd(p["pair"], p["side"], p["entry"], px, p["qty_base"])
        return total

    def current_risk(self, user_id: int):
        return sum(float(p["risk_cash"]) for p in db.list_fx_positions(user_id))

    def _can_open(self, user_id: int, pair: str, risk_cash: float):
        positions = db.list_fx_positions(user_id)
        if len(positions) >= SETTINGS.forex_max_positions:
            return False, "Maximum Forex paper positions reached."
        if any(p["pair"] == pair for p in positions):
            return False, "That Forex pair already has an open position."
        account = db.get_account(user_id)
        basis = max(float(account["cash"]), 1.0)
        if self.current_risk(user_id) + risk_cash > basis * SETTINGS.forex_max_total_risk_pct:
            return False, "Forex portfolio risk cap reached."
        return True, ""

    def open_ai(self, user_id: int, analysis: dict):
        if analysis["confidence"] < SETTINGS.forex_auto_confidence:
            return {"ok": False, "error": "Analysis confidence is below the auto-entry threshold."}
        if not analysis["timeframe_agreement"]:
            return {"ok": False, "error": "15-minute and 1-hour trends do not agree."}

        account = db.get_account(user_id)
        equity_basis = max(float(account["cash"]), 1.0)
        risk_cash = equity_basis * SETTINGS.forex_risk_pct
        entry = float(analysis["price"])
        side = analysis["side"]
        distance = max(float(analysis["atr15"]) * 1.5, entry * 0.0008)

        if side == "LONG":
            stop = entry - distance
            target = entry + distance * SETTINGS.forex_reward_risk
        else:
            stop = entry + distance
            target = entry - distance * SETTINGS.forex_reward_risk

        if analysis["pair"].endswith("/JPY"):
            qty_base = risk_cash * entry / max(distance, 1e-9)
        else:
            qty_base = risk_cash / max(distance, 1e-9)
        lots = qty_base / 100_000

        allowed, error = self._can_open(user_id, analysis["pair"], risk_cash)
        if not allowed:
            return {"ok": False, "error": error}

        p = {
            "pair": analysis["pair"],
            "side": side,
            "entry": entry,
            "stop": stop,
            "target": target,
            "qty_base": qty_base,
            "lots": lots,
            "risk_cash": risk_cash,
            "source": "ai",
            "confidence": analysis["confidence"],
        }
        p["id"] = db.add_fx_position(user_id, p)
        return {"ok": True, "position": p}

    def open_manual_market(
        self, user_id: int, pair: str, side: str, lots: float,
        stop_pips: float, target_pips: float, entry: float, comment: str = "",
    ):
        side = side.upper()
        if side not in {"LONG", "SHORT"}:
            return {"ok": False, "error": "Side must be LONG or SHORT."}
        lots = max(0.01, min(float(lots), 50.0))
        qty_base = lots * 100_000
        pip = pip_size(pair)
        stop_dist = max(float(stop_pips), 1) * pip
        target_dist = max(float(target_pips), 1) * pip
        stop = entry - stop_dist if side == "LONG" else entry + stop_dist
        target = entry + target_dist if side == "LONG" else entry - target_dist
        risk_cash = risk_usd(pair, entry, stop, qty_base)

        allowed, error = self._can_open(user_id, pair, risk_cash)
        if not allowed:
            return {"ok": False, "error": error}

        p = {
            "pair": pair, "side": side, "entry": entry, "stop": stop, "target": target,
            "qty_base": qty_base, "lots": lots, "risk_cash": risk_cash,
            "source": "manual", "confidence": None,
        }
        p["id"] = db.add_fx_position(user_id, p)
        return {"ok": True, "position": p}

    def create_pending_order(
        self, user_id: int, pair: str, side: str, order_type: str,
        trigger_price: float, lots: float, stop_pips: float, target_pips: float, comment: str = "",
    ):
        side = side.upper()
        order_type = order_type.upper()
        if side not in {"LONG", "SHORT"}:
            return {"ok": False, "error": "Invalid side."}
        if order_type not in {"LIMIT", "STOP"}:
            return {"ok": False, "error": "Pending type must be LIMIT or STOP."}
        if trigger_price <= 0:
            return {"ok": False, "error": "A valid trigger price is required."}
        order = {
            "pair": pair, "side": side, "order_type": order_type,
            "trigger_price": trigger_price, "lots": max(0.01, min(float(lots), 50.0)),
            "stop_pips": max(float(stop_pips), 1),
            "target_pips": max(float(target_pips), 1),
            "comment": comment[:100],
        }
        order["id"] = db.add_fx_order(user_id, order)
        return {"ok": True, "order": order}

    def auto_entries(self, user_id: int):
        candidates = sorted(
            self.analyses.values(),
            key=lambda x: x["confidence"],
            reverse=True,
        )
        for a in candidates:
            if a["confidence"] < SETTINGS.forex_auto_confidence or not a["timeframe_agreement"]:
                continue
            self.open_ai(user_id, a)

    def manage_orders(self):
        for o in db.list_fx_orders(None):
            px = self.prices.get(o["pair"])
            if px is None:
                continue
            trigger = float(o["trigger_price"])
            should = False
            if o["order_type"] == "LIMIT":
                should = px <= trigger if o["side"] == "LONG" else px >= trigger
            elif o["order_type"] == "STOP":
                should = px >= trigger if o["side"] == "LONG" else px <= trigger
            if not should:
                continue
            result = self.open_manual_market(
                o["user_id"], o["pair"], o["side"], o["lots"],
                o["stop_pips"], o["target_pips"], trigger, o.get("comment") or "",
            )
            if result["ok"]:
                db.delete_fx_order(o["id"])

    def manage_positions(self):
        for p in db.list_fx_positions(None):
            px = self.prices.get(p["pair"])
            if px is None:
                continue
            if p["side"] == "LONG":
                if px <= p["stop"]:
                    self._close_at(p, p["stop"], "stop")
                elif px >= p["target"]:
                    self._close_at(p, p["target"], "target")
            else:
                if px >= p["stop"]:
                    self._close_at(p, p["stop"], "stop")
                elif px <= p["target"]:
                    self._close_at(p, p["target"], "target")

    def _close_at(self, p, exit_price, reason):
        gross = pnl_usd(p["pair"], p["side"], p["entry"], exit_price, p["qty_base"])
        fees = fees_usd(p["pair"], p["entry"], exit_price, p["qty_base"])
        db.close_fx_position(p["id"], exit_price, gross - fees, fees, reason)

    def close_position(self, user_id: int, position_id: int):
        p = next((x for x in db.list_fx_positions(user_id) if x["id"] == position_id), None)
        if not p:
            return {"ok": False, "error": "Forex position not found."}
        px = self.prices.get(p["pair"])
        if px is None:
            return {"ok": False, "error": "No current price cached. Run Forex analysis first."}
        gross = pnl_usd(p["pair"], p["side"], p["entry"], px, p["qty_base"])
        fees = fees_usd(p["pair"], p["entry"], px, p["qty_base"])
        pnl = gross - fees
        db.close_fx_position(p["id"], px, pnl, fees, "manual")
        return {"ok": True, "exit": px, "pnl": pnl}


FOREX_ENGINE = ForexEngine()

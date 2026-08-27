import asyncio
from datetime import datetime, timezone

from .config import SETTINGS
from . import db
from .market import MarketClient, is_meme


class LunaEngine:
    def __init__(self):
        self.market = MarketClient()
        self.opportunities = []
        self.last_scan = None
        self.last_error = None
        self.running = False
        self.task = None
        self.prices = {}

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
            await asyncio.sleep(SETTINGS.scan_interval_seconds)

    async def scan_once(self):
        data = await self.market.scan()
        self.opportunities = data
        self.last_scan = datetime.now(timezone.utc).isoformat()
        self.last_error = None
        self.prices = {(x["market"], x["symbol"]): x["price"] for x in data}

        self.manage_open_positions()
        for user_id in db.list_crypto_auto_user_ids():
            self.auto_entries(user_id)
        return data

    def crypto_unrealized(self, user_id: int):
        unrealized = 0.0
        for p in db.list_positions(user_id):
            price = self.prices.get((p["market"], p["symbol"]), p["entry"])
            direction = 1 if p["side"] == "LONG" else -1
            unrealized += (price - p["entry"]) * p["qty"] * direction
        return unrealized

    def account_snapshot(self, user_id: int):
        account = db.get_account(user_id)
        unrealized = self.crypto_unrealized(user_id)
        equity = account["cash"] + unrealized
        return {
            **account,
            "unrealized": unrealized,
            "equity": equity,
            "total_pnl": equity - account["starting_balance"],
        }

    def risk_for(self, opp):
        if opp["market"] == "perp":
            return SETTINGS.perp_risk_pct
        if opp.get("is_meme"):
            return SETTINGS.meme_risk_pct
        return SETTINGS.core_risk_pct

    def threshold_for(self, opp):
        if opp["market"] == "perp":
            return SETTINGS.perp_entry_score
        if opp.get("is_meme"):
            return SETTINGS.meme_entry_score
        return SETTINGS.core_entry_score

    def current_total_risk(self, user_id: int):
        return sum(p["risk_cash"] for p in db.list_positions(user_id))

    def open_position(self, user_id: int, opp, source="manual"):
        existing = db.list_positions(user_id)
        if len(existing) >= SETTINGS.max_positions:
            return {"ok": False, "error": "Maximum number of crypto paper positions reached."}

        if any(p["market"] == opp["market"] and p["symbol"] == opp["symbol"] for p in existing):
            return {"ok": False, "error": "That market already has an open paper position."}

        account = self.account_snapshot(user_id)
        risk_pct = self.risk_for(opp)
        risk_cash = account["equity"] * risk_pct

        if self.current_total_risk(user_id) + risk_cash > account["equity"] * SETTINGS.max_total_risk_pct:
            return {"ok": False, "error": "Crypto portfolio risk cap reached."}

        entry = float(opp["price"])
        atr = max(float(opp["atr"]), entry * 0.004)
        stop_mult = 2.0 if (opp["market"] == "perp" or opp.get("is_meme")) else 1.5
        distance = max(atr * stop_mult, entry * (0.012 if opp.get("is_meme") else 0.006))
        side = opp["side"]

        if side == "LONG":
            stop = entry - distance
            target = entry + distance * SETTINGS.reward_risk
        else:
            stop = entry + distance
            target = entry - distance * SETTINGS.reward_risk

        qty = risk_cash / distance
        leverage = 1.0

        p = {
            "market": opp["market"],
            "symbol": opp["symbol"],
            "asset": opp["asset"],
            "side": side,
            "entry": entry,
            "stop": stop,
            "target": target,
            "qty": qty,
            "risk_cash": risk_cash,
            "leverage": leverage,
            "score": opp["score"],
            "reason": f'{source}: ' + ", ".join(opp.get("reasons", [])),
        }
        p["id"] = db.add_position(user_id, p)
        return {"ok": True, "position": p}

    def close_position(self, user_id: int, position_id: int, reason="manual"):
        positions = db.list_positions(user_id)
        p = next((x for x in positions if x["id"] == position_id), None)
        if not p:
            return {"ok": False, "error": "Position not found."}

        price = self.prices.get((p["market"], p["symbol"]))
        if price is None:
            return {"ok": False, "error": "No current market price for this position."}

        direction = 1 if p["side"] == "LONG" else -1
        gross = (price - p["entry"]) * p["qty"] * direction
        fee_rate = SETTINGS.perp_fee_rate if p["market"] == "perp" else SETTINGS.spot_fee_rate
        fees = (p["entry"] + price) * p["qty"] * fee_rate
        pnl = gross - fees
        db.close_position(position_id, price, pnl, fees, reason)
        return {"ok": True, "pnl": pnl, "exit": price}

    def manage_open_positions(self):
        for p in db.list_positions(None):
            price = self.prices.get((p["market"], p["symbol"]))
            if price is None:
                continue

            if p["side"] == "LONG":
                if price <= p["stop"]:
                    self._close_at(p, p["stop"], "stop")
                elif price >= p["target"]:
                    self._close_at(p, p["target"], "target")
            else:
                if price >= p["stop"]:
                    self._close_at(p, p["stop"], "stop")
                elif price <= p["target"]:
                    self._close_at(p, p["target"], "target")

    def _close_at(self, p, exit_price, reason):
        direction = 1 if p["side"] == "LONG" else -1
        gross = (exit_price - p["entry"]) * p["qty"] * direction
        fee_rate = SETTINGS.perp_fee_rate if p["market"] == "perp" else SETTINGS.spot_fee_rate
        fees = (p["entry"] + exit_price) * p["qty"] * fee_rate
        pnl = gross - fees
        db.close_position(p["id"], exit_price, pnl, fees, reason)

    def auto_entries(self, user_id: int):
        for opp in self.opportunities:
            if len(db.list_positions(user_id)) >= SETTINGS.max_positions:
                break
            if opp["score"] < self.threshold_for(opp):
                continue
            result = self.open_position(user_id, opp, source="auto")
            if not result["ok"] and "risk cap" in result.get("error", "").lower():
                break


ENGINE = LunaEngine()

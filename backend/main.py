from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import SETTINGS
from . import db
from .engine import ENGINE

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"

class AutoBody(BaseModel):
    enabled: bool

class OpenBody(BaseModel):
    market: str
    symbol: str

@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db(SETTINGS.starting_balance)
    await ENGINE.start()
    yield
    await ENGINE.stop()

app = FastAPI(title="Luna Pulse V3", version="3.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")

@app.get("/")
def home():
    return FileResponse(STATIC / "index.html")

@app.get("/manifest.json")
def manifest():
    return FileResponse(STATIC / "manifest.json")

@app.get("/sw.js")
def service_worker():
    return FileResponse(STATIC / "sw.js", media_type="application/javascript")

@app.get("/api/status")
def status():
    positions = db.list_positions()
    trades = db.list_trades(200)
    snap = ENGINE.account_snapshot()
    wins = [t for t in trades if t["pnl"] > 0]
    losses = [t for t in trades if t["pnl"] <= 0]
    return {
        "account": snap,
        "positions": positions,
        "trade_count": len(trades),
        "win_rate": (len(wins) / len(trades) * 100) if trades else 0,
        "wins": len(wins),
        "losses": len(losses),
        "last_scan": ENGINE.last_scan,
        "last_error": ENGINE.last_error,
        "auto_enabled": bool(snap["auto_enabled"]),
        "max_positions": SETTINGS.max_positions,
        "max_total_risk_pct": SETTINGS.max_total_risk_pct,
    }

@app.get("/api/opportunities")
def opportunities(limit: int = 30, market: str = "all"):
    data = ENGINE.opportunities
    if market in {"spot", "perp"}:
        data = [x for x in data if x["market"] == market]
    return {"items": data[:max(1, min(limit, 100))], "last_scan": ENGINE.last_scan}

@app.get("/api/positions")
def positions():
    enriched = []
    for p in db.list_positions():
        x = dict(p)
        price = ENGINE.prices.get((p["market"], p["symbol"]), p["entry"])
        direction = 1 if p["side"] == "LONG" else -1
        x["current_price"] = price
        x["unrealized"] = (price - p["entry"]) * p["qty"] * direction
        enriched.append(x)
    return {"items": enriched}

@app.get("/api/trades")
def trades(limit: int = 100):
    return {"items": db.list_trades(max(1, min(limit, 500)))}

@app.post("/api/scan")
async def scan_now():
    data = await ENGINE.scan_once()
    return {"ok": True, "count": len(data), "last_scan": ENGINE.last_scan}

@app.post("/api/auto")
def set_auto(body: AutoBody):
    db.set_auto(body.enabled)
    return {"ok": True, "enabled": body.enabled}

@app.post("/api/paper/open")
def open_paper(body: OpenBody):
    opp = next(
        (x for x in ENGINE.opportunities if x["market"] == body.market and x["symbol"] == body.symbol),
        None
    )
    if not opp:
        raise HTTPException(404, "Opportunity is not in the current scanner set.")
    result = ENGINE.open_position(opp, source="manual")
    if not result["ok"]:
        raise HTTPException(400, result["error"])
    return result

@app.post("/api/paper/close/{position_id}")
def close_paper(position_id: int):
    result = ENGINE.close_position(position_id, reason="manual")
    if not result["ok"]:
        raise HTTPException(400, result["error"])
    return result

@app.post("/api/reset")
def reset():
    db.reset_account(SETTINGS.starting_balance)
    return {"ok": True}

@app.get("/api/config")
def config():
    return {
        "scan_interval_seconds": SETTINGS.scan_interval_seconds,
        "spot_universe_size": SETTINGS.spot_universe_size,
        "perp_universe_size": SETTINGS.perp_universe_size,
        "max_positions": SETTINGS.max_positions,
        "max_total_risk_pct": SETTINGS.max_total_risk_pct,
        "core_risk_pct": SETTINGS.core_risk_pct,
        "meme_risk_pct": SETTINGS.meme_risk_pct,
        "perp_risk_pct": SETTINGS.perp_risk_pct,
        "core_entry_score": SETTINGS.core_entry_score,
        "meme_entry_score": SETTINGS.meme_entry_score,
        "perp_entry_score": SETTINGS.perp_entry_score,
        "real_money_enabled": False,
    }

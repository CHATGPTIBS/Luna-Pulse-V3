from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import SETTINGS, FOREX_PAIRS, TRADINGVIEW_FOREX
from . import db, auth
from .engine import ENGINE
from .forex import FOREX_ENGINE, pnl_usd
from .meme_bot import MEME_BOT

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"


class LoginBody(BaseModel):
    username: str
    password: str


class CreateUserBody(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    display_name: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=10, max_length=128)


class AutoBody(BaseModel):
    enabled: bool


class OpenBody(BaseModel):
    market: str
    symbol: str


class MemeOpenBody(BaseModel):
    token_address: str


class ForexAnalyzeBody(BaseModel):
    pair: str


class ForexOrderBody(BaseModel):
    pair: str
    side: str
    order_type: str = "MARKET"
    lots: float = Field(gt=0, le=50)
    stop_pips: float = Field(gt=0, le=1000)
    target_pips: float = Field(gt=0, le=3000)
    trigger_price: float | None = None
    comment: str = Field(default="", max_length=100)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db(SETTINGS.starting_balance)
    auth.bootstrap_admin()
    await ENGINE.start()
    await FOREX_ENGINE.start()
    await MEME_BOT.start()
    yield
    await ENGINE.stop()
    await FOREX_ENGINE.stop()
    await MEME_BOT.stop()


app = FastAPI(title="Luna Pulse V3.3", version="3.3", lifespan=lifespan)
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


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "version": "3.3",
        "crypto_feed": "online" if not ENGINE.last_error else "warning",
        "forex_configured": FOREX_ENGINE.market.configured,
        "meme_feed": "online" if not MEME_BOT.last_error else "warning",
    }


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

@app.post("/api/auth/login")
def login(body: LoginBody, response: Response):
    return {"ok": True, "user": auth.login(response, body.username, body.password)}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response):
    auth.logout(request, response)
    return {"ok": True}


@app.get("/api/auth/me")
def me(user=Depends(auth.current_user)):
    return {"user": user}


@app.get("/api/admin/users")
def admin_users(user=Depends(auth.admin_user)):
    return {"items": db.list_users()}


@app.post("/api/admin/users")
def admin_create_user(body: CreateUserBody, user=Depends(auth.admin_user)):
    username = body.username.strip()
    if not username.replace("_", "").replace("-", "").isalnum():
        raise HTTPException(400, "Username may contain letters, numbers, hyphens and underscores.")
    if db.get_user_by_username(username):
        raise HTTPException(400, "Username already exists.")
    try:
        password_hash, salt = auth.make_password(body.password)
    except ValueError as e:
        raise HTTPException(400, str(e))
    created = db.create_user(
        username=username,
        display_name=body.display_name.strip(),
        password_hash=password_hash,
        salt=salt,
        role="user",
        starting_balance=SETTINGS.starting_balance,
    )
    return {"ok": True, "user": created}


# ---------------------------------------------------------------------------
# Dashboard / shared account
# ---------------------------------------------------------------------------

@app.get("/api/status")
def status(user=Depends(auth.current_user)):
    uid = user["id"]
    crypto_positions = db.list_positions(uid)
    crypto_trades = db.list_trades(uid, 500)
    fx_positions = db.list_fx_positions(uid)
    fx_trades = db.list_fx_trades(uid, 500)
    meme_positions = db.list_meme_positions(uid)
    meme_trades = db.list_meme_trades(uid, 500)

    account = db.get_account(uid)
    crypto_unrealized = ENGINE.crypto_unrealized(uid)
    forex_unrealized = FOREX_ENGINE.unrealized(uid)
    meme_unrealized = MEME_BOT.unrealized(uid)
    equity = account["cash"] + crypto_unrealized + forex_unrealized + meme_unrealized

    closed = crypto_trades + fx_trades + meme_trades
    wins = [t for t in closed if float(t["pnl"]) > 0]
    losses = [t for t in closed if float(t["pnl"]) <= 0]

    return {
        "user": user,
        "account": {
            **account,
            "crypto_unrealized": crypto_unrealized,
            "forex_unrealized": forex_unrealized,
            "meme_unrealized": meme_unrealized,
            "unrealized": crypto_unrealized + forex_unrealized + meme_unrealized,
            "equity": equity,
            "total_pnl": equity - account["starting_balance"],
        },
        "crypto_positions": len(crypto_positions),
        "forex_positions": len(fx_positions),
        "meme_positions": len(meme_positions),
        "trade_count": len(closed),
        "win_rate": (len(wins) / len(closed) * 100) if closed else 0,
        "wins": len(wins),
        "losses": len(losses),
        "crypto_last_scan": ENGINE.last_scan,
        "crypto_last_error": ENGINE.last_error,
        "forex_last_scan": FOREX_ENGINE.last_scan,
        "forex_last_error": FOREX_ENGINE.last_error,
        "meme_last_scan": MEME_BOT.last_scan,
        "meme_last_error": MEME_BOT.last_error,
        "crypto_auto_enabled": bool(account["crypto_auto_enabled"]),
        "forex_auto_enabled": bool(account["forex_auto_enabled"]),
        "meme_auto_enabled": bool(account.get("meme_auto_enabled", 0)),
        "forex_configured": FOREX_ENGINE.market.configured,
        "max_crypto_positions": SETTINGS.max_positions,
        "max_forex_positions": SETTINGS.forex_max_positions,
        "max_meme_positions": SETTINGS.meme_bot_max_positions,
    }


# ---------------------------------------------------------------------------
# Crypto
# ---------------------------------------------------------------------------

@app.get("/api/opportunities")
def opportunities(
    limit: int = 30,
    market: str = "all",
    meme: bool | None = None,
    user=Depends(auth.current_user),
):
    data = ENGINE.opportunities
    if market in {"spot", "perp"}:
        data = [x for x in data if x["market"] == market]
    if meme is True:
        data = [x for x in data if x.get("is_meme")]
    elif meme is False:
        data = [x for x in data if not x.get("is_meme")]
    return {"items": data[:max(1, min(limit, 100))], "last_scan": ENGINE.last_scan}


@app.get("/api/crypto/analysis")
def crypto_analysis(market: str, symbol: str, user=Depends(auth.current_user)):
    opp = next(
        (x for x in ENGINE.opportunities if x["market"] == market and x["symbol"] == symbol),
        None,
    )
    if not opp:
        raise HTTPException(404, "That symbol is not in the current Luna scanner set.")
    return {"analysis": opp}


@app.get("/api/positions")
def positions(user=Depends(auth.current_user)):
    enriched = []
    for p in db.list_positions(user["id"]):
        x = dict(p)
        price = ENGINE.prices.get((p["market"], p["symbol"]), p["entry"])
        direction = 1 if p["side"] == "LONG" else -1
        x["current_price"] = price
        x["unrealized"] = (price - p["entry"]) * p["qty"] * direction
        enriched.append(x)
    return {"items": enriched}


@app.get("/api/trades")
def trades(limit: int = 100, user=Depends(auth.current_user)):
    return {"items": db.list_trades(user["id"], max(1, min(limit, 500)))}


@app.post("/api/scan")
async def scan_now(user=Depends(auth.current_user)):
    data = await ENGINE.scan_once()
    return {"ok": True, "count": len(data), "last_scan": ENGINE.last_scan}


@app.post("/api/auto")
def set_auto(body: AutoBody, user=Depends(auth.current_user)):
    db.set_crypto_auto(user["id"], body.enabled)
    return {"ok": True, "enabled": body.enabled}


@app.post("/api/paper/open")
def open_paper(body: OpenBody, user=Depends(auth.current_user)):
    opp = next(
        (x for x in ENGINE.opportunities if x["market"] == body.market and x["symbol"] == body.symbol),
        None,
    )
    if not opp:
        raise HTTPException(404, "Opportunity is not in the current scanner set.")
    result = ENGINE.open_position(user["id"], opp, source="manual")
    if not result["ok"]:
        raise HTTPException(400, result["error"])
    return result


@app.post("/api/paper/close/{position_id}")
def close_paper(position_id: int, user=Depends(auth.current_user)):
    result = ENGINE.close_position(user["id"], position_id, reason="manual")
    if not result["ok"]:
        raise HTTPException(400, result["error"])
    return result




# ---------------------------------------------------------------------------
# Luna Meme Bot — Solana / DexScreener paper trading
# ---------------------------------------------------------------------------

@app.get("/api/meme/status")
def meme_status(user=Depends(auth.current_user)):
    positions = []
    for p in db.list_meme_positions(user["id"]):
        x = dict(p)
        price = MEME_BOT.prices.get(p["token_address"], p["entry"])
        x["current_price"] = price
        x["unrealized"] = (price - p["entry"]) * p["qty"]
        positions.append(x)
    return {
        "items": MEME_BOT.opportunities,
        "positions": positions,
        "auto_enabled": bool(db.get_account(user["id"]).get("meme_auto_enabled", 0)),
        "last_scan": MEME_BOT.last_scan,
        "last_error": MEME_BOT.last_error,
        "entry_score": SETTINGS.meme_bot_entry_score,
        "max_positions": SETTINGS.meme_bot_max_positions,
        "risk_pct": SETTINGS.meme_bot_risk_pct,
        "real_money_enabled": False,
        "provider": "DexScreener",
        "chain": "Solana",
    }


@app.get("/api/meme/trending")
def meme_trending(limit: int = 30, user=Depends(auth.current_user)):
    return {
        "items": MEME_BOT.opportunities[:max(1, min(limit, 100))],
        "last_scan": MEME_BOT.last_scan,
    }


@app.post("/api/meme/scan")
async def meme_scan(user=Depends(auth.current_user)):
    try:
        rows = await MEME_BOT.scan_once()
        return {"ok": True, "count": len(rows), "items": rows, "last_scan": MEME_BOT.last_scan}
    except Exception as e:
        raise HTTPException(503, str(e))


@app.post("/api/meme/auto")
def meme_auto(body: AutoBody, user=Depends(auth.current_user)):
    db.set_meme_auto(user["id"], body.enabled)
    return {"ok": True, "enabled": body.enabled}


@app.post("/api/meme/paper/open")
def meme_open(body: MemeOpenBody, user=Depends(auth.current_user)):
    opp = next((x for x in MEME_BOT.opportunities if x["token_address"] == body.token_address), None)
    if not opp:
        raise HTTPException(404, "That token is not in the current Luna Meme Bot candidate set.")
    result = MEME_BOT.open_position(user["id"], opp, source="manual")
    if not result["ok"]:
        raise HTTPException(400, result["error"])
    return result


@app.post("/api/meme/positions/{position_id}/close")
def meme_close(position_id: int, user=Depends(auth.current_user)):
    result = MEME_BOT.close_position(user["id"], position_id, reason="manual")
    if not result["ok"]:
        raise HTTPException(400, result["error"])
    return result


@app.get("/api/meme/trades")
def meme_trades(limit: int = 100, user=Depends(auth.current_user)):
    return {"items": db.list_meme_trades(user["id"], max(1, min(limit, 500)))}


# ---------------------------------------------------------------------------
# Forex AI / MT4-style paper order panel
# ---------------------------------------------------------------------------

@app.get("/api/forex/status")
def forex_status(user=Depends(auth.current_user)):
    positions = []
    for p in db.list_fx_positions(user["id"]):
        x = dict(p)
        price = FOREX_ENGINE.prices.get(p["pair"], p["entry"])
        x["current_price"] = price
        x["unrealized"] = pnl_usd(p["pair"], p["side"], p["entry"], price, p["qty_base"])
        positions.append(x)
    return {
        "configured": FOREX_ENGINE.market.configured,
        "pairs": list(FOREX_PAIRS),
        "tradingview": TRADINGVIEW_FOREX,
        "analyses": FOREX_ENGINE.analyses,
        "positions": positions,
        "orders": db.list_fx_orders(user["id"]),
        "auto_enabled": bool(db.get_account(user["id"])["forex_auto_enabled"]),
        "last_scan": FOREX_ENGINE.last_scan,
        "last_error": FOREX_ENGINE.last_error,
        "auto_confidence": SETTINGS.forex_auto_confidence,
    }


@app.post("/api/forex/analyze")
async def forex_analyze(body: ForexAnalyzeBody, user=Depends(auth.current_user)):
    pair = body.pair.upper()
    if pair not in FOREX_PAIRS:
        raise HTTPException(400, "Unsupported Forex pair.")
    try:
        a = await FOREX_ENGINE.analyze_pair(pair)
        return {"ok": True, "analysis": a}
    except Exception as e:
        raise HTTPException(503, str(e))


@app.post("/api/forex/scan")
async def forex_scan(user=Depends(auth.current_user)):
    try:
        rows = await FOREX_ENGINE.scan_once()
        return {"ok": True, "items": rows, "last_scan": FOREX_ENGINE.last_scan}
    except Exception as e:
        raise HTTPException(503, str(e))


@app.post("/api/forex/auto")
def forex_auto(body: AutoBody, user=Depends(auth.current_user)):
    if body.enabled and not FOREX_ENGINE.market.configured:
        raise HTTPException(400, "Add TWELVE_DATA_API_KEY before enabling Forex AI auto paper trading.")
    db.set_forex_auto(user["id"], body.enabled)
    return {"ok": True, "enabled": body.enabled}


@app.post("/api/forex/ai/open")
async def forex_ai_open(body: ForexAnalyzeBody, user=Depends(auth.current_user)):
    pair = body.pair.upper()
    if pair not in FOREX_PAIRS:
        raise HTTPException(400, "Unsupported Forex pair.")
    try:
        analysis = await FOREX_ENGINE.analyze_pair(pair)
    except Exception as e:
        raise HTTPException(503, str(e))
    result = FOREX_ENGINE.open_ai(user["id"], analysis)
    if not result["ok"]:
        raise HTTPException(400, result["error"])
    return result


@app.post("/api/forex/order")
async def forex_order(body: ForexOrderBody, user=Depends(auth.current_user)):
    pair = body.pair.upper()
    side = body.side.upper()
    order_type = body.order_type.upper()
    if pair not in FOREX_PAIRS:
        raise HTTPException(400, "Unsupported Forex pair.")
    if side in {"BUY", "LONG"}:
        side = "LONG"
    elif side in {"SELL", "SHORT"}:
        side = "SHORT"
    else:
        raise HTTPException(400, "Side must be BUY or SELL.")

    if order_type == "MARKET":
        try:
            analysis = await FOREX_ENGINE.analyze_pair(pair)
        except Exception as e:
            raise HTTPException(503, str(e))
        result = FOREX_ENGINE.open_manual_market(
            user["id"], pair, side, body.lots, body.stop_pips,
            body.target_pips, analysis["price"], body.comment,
        )
    elif order_type in {"LIMIT", "STOP"}:
        if body.trigger_price is None:
            raise HTTPException(400, "Pending orders require an entry/trigger price.")
        result = FOREX_ENGINE.create_pending_order(
            user["id"], pair, side, order_type, body.trigger_price,
            body.lots, body.stop_pips, body.target_pips, body.comment,
        )
    else:
        raise HTTPException(400, "Order type must be MARKET, LIMIT or STOP.")

    if not result["ok"]:
        raise HTTPException(400, result["error"])
    return result


@app.get("/api/forex/trades")
def forex_trades(limit: int = 100, user=Depends(auth.current_user)):
    return {"items": db.list_fx_trades(user["id"], max(1, min(limit, 500)))}


@app.post("/api/forex/positions/{position_id}/close")
def forex_close(position_id: int, user=Depends(auth.current_user)):
    result = FOREX_ENGINE.close_position(user["id"], position_id)
    if not result["ok"]:
        raise HTTPException(400, result["error"])
    return result


# ---------------------------------------------------------------------------
# Account reset / config
# ---------------------------------------------------------------------------

@app.post("/api/reset")
def reset(user=Depends(auth.current_user)):
    db.reset_user_account(user["id"], SETTINGS.starting_balance)
    return {"ok": True}


@app.get("/api/config")
def config(user=Depends(auth.current_user)):
    return {
        "version": "3.3",
        "scan_interval_seconds": SETTINGS.scan_interval_seconds,
        "forex_scan_interval_seconds": SETTINGS.forex_scan_interval_seconds,
        "spot_universe_size": SETTINGS.spot_universe_size,
        "perp_universe_size": SETTINGS.perp_universe_size,
        "max_positions": SETTINGS.max_positions,
        "max_total_risk_pct": SETTINGS.max_total_risk_pct,
        "forex_auto_confidence": SETTINGS.forex_auto_confidence,
        "forex_pairs": list(FOREX_PAIRS),
        "meme_bot_scan_seconds": SETTINGS.meme_bot_scan_seconds,
        "meme_bot_entry_score": SETTINGS.meme_bot_entry_score,
        "meme_bot_max_positions": SETTINGS.meme_bot_max_positions,
        "meme_bot_risk_pct": SETTINGS.meme_bot_risk_pct,
        "meme_bot_provider": "DexScreener / Solana",
        "real_money_enabled": False,
        "account_creation": "admin_only",
    }

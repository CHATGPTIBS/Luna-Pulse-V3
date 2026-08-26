import sqlite3
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent.parent / "luna_v3.sqlite3"

def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

def init_db(starting_balance: float):
    with connect() as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS account (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            starting_balance REAL NOT NULL,
            cash REAL NOT NULL,
            auto_enabled INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            market TEXT NOT NULL,
            symbol TEXT NOT NULL,
            asset TEXT NOT NULL,
            side TEXT NOT NULL,
            entry REAL NOT NULL,
            stop REAL NOT NULL,
            target REAL NOT NULL,
            qty REAL NOT NULL,
            risk_cash REAL NOT NULL,
            leverage REAL NOT NULL DEFAULT 1,
            score REAL NOT NULL,
            reason TEXT,
            opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            market TEXT NOT NULL,
            symbol TEXT NOT NULL,
            asset TEXT NOT NULL,
            side TEXT NOT NULL,
            entry REAL NOT NULL,
            exit REAL NOT NULL,
            qty REAL NOT NULL,
            pnl REAL NOT NULL,
            fees REAL NOT NULL,
            reason TEXT,
            entry_score REAL,
            opened_at TEXT,
            closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """)
        row = con.execute("SELECT id FROM account WHERE id=1").fetchone()
        if not row:
            con.execute(
                "INSERT INTO account(id, starting_balance, cash, auto_enabled) VALUES(1, ?, ?, 0)",
                (starting_balance, starting_balance)
            )

def get_account() -> dict[str, Any]:
    with connect() as con:
        return dict(con.execute("SELECT * FROM account WHERE id=1").fetchone())

def set_auto(enabled: bool):
    with connect() as con:
        con.execute(
            "UPDATE account SET auto_enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=1",
            (1 if enabled else 0,)
        )

def reset_account(starting_balance: float):
    with connect() as con:
        con.execute("DELETE FROM positions")
        con.execute("DELETE FROM trades")
        con.execute(
            "UPDATE account SET starting_balance=?, cash=?, auto_enabled=0, updated_at=CURRENT_TIMESTAMP WHERE id=1",
            (starting_balance, starting_balance)
        )

def list_positions() -> list[dict]:
    with connect() as con:
        rows = con.execute("SELECT * FROM positions ORDER BY opened_at DESC").fetchall()
        return [dict(r) for r in rows]

def add_position(p: dict):
    with connect() as con:
        cur = con.execute("""
        INSERT INTO positions(
            market,symbol,asset,side,entry,stop,target,qty,risk_cash,leverage,score,reason
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            p["market"], p["symbol"], p["asset"], p["side"], p["entry"], p["stop"],
            p["target"], p["qty"], p["risk_cash"], p.get("leverage", 1.0),
            p["score"], p.get("reason", "")
        ))
        return cur.lastrowid

def close_position(position_id: int, exit_price: float, pnl: float, fees: float, reason: str):
    with connect() as con:
        p = con.execute("SELECT * FROM positions WHERE id=?", (position_id,)).fetchone()
        if not p:
            return False
        p = dict(p)
        con.execute("""
        INSERT INTO trades(
            market,symbol,asset,side,entry,exit,qty,pnl,fees,reason,entry_score,opened_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            p["market"], p["symbol"], p["asset"], p["side"], p["entry"], exit_price,
            p["qty"], pnl, fees, reason, p["score"], p["opened_at"]
        ))
        con.execute("DELETE FROM positions WHERE id=?", (position_id,))
        con.execute(
            "UPDATE account SET cash=cash+?, updated_at=CURRENT_TIMESTAMP WHERE id=1",
            (pnl,)
        )
        return True

def list_trades(limit: int = 200) -> list[dict]:
    with connect() as con:
        rows = con.execute(
            "SELECT * FROM trades ORDER BY closed_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

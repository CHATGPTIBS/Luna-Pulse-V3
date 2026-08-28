import sqlite3
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent.parent / "luna_v3.sqlite3"


def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con


def _has_column(con, table: str, column: str) -> bool:
    return any(r["name"] == column for r in con.execute(f"PRAGMA table_info({table})").fetchall())


def _setting(con, key: str):
    row = con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def _set_setting(con, key: str, value: str):
    con.execute(
        "INSERT INTO settings(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )


def init_db(starting_balance: float):
    with connect() as con:
        # Legacy V3 tables are kept so an existing live database can migrate
        # without deleting the user's paper history.
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

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS user_accounts (
            user_id INTEGER PRIMARY KEY,
            starting_balance REAL NOT NULL,
            cash REAL NOT NULL,
            crypto_auto_enabled INTEGER NOT NULL DEFAULT 0,
            forex_auto_enabled INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS fx_positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            pair TEXT NOT NULL,
            side TEXT NOT NULL,
            entry REAL NOT NULL,
            stop REAL NOT NULL,
            target REAL NOT NULL,
            qty_base REAL NOT NULL,
            lots REAL NOT NULL,
            risk_cash REAL NOT NULL,
            source TEXT NOT NULL,
            confidence REAL,
            opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS fx_trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            pair TEXT NOT NULL,
            side TEXT NOT NULL,
            entry REAL NOT NULL,
            exit REAL NOT NULL,
            qty_base REAL NOT NULL,
            lots REAL NOT NULL,
            pnl REAL NOT NULL,
            fees REAL NOT NULL,
            reason TEXT,
            source TEXT,
            confidence REAL,
            opened_at TEXT,
            closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS fx_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            pair TEXT NOT NULL,
            side TEXT NOT NULL,
            order_type TEXT NOT NULL,
            trigger_price REAL NOT NULL,
            lots REAL NOT NULL,
            stop_pips REAL NOT NULL,
            target_pips REAL NOT NULL,
            comment TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        """)

        # Add ownership to existing V3 crypto tables in-place.
        if not _has_column(con, "positions", "user_id"):
            con.execute("ALTER TABLE positions ADD COLUMN user_id INTEGER")
        if not _has_column(con, "trades", "user_id"):
            con.execute("ALTER TABLE trades ADD COLUMN user_id INTEGER")

        row = con.execute("SELECT id FROM account WHERE id=1").fetchone()
        if not row:
            con.execute(
                "INSERT INTO account(id,starting_balance,cash,auto_enabled) VALUES(1,?,?,0)",
                (starting_balance, starting_balance),
            )

        # Clear expired sessions during startup.
        con.execute("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP")


# ---------------------------------------------------------------------------
# Users / sessions
# ---------------------------------------------------------------------------

def user_count() -> int:
    with connect() as con:
        return int(con.execute("SELECT COUNT(*) n FROM users").fetchone()["n"])


def create_user(
    username: str,
    display_name: str,
    password_hash: str,
    salt: str,
    role: str = "user",
    starting_balance: float = 10_000.0,
) -> dict[str, Any]:
    with connect() as con:
        cur = con.execute(
            "INSERT INTO users(username,display_name,password_hash,salt,role) VALUES(?,?,?,?,?)",
            (username, display_name, password_hash, salt, role),
        )
        user_id = cur.lastrowid
        con.execute(
            "INSERT INTO user_accounts(user_id,starting_balance,cash) VALUES(?,?,?)",
            (user_id, starting_balance, starting_balance),
        )
        return dict(con.execute(
            "SELECT id,username,display_name,role,active,created_at FROM users WHERE id=?",
            (user_id,),
        ).fetchone())


def get_user_by_username(username: str):
    with connect() as con:
        row = con.execute("SELECT * FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone()
        return dict(row) if row else None


def get_user(user_id: int):
    with connect() as con:
        row = con.execute(
            "SELECT id,username,display_name,role,active,created_at FROM users WHERE id=?",
            (user_id,),
        ).fetchone()
        return dict(row) if row else None


def list_users():
    with connect() as con:
        return [dict(r) for r in con.execute(
            "SELECT id,username,display_name,role,active,created_at FROM users ORDER BY created_at ASC"
        ).fetchall()]


def set_user_active(user_id: int, active: bool):
    with connect() as con:
        con.execute("UPDATE users SET active=? WHERE id=?", (1 if active else 0, user_id))
        if not active:
            con.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))


def create_session(user_id: int, token_hash: str, expires_at: str):
    with connect() as con:
        con.execute(
            "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,?)",
            (user_id, token_hash, expires_at),
        )


def get_session_user(token_hash: str):
    with connect() as con:
        row = con.execute("""
            SELECT u.id,u.username,u.display_name,u.role,u.active,u.created_at
            FROM sessions s
            JOIN users u ON u.id=s.user_id
            WHERE s.token_hash=? AND s.expires_at > CURRENT_TIMESTAMP AND u.active=1
        """, (token_hash,)).fetchone()
        return dict(row) if row else None


def delete_session(token_hash: str):
    with connect() as con:
        con.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))


def migrate_legacy_to_admin(admin_user_id: int, starting_balance: float):
    """Import an existing V3 single-account database into the admin's V3.3 account once."""
    with connect() as con:
        if _setting(con, "v33_legacy_migrated") == "1":
            return

        legacy = con.execute("SELECT * FROM account WHERE id=1").fetchone()
        if legacy:
            legacy = dict(legacy)
            con.execute(
                """INSERT INTO user_accounts(user_id,starting_balance,cash,crypto_auto_enabled,forex_auto_enabled)
                   VALUES(?,?,?,?,0)
                   ON CONFLICT(user_id) DO UPDATE SET
                     starting_balance=excluded.starting_balance,
                     cash=excluded.cash,
                     crypto_auto_enabled=excluded.crypto_auto_enabled""",
                (
                    admin_user_id,
                    float(legacy.get("starting_balance") or starting_balance),
                    float(legacy.get("cash") or starting_balance),
                    int(legacy.get("auto_enabled") or 0),
                ),
            )
        else:
            con.execute(
                "INSERT OR IGNORE INTO user_accounts(user_id,starting_balance,cash) VALUES(?,?,?)",
                (admin_user_id, starting_balance, starting_balance),
            )

        con.execute("UPDATE positions SET user_id=? WHERE user_id IS NULL", (admin_user_id,))
        con.execute("UPDATE trades SET user_id=? WHERE user_id IS NULL", (admin_user_id,))
        _set_setting(con, "v33_legacy_migrated", "1")


# ---------------------------------------------------------------------------
# Shared user paper account
# ---------------------------------------------------------------------------

def get_account(user_id: int) -> dict[str, Any]:
    with connect() as con:
        row = con.execute("SELECT * FROM user_accounts WHERE user_id=?", (user_id,)).fetchone()
        if not row:
            raise KeyError("Paper account not found")
        return dict(row)


def adjust_cash(user_id: int, pnl: float):
    with connect() as con:
        con.execute(
            "UPDATE user_accounts SET cash=cash+?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?",
            (pnl, user_id),
        )


def set_crypto_auto(user_id: int, enabled: bool):
    with connect() as con:
        con.execute(
            "UPDATE user_accounts SET crypto_auto_enabled=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?",
            (1 if enabled else 0, user_id),
        )


def set_forex_auto(user_id: int, enabled: bool):
    with connect() as con:
        con.execute(
            "UPDATE user_accounts SET forex_auto_enabled=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?",
            (1 if enabled else 0, user_id),
        )


def list_crypto_auto_user_ids() -> list[int]:
    with connect() as con:
        return [int(r["user_id"]) for r in con.execute(
            "SELECT user_id FROM user_accounts WHERE crypto_auto_enabled=1"
        ).fetchall()]


def list_forex_auto_user_ids() -> list[int]:
    with connect() as con:
        return [int(r["user_id"]) for r in con.execute(
            "SELECT user_id FROM user_accounts WHERE forex_auto_enabled=1"
        ).fetchall()]


# ---------------------------------------------------------------------------
# Crypto positions / trades
# ---------------------------------------------------------------------------

def list_positions(user_id: int | None = None) -> list[dict]:
    with connect() as con:
        if user_id is None:
            rows = con.execute(
                "SELECT * FROM positions WHERE user_id IS NOT NULL ORDER BY opened_at DESC"
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM positions WHERE user_id=? ORDER BY opened_at DESC", (user_id,)
            ).fetchall()
        return [dict(r) for r in rows]


def add_position(user_id: int, p: dict):
    with connect() as con:
        cur = con.execute("""
        INSERT INTO positions(
            market,symbol,asset,side,entry,stop,target,qty,risk_cash,leverage,score,reason,user_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            p["market"], p["symbol"], p["asset"], p["side"], p["entry"], p["stop"],
            p["target"], p["qty"], p["risk_cash"], p.get("leverage", 1.0),
            p["score"], p.get("reason", ""), user_id,
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
            market,symbol,asset,side,entry,exit,qty,pnl,fees,reason,entry_score,opened_at,user_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            p["market"], p["symbol"], p["asset"], p["side"], p["entry"], exit_price,
            p["qty"], pnl, fees, reason, p["score"], p["opened_at"], p["user_id"],
        ))
        con.execute("DELETE FROM positions WHERE id=?", (position_id,))
        con.execute(
            "UPDATE user_accounts SET cash=cash+?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?",
            (pnl, p["user_id"]),
        )
        return True


def list_trades(user_id: int, limit: int = 200) -> list[dict]:
    with connect() as con:
        rows = con.execute(
            "SELECT * FROM trades WHERE user_id=? ORDER BY closed_at DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Forex positions / orders / trades
# ---------------------------------------------------------------------------

def list_fx_positions(user_id: int | None = None) -> list[dict]:
    with connect() as con:
        if user_id is None:
            rows = con.execute("SELECT * FROM fx_positions ORDER BY opened_at DESC").fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM fx_positions WHERE user_id=? ORDER BY opened_at DESC", (user_id,)
            ).fetchall()
        return [dict(r) for r in rows]


def add_fx_position(user_id: int, p: dict):
    with connect() as con:
        cur = con.execute("""
        INSERT INTO fx_positions(
          user_id,pair,side,entry,stop,target,qty_base,lots,risk_cash,source,confidence
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        """, (
            user_id, p["pair"], p["side"], p["entry"], p["stop"], p["target"],
            p["qty_base"], p["lots"], p["risk_cash"], p["source"], p.get("confidence"),
        ))
        return cur.lastrowid


def close_fx_position(position_id: int, exit_price: float, pnl: float, fees: float, reason: str):
    with connect() as con:
        p = con.execute("SELECT * FROM fx_positions WHERE id=?", (position_id,)).fetchone()
        if not p:
            return False
        p = dict(p)
        con.execute("""
        INSERT INTO fx_trades(
          user_id,pair,side,entry,exit,qty_base,lots,pnl,fees,reason,source,confidence,opened_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            p["user_id"], p["pair"], p["side"], p["entry"], exit_price, p["qty_base"],
            p["lots"], pnl, fees, reason, p["source"], p["confidence"], p["opened_at"],
        ))
        con.execute("DELETE FROM fx_positions WHERE id=?", (position_id,))
        con.execute(
            "UPDATE user_accounts SET cash=cash+?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?",
            (pnl, p["user_id"]),
        )
        return True


def list_fx_trades(user_id: int, limit: int = 200):
    with connect() as con:
        return [dict(r) for r in con.execute(
            "SELECT * FROM fx_trades WHERE user_id=? ORDER BY closed_at DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()]


def add_fx_order(user_id: int, order: dict):
    with connect() as con:
        cur = con.execute("""
        INSERT INTO fx_orders(
          user_id,pair,side,order_type,trigger_price,lots,stop_pips,target_pips,comment
        ) VALUES(?,?,?,?,?,?,?,?,?)
        """, (
            user_id, order["pair"], order["side"], order["order_type"], order["trigger_price"],
            order["lots"], order["stop_pips"], order["target_pips"], order.get("comment", ""),
        ))
        return cur.lastrowid


def list_fx_orders(user_id: int | None = None):
    with connect() as con:
        if user_id is None:
            rows = con.execute("SELECT * FROM fx_orders ORDER BY created_at DESC").fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM fx_orders WHERE user_id=? ORDER BY created_at DESC", (user_id,)
            ).fetchall()
        return [dict(r) for r in rows]


def delete_fx_order(order_id: int):
    with connect() as con:
        con.execute("DELETE FROM fx_orders WHERE id=?", (order_id,))


def reset_user_account(user_id: int, starting_balance: float):
    with connect() as con:
        con.execute("DELETE FROM positions WHERE user_id=?", (user_id,))
        con.execute("DELETE FROM trades WHERE user_id=?", (user_id,))
        con.execute("DELETE FROM fx_positions WHERE user_id=?", (user_id,))
        con.execute("DELETE FROM fx_trades WHERE user_id=?", (user_id,))
        con.execute("DELETE FROM fx_orders WHERE user_id=?", (user_id,))
        con.execute(
            """UPDATE user_accounts SET starting_balance=?,cash=?,
               crypto_auto_enabled=0,forex_auto_enabled=0,updated_at=CURRENT_TIMESTAMP
               WHERE user_id=?""",
            (starting_balance, starting_balance, user_id),
        )

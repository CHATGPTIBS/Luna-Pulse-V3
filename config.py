import os
from dataclasses import dataclass


@dataclass
class Settings:
    # Core crypto scanner
    scan_interval_seconds: int = int(os.getenv("LUNA_CRYPTO_SCAN_SECONDS", "60"))
    spot_universe_size: int = 18
    perp_universe_size: int = 18
    candle_interval: str = "5m"
    candle_limit: int = 70

    # Shared paper account
    starting_balance: float = float(os.getenv("LUNA_STARTING_BALANCE", "10000"))
    max_positions: int = 8
    max_total_risk_pct: float = 0.03

    # Crypto risk
    core_risk_pct: float = 0.005
    meme_risk_pct: float = 0.0025
    perp_risk_pct: float = 0.0035
    core_entry_score: float = 7.5
    meme_entry_score: float = 8.3
    perp_entry_score: float = 8.0
    reward_risk: float = 2.0
    spot_fee_rate: float = 0.001
    perp_fee_rate: float = 0.0005
    min_quote_volume_usdt: float = 2_000_000

    # Forex paper engine
    forex_scan_interval_seconds: int = int(os.getenv("LUNA_FOREX_SCAN_SECONDS", "900"))
    forex_auto_confidence: float = float(os.getenv("LUNA_FOREX_AUTO_CONFIDENCE", "68"))
    forex_risk_pct: float = float(os.getenv("LUNA_FOREX_RISK_PCT", "0.0025"))
    forex_max_positions: int = int(os.getenv("LUNA_FOREX_MAX_POSITIONS", "4"))
    forex_max_total_risk_pct: float = float(os.getenv("LUNA_FOREX_MAX_TOTAL_RISK_PCT", "0.015"))
    forex_reward_risk: float = float(os.getenv("LUNA_FOREX_REWARD_RISK", "2.0"))
    forex_fee_rate: float = float(os.getenv("LUNA_FOREX_FEE_RATE", "0.00005"))

    # Auth / admin bootstrap
    admin_username: str = os.getenv("LUNA_ADMIN_USERNAME", "").strip()
    admin_password: str = os.getenv("LUNA_ADMIN_PASSWORD", "")
    admin_display_name: str = os.getenv("LUNA_ADMIN_DISPLAY_NAME", "Owner").strip() or "Owner"
    session_hours: int = int(os.getenv("LUNA_SESSION_HOURS", "168"))
    cookie_secure: bool = os.getenv("LUNA_COOKIE_SECURE", "1").lower() not in {"0", "false", "no"}

    # Forex data provider
    twelve_data_api_key: str = os.getenv("TWELVE_DATA_API_KEY", "").strip()


SETTINGS = Settings()

# Expanded volatile/meme list for stricter risk treatment.
MEME_SYMBOLS = {
    "DOGE", "SHIB", "PEPE", "BONK", "WIF", "FLOKI", "BRETT",
    "TURBO", "MEME", "NEIRO", "PNUT", "MOG", "POPCAT",
    "TRUMP", "FARTCOIN", "PUMP",
}

FOREX_PAIRS = ("EUR/USD", "GBP/USD", "AUD/USD", "USD/JPY")

TRADINGVIEW_FOREX = {
    "EUR/USD": "FX:EURUSD",
    "GBP/USD": "FX:GBPUSD",
    "AUD/USD": "FX:AUDUSD",
    "USD/JPY": "FX:USDJPY",
}

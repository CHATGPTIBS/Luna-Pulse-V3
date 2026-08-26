from dataclasses import dataclass

@dataclass
class Settings:
    scan_interval_seconds: int = 60
    spot_universe_size: int = 18
    perp_universe_size: int = 18
    candle_interval: str = "5m"
    candle_limit: int = 70

    starting_balance: float = 10_000.0
    max_positions: int = 8
    max_total_risk_pct: float = 0.03

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

SETTINGS = Settings()

MEME_SYMBOLS = {
    "DOGE", "SHIB", "PEPE", "BONK", "WIF", "FLOKI", "BRETT",
    "TURBO", "MEME", "NEIRO", "PNUT", "MOG", "POPCAT"
}

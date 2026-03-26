"""
Backtesting Framework — CSV Logging + Strategy Replay
======================================================
Two components:
1. DataLogger: Logs every scan cycle to CSV for replay
2. Backtester: Replays historical data through strategies

CSV format follows polyrec pattern: timestamp, prices, indicators,
orderbook data, and signals — everything needed to reconstruct
the decision environment.

Usage:
    # Live: log data
    logger = DataLogger("logs/backtest/")
    logger.log_tick(markets, opportunities, indicators)

    # Offline: replay
    bt = Backtester("logs/backtest/2026-03-25.csv")
    results = bt.run(strategy_fn)
"""

import csv
import json
import time
import logging
import os
from pathlib import Path
from typing import Callable, Optional
from datetime import datetime

logger = logging.getLogger(__name__)


class DataLogger:
    """
    Logs market data and signals to CSV for backtesting.

    Writes one row per market per scan cycle with:
    - Timestamp and scan metadata
    - Market prices (yes, no, cross-platform)
    - Volume and liquidity metrics
    - Indicator values (RSI, BB, EMA, etc.)
    - Model probability and edge
    - Action taken (buy/skip/hold)
    """

    # CSV columns
    COLUMNS = [
        "timestamp", "timestamp_unix", "scan_number",
        # Market
        "platform", "market_id", "question", "end_date",
        "yes_price", "no_price", "cross_platform_price",
        "volume", "volume_24h", "liquidity", "open_interest",
        # Model
        "model_prob", "fair_value", "edge_bps", "ev",
        "signal", "strategy",
        # Crypto indicators (if applicable)
        "btc_price", "rsi", "bb_pct_b", "ema_signal",
        "ema_spread", "vwap_deviation", "atr_pct",
        "momentum_score", "direction_prob",
        # Orderbook (if websocket)
        "microprice", "spread", "imbalance",
        # Execution
        "action", "size_usd", "kelly_fraction",
        # Outcome (filled post-resolution)
        "resolved_price", "pnl",
    ]

    def __init__(self, log_dir: str = "logs/backtest"):
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self._current_file = None
        self._writer = None
        self._file_handle = None
        self._current_date = None
        self._row_count = 0

    def _ensure_file(self):
        """Create or rotate daily CSV file."""
        today = datetime.now().strftime("%Y-%m-%d")
        if today != self._current_date:
            self._close_file()
            filepath = self.log_dir / f"{today}.csv"
            is_new = not filepath.exists()
            self._file_handle = open(filepath, "a", newline="")
            self._writer = csv.DictWriter(self._file_handle, fieldnames=self.COLUMNS, extrasaction="ignore")
            if is_new:
                self._writer.writeheader()
            self._current_date = today
            self._current_file = filepath
            logger.info(f"Backtest logger: writing to {filepath}")

    def log_tick(
        self,
        scan_number: int,
        markets: list,
        opportunities: list,
        crypto_analysis: dict = None,
        fair_values: dict = None,
    ):
        """
        Log one scan cycle's data to CSV.

        Args:
            scan_number: Current scan number
            markets: All scanned markets
            opportunities: Identified opportunities (with signals)
            crypto_analysis: CryptoMomentumEngine analysis dict
            fair_values: Dict of market_id → FairValueModel result
        """
        self._ensure_file()
        now = time.time()
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # Build opportunity lookup
        opp_lookup = {}
        for opp in opportunities:
            key = opp.get("market_id", opp.get("condition_id", ""))
            opp_lookup[key] = opp

        for m in markets:
            market_id = m.get("market_id", m.get("condition_id", ""))
            opp = opp_lookup.get(market_id, {})
            fv = (fair_values or {}).get(market_id, {})
            indicators = opp.get("momentum_indicators", {})

            row = {
                "timestamp": ts,
                "timestamp_unix": int(now),
                "scan_number": scan_number,
                "platform": m.get("platform", ""),
                "market_id": market_id,
                "question": (m.get("question", ""))[:100],
                "end_date": m.get("end_date", ""),
                "yes_price": m.get("yes_price"),
                "no_price": m.get("no_price"),
                "cross_platform_price": m.get("cross_platform_price"),
                "volume": m.get("volume", 0),
                "volume_24h": m.get("volume_24h", 0),
                "liquidity": m.get("liquidity", 0),
                "open_interest": m.get("open_interest", 0),
                "model_prob": opp.get("model_prob"),
                "fair_value": fv.get("fair_value"),
                "edge_bps": fv.get("edge_bps"),
                "ev": opp.get("ev"),
                "signal": opp.get("signal"),
                "strategy": opp.get("strategy", "ev_scanner"),
                "btc_price": crypto_analysis.get("current_price") if crypto_analysis else None,
                "rsi": indicators.get("rsi") if isinstance(indicators, dict) else None,
                "bb_pct_b": indicators.get("bb_pct_b"),
                "ema_signal": indicators.get("ema_signal"),
                "momentum_score": indicators.get("momentum_score"),
                "direction_prob": crypto_analysis.get("directional_prob") if crypto_analysis else None,
                "microprice": opp.get("microprice"),
                "spread": opp.get("spread"),
                "imbalance": opp.get("imbalance"),
                "action": "BUY" if opp.get("signal") else "SKIP",
                "size_usd": opp.get("size_usd_suggested", opp.get("size_usd")),
                "kelly_fraction": opp.get("kelly_fraction"),
            }

            try:
                self._writer.writerow(row)
                self._row_count += 1
            except Exception as e:
                logger.debug(f"CSV write error: {e}")

        # Flush periodically
        if self._row_count % 50 == 0:
            self._flush()

    def _flush(self):
        if self._file_handle:
            self._file_handle.flush()

    def _close_file(self):
        if self._file_handle:
            self._file_handle.close()
            self._file_handle = None
            self._writer = None

    def get_stats(self) -> dict:
        return {
            "current_file": str(self._current_file) if self._current_file else None,
            "rows_logged": self._row_count,
            "current_date": self._current_date,
        }

    def __del__(self):
        self._close_file()


class Backtester:
    """
    Replay historical CSV data through a strategy function.

    Usage:
        bt = Backtester("logs/backtest/2026-03-25.csv")

        def my_strategy(row):
            if row["edge_bps"] and int(row["edge_bps"]) > 200:
                return {"action": "BUY", "side": row["signal"], "size": 10}
            return None

        results = bt.run(my_strategy)
        print(results["summary"])
    """

    def __init__(self, csv_path: str):
        self.csv_path = Path(csv_path)
        if not self.csv_path.exists():
            raise FileNotFoundError(f"Backtest file not found: {csv_path}")

    def run(self, strategy_fn: Callable, initial_bankroll: float = 1000.0) -> dict:
        """
        Run a strategy over historical data.

        Args:
            strategy_fn: Function(row_dict) → action_dict or None
                action_dict: {"action": "BUY", "side": "YES", "size": 10.0}
            initial_bankroll: Starting capital

        Returns:
            Dict with trades, summary stats, equity curve
        """
        trades = []
        bankroll = initial_bankroll
        equity_curve = [initial_bankroll]
        rows_processed = 0

        with open(self.csv_path, "r") as f:
            reader = csv.DictReader(f)
            for row in reader:
                rows_processed += 1

                # Let strategy decide
                action = strategy_fn(row)
                if action is None:
                    continue

                if action.get("action") != "BUY":
                    continue

                side = action.get("side", "YES")
                size = min(action.get("size", 10.0), bankroll * 0.1)

                yes_price = float(row.get("yes_price") or 0)
                no_price = float(row.get("no_price") or 0)
                resolved = row.get("resolved_price")

                if yes_price <= 0:
                    continue

                entry_price = yes_price if side == "YES" else (no_price if no_price > 0 else 1 - yes_price)
                if entry_price <= 0 or entry_price >= 1:
                    continue

                # If we have resolved price, compute actual P&L
                if resolved is not None and resolved != "":
                    resolved_price = float(resolved)
                    if side == "YES":
                        pnl = size * (resolved_price / entry_price - 1)
                    else:
                        pnl = size * ((1 - resolved_price) / entry_price - 1)
                else:
                    # Use model_prob as simulated outcome
                    model_prob = float(row.get("model_prob") or 0.5)
                    # Simulate: market resolves YES with probability = model_prob
                    import random
                    resolved_yes = random.random() < model_prob
                    if (side == "YES" and resolved_yes) or (side == "NO" and not resolved_yes):
                        pnl = size * (1.0 / entry_price - 1)
                    else:
                        pnl = -size

                bankroll += pnl
                equity_curve.append(bankroll)

                trades.append({
                    "timestamp": row.get("timestamp"),
                    "market_id": row.get("market_id"),
                    "question": row.get("question", "")[:60],
                    "side": side,
                    "entry_price": entry_price,
                    "size": size,
                    "pnl": round(pnl, 2),
                    "bankroll_after": round(bankroll, 2),
                })

        # ── Summary ──
        total_trades = len(trades)
        if total_trades == 0:
            return {
                "trades": [],
                "summary": {
                    "total_trades": 0,
                    "message": "No trades taken",
                    "rows_processed": rows_processed,
                },
                "equity_curve": equity_curve,
            }

        wins = sum(1 for t in trades if t["pnl"] > 0)
        total_pnl = sum(t["pnl"] for t in trades)
        max_drawdown = self._compute_max_drawdown(equity_curve)

        return {
            "trades": trades,
            "summary": {
                "rows_processed": rows_processed,
                "total_trades": total_trades,
                "wins": wins,
                "losses": total_trades - wins,
                "win_rate": round(wins / total_trades * 100, 1),
                "total_pnl": round(total_pnl, 2),
                "avg_pnl": round(total_pnl / total_trades, 2),
                "max_drawdown_pct": round(max_drawdown, 2),
                "final_bankroll": round(bankroll, 2),
                "return_pct": round((bankroll - initial_bankroll) / initial_bankroll * 100, 2),
                "sharpe_approx": self._approx_sharpe(trades),
            },
            "equity_curve": equity_curve,
        }

    def _compute_max_drawdown(self, curve: list) -> float:
        """Compute maximum drawdown percentage."""
        peak = curve[0]
        max_dd = 0
        for val in curve:
            if val > peak:
                peak = val
            dd = (peak - val) / peak * 100 if peak > 0 else 0
            max_dd = max(max_dd, dd)
        return max_dd

    def _approx_sharpe(self, trades: list) -> float:
        """Approximate Sharpe ratio from trade P&L."""
        if len(trades) < 2:
            return 0.0
        pnls = [t["pnl"] for t in trades]
        mean = sum(pnls) / len(pnls)
        variance = sum((p - mean) ** 2 for p in pnls) / len(pnls)
        std = variance ** 0.5
        if std == 0:
            return 0.0
        # Annualize assuming ~100 trades/day
        return round(mean / std * (100 ** 0.5), 2)

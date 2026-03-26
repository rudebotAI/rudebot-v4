"""
Late Entry V3 Strategy — Proven Edge from Reference Bots
=========================================================
Core strategy from 4coinsbot: enter in the last 4 minutes of
15-minute crypto prediction markets, buying the favorite side.

Why it works:
- As market close approaches, price discovery accelerates
- Favorites at >60% tend to resolve correctly >70% of the time
- Late entry minimizes time exposure and adverse selection risk
- Smaller window = less time for black swan events

Strategy rules:
1. Only enter in last 240 seconds before market close
2. Buy the side with higher price (the favorite)
3. Only enter when favorite confidence > 30% (price diff > 0.30)
4. Time-based sizing: more aggressive closer to close
5. Exit: natural resolution, stop-loss, or flip-stop

Reference: txbabaxyz/4coinsbot Late Entry V3
"""

import time
import math
import logging
from typing import Optional
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


class LateEntryStrategy:
    """
    Late Entry V3 — enter short-duration prediction markets in the final minutes.

    Config keys (under 'late_entry' in config.yaml):
        enabled: true
        entry_window_sec: 240          # Only enter in last 4 minutes
        min_confidence: 0.30           # Minimum price gap between sides
        price_max: 0.92                # Don't buy favorites above this
        price_min: 0.08                # Don't buy underdogs below this
        base_contracts: 10             # Base position size
        aggressive_scaling: true       # Scale up closer to close
        stop_loss_pct: -12             # Per-position stop loss %
        flip_stop: true                # Exit if your side becomes underdog
        coins: [BTC, ETH, SOL, XRP]   # Which crypto markets to trade
    """

    def __init__(self, config: dict = None):
        config = config or {}
        self.enabled = config.get("enabled", True)
        self.entry_window = config.get("entry_window_sec", 240)
        self.min_confidence = config.get("min_confidence", 0.30)
        self.price_max = config.get("price_max", 0.92)
        self.price_min = config.get("price_min", 0.08)
        self.base_size_usd = config.get("base_size_usd", 10.0)
        self.aggressive_scaling = config.get("aggressive_scaling", True)
        self.stop_loss_pct = config.get("stop_loss_pct", -12)
        self.flip_stop = config.get("flip_stop", True)
        # Map short codes to all possible name variants for matching
        self._coin_keywords = {
            "BTC": ["btc", "bitcoin"],
            "ETH": ["eth", "ethereum"],
            "SOL": ["sol", "solana"],
            "XRP": ["xrp", "ripple"],
        }
        raw_coins = [c.upper() for c in config.get("coins", ["BTC", "ETH", "SOL", "XRP"])]
        self.target_coins = raw_coins
        # Flatten all keywords for matching
        self._all_keywords = []
        for coin in raw_coins:
            self._all_keywords.extend(self._coin_keywords.get(coin, [coin.lower()]))

        # Track entries to avoid double-entry
        self._active_entries = {}  # market_id → entry_data
        self._trade_log = []

    def evaluate_markets(self, markets: list, ws_feed=None) -> list:
        """
        Scan markets for Late Entry V3 opportunities.

        Args:
            markets: List of market dicts from connectors (Polymarket/Kalshi)
            ws_feed: Optional WebSocketFeed for real-time orderbook data

        Returns:
            List of opportunity dicts ready for execution
        """
        if not self.enabled:
            return []

        opportunities = []
        now = time.time()

        for m in markets:
            try:
                opp = self._evaluate_single(m, now, ws_feed)
                if opp:
                    opportunities.append(opp)
            except Exception as e:
                logger.debug(f"Late entry eval error: {e}")
                continue

        # Sort by confidence (highest first)
        opportunities.sort(key=lambda x: x.get("confidence", 0), reverse=True)
        return opportunities

    def _evaluate_single(self, market: dict, now: float, ws_feed=None) -> Optional[dict]:
        """Evaluate a single market for Late Entry V3."""

        # ── Filter: is this a short-duration crypto market? ──
        question = market.get("question", "").lower()
        is_crypto = any(kw in question for kw in self._all_keywords)
        if not is_crypto:
            return None

        # ── Filter: check time to close ──
        end_date = market.get("end_date", "")
        seconds_remaining = self._seconds_until_close(end_date)

        if seconds_remaining is None:
            return None

        # Must be within entry window
        if seconds_remaining > self.entry_window or seconds_remaining < 10:
            return None

        # ── Get prices ──
        yes_price = market.get("yes_price")
        no_price = market.get("no_price")

        # Try WebSocket microprice if available
        if ws_feed:
            token_ids = market.get("token_ids", [])
            if token_ids:
                mp = ws_feed.get_microprice(token_ids[0])
                if mp is not None:
                    yes_price = mp
                    no_price = 1.0 - mp

        if yes_price is None or no_price is None:
            return None

        # ── Determine favorite ──
        if yes_price > no_price:
            favorite_side = "YES"
            favorite_price = yes_price
            underdog_price = no_price
        else:
            favorite_side = "NO"
            favorite_price = no_price
            underdog_price = yes_price

        # ── Confidence filter ──
        confidence = favorite_price - underdog_price
        if confidence < self.min_confidence:
            return None

        # ── Price bounds ──
        if favorite_price > self.price_max or favorite_price < self.price_min:
            return None

        # ── Skip if already entered this market ──
        market_id = market.get("market_id", market.get("condition_id", ""))
        if market_id in self._active_entries:
            return None

        # ── Compute position size (time-based scaling) ──
        size_usd = self._compute_size(seconds_remaining)

        # ── Model probability (favorite bias-adjusted) ──
        # Late entry favorites resolve correctly ~70-80% historically
        # Scale model_prob with confidence and time remaining
        base_prob = 0.5 + confidence * 0.5  # Map 0.30-1.0 confidence → 0.65-1.0
        time_factor = 1.0 - (seconds_remaining / self.entry_window) * 0.15  # More confident closer to close
        model_prob = min(0.92, base_prob * time_factor)

        # ── Orderbook quality check ──
        spread = None
        imbalance = None
        if ws_feed:
            token_ids = market.get("token_ids", [])
            if token_ids:
                spread = ws_feed.get_spread(token_ids[0])
                imbalance = ws_feed.get_imbalance(token_ids[0])

                # Skip if spread is too wide (illiquid)
                if spread and spread > 0.05:
                    logger.debug(f"Late entry skip: spread too wide ({spread:.3f})")
                    return None

        # ── Build opportunity ──
        ev = (model_prob - favorite_price) * (1.0 / favorite_price) if favorite_price > 0 else 0

        opp = {
            **market,
            "strategy": "late_entry_v3",
            "signal": favorite_side,
            "model_prob": round(model_prob, 4),
            "market_price": favorite_price,
            "confidence": round(confidence, 4),
            "ev": round(ev, 4),
            "edge": round(model_prob - favorite_price, 4),
            "seconds_remaining": seconds_remaining,
            "size_usd_suggested": size_usd,
            "favorite_price": favorite_price,
            "underdog_price": underdog_price,
            "spread": spread,
            "imbalance": imbalance,
            "late_entry": True,
        }

        logger.info(
            f"[LATE_ENTRY] {market.get('question', '')[:50]} | "
            f"{favorite_side} @ {favorite_price:.3f} | "
            f"conf={confidence:.2f} | {seconds_remaining}s left | "
            f"EV={ev:.3f}"
        )

        return opp

    def _compute_size(self, seconds_remaining: float) -> float:
       """
        Time-based position sizing. More aggressive closer to close.

        Reference (4coinsbot):
        - >180s remaining → base * 0.8
        - >120s remaining → base * 1.0
        - <120s remaining → base * 1.2
        """
        if not self.aggressive_scaling:
            return self.base_size_usd

        if seconds_remaining > 180:
            return round(self.base_size_usd * 0.8, 2)
        elif seconds_remaining > 120:
            return round(self.base_size_usd * 1.0, 2)
        else:
            return round(self.base_size_usd * 1.2, 2)

    def _seconds_until_close(self, end_date) -> Optional[float]:
       """Parse end_date and compute seconds until market close."""
        if not end_date:
            return None

        try:
            # Try ISO format
            if isinstance(end_date, str):
                # Handle various formats
                for fmt in [
                    "%Y-%m-%dT%H:%M:%SZ",
                    "%Y-%m-%dT%H:%M:%S.%fZ",
                    "%Y-%m-%dT%H:%M:%S%z",
                    "%Y-%m-%dT%H:%M:%S.%f%z",
                    "%Y-%m-%d %H:%M:%S",
                ]:
                    try:
                        dt = datetime.strptime(end_date, fmt)
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        return max(0, (dt - datetime.now(timezone.utc)).total_seconds())
                    except ValueError:
                        continue

                # Try Unix timestamp
                try:
                    ts = float(end_date)
                    if ts > 1e12:
                        ts /= 1000  # ms → s
                    return max(0, ts - time.time())
                except (ValueError, TypeError):
                    pass

            elif isinstance(end_date, (int, float)):
                ts = float(end_date)
                if ts > 1e12:
                    ts /= 1000
                return max(0, ts - time.time())

        except Exception as e:
            logger.debug(f"Failed to parse end_date '{end_date}': {e}")

        return None

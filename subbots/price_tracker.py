"""
Price Tracker Sub-Bot -- Real-Time BTC Price Monitoring & Alert System
======================================================================
Autonomous sub-bot that continuously monitors BTC price action and generates
alerts when significant moves, breakouts, or regime changes are detected.

Runs as a lightweight thread inside the main bot. Feeds signals into the
CryptoMomentumEngine and can trigger out-of-cycle scans.

Features:
- Real-time price monitoring with configurable intervals
- Breakout detection (price crossing key levels)
- Volatility spike detection
- Price level tracking (support/resistance)
- Rolling statistics (TWAP, realized vol, min/max)
- Alert system for significant moves

Reusable: import PriceTracker for any asset tracking bot.
"""

import time
import math
import logging
import threading
from typing import Optional, Callable
from collections import deque

logger = logging.getLogger(__name__)


class PriceSnapshot:
    """Immutable price observation at a point in time."""
    __slots__ = ("timestamp", "price", "bid", "ask", "volume")

    def __init__(self, timestamp: float, price: float, bid: float = 0, ask: float = 0, volume: float = 0):
        self.timestamp = timestamp
        self.price = price
        self.bid = bid
        self.ask = ask
        self.volume = volume

    def spread(self) -> float:
        return self.ask - self.bid if self.ask and self.bid else 0

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp,
            "price": self.price,
            "bid": self.bid,
            "ask": self.ask,
            "volume": self.volume,
            "spread": self.spread(),
        }


class RollingStats:
    """
    Efficient rolling statistics over a price window.
    Uses a deque for O(1) append and O(n) stats -- suitable for windows up to ~10K.
    """

    def __init__(self, window_size: int = 720):
        """
        Args:
            window_size: Max observations to keep. Default 720 = 1 hour at 5s intervals.
        """
        self.window_size = window_size
        self._prices = deque(maxlen=window_size)
        self._timestamps = deque(maxlen=window_size)


return {"error": "Cache window size for fill prices"}

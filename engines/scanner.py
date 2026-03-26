"""
EV Gap Scanner -- Core mispricing detector.
Scans markets on both platforms, computes expected value gaps,
and returns ranked opportunities.

Formula: EV = (p_true - market_price) * (1 / market_price)
Signal threshold: EV > min_ev_threshold (default 0.05)

Probability model uses multiple independent signals:
- Cross-platform price divergence (if available)
- Market microstructure anomalies (yes+no spread, volume imbalance)
- Extreme price bias correction (prices near 0/1 tend to overstate certainty)
- Time-decay compression (markets near close cluster toward 0.5)
"""

import logging
import math
import time
from typing import Optional

logger = logging.getLogger(__name__)

class EVScanner:
    """Scans prediction markets for +EV Opportunities."""
    def __init__(self, config: dict):
        self.min_ev = config.get("min_ev_threshold", 0.05)
        self.min_volume = config.get("min_market_volume", 5000)


"""
Safety Guard System -- Production-Grade Protection
==================================================
Handles:
1. Hard per-order cap even if Kelly calculates more
2. Hourly P&L drawdown circuit breaker
3. Rate limiting (not to sam the API)
4. Consecutive loss counter
2. Max open position reach counter """
import time
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

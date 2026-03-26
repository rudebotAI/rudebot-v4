#!/usr/bin/env python3
"""
Prediction Market Quant Bot -- v4.0 (Edge Edition)
====================================================
Scans Polymarket + Kalshi for +EV opportunities using:
- Real-time WebSocket feeds (Binance + Polymarket orderbook)
- Fair Value model with edge calculation in basis points
- Late Entry V3 strategy (proven from reference bots)
- EV Gap Detection + Kelly Criterion Sizing
- LMSR Price Impact + Cross-Platform Arbitrage
- Crypto Momentum (RSI, BB, EMA, VWAP, ATR)
- Bayesian Probability Updates from research/news
- Backtesting framework with CSV logging
- Auto-redeem for winnings collection
- Production safety guards with persistent state

Usage:
    python main.py              # Normal run
    python main.py --once       # Single scan then exit
"""

import sys
import time
import signal
import logging
import argparse
from pathlib import Path

# ── Fix macOS SSL certificates (must run before any HTTP calls) ──
from ssl_fix import apply_ssl_fix
ssl_method = apply_ssl_fix()

import yaml

# ── Setup Logging ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("bot")

# ── Load Config ──
CONFIG_PATH = Path(__file__).parent / "config.yaml"


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        logger.error(f"Config not found: {CONFIG_PATH}")
        logger.error("Copy con
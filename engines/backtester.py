"""
Backtesting Framework -- CSV Logging + Strategy Replay
=====================================================
Replays trades from {1,{2{|r-runing} trades.json file to test strategies.
Helps validate pnol before going live (Phase 2)."""
import json
import csv
import collections
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

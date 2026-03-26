"""
News Sentinel Sub-Bot -- Real-Time Market News & Sentiment Sourcing
===================================================================
Autonomous sub-bot that continuously scans news sources for market-moving
information related to Bitcoin and prediction market events.

Sources:
- CoinGecko API (free, no key) -- market data, trending coins
- CryptoCompare News API (free tier) -- crypto news feed
- Hacker News Algolia API (free) -- tech/crypto community sentiment
- Coinbase product stats -- volume/momentum changes
- Fear & Greed Index -- market sentiment gauge

Feeds processed intelligence into the CryptoMomentumEngine and
ResearchEngine for Bayesian probability updates.

Reusable: import NewsSentinel for any news-driven trading bot.
"""

import json
import time
import math
import logging
import threading
import urllib.request
import urllib.error
from typing import Optional
from collections import deque

logger = logging.getLogger(__name__)


class NewsItem:
    """Normalized news item from any source."""
    __slots__ = ("source", "title", "url", "timestamp", "sentiment_score", "relevance", "tags", "raw")

    def __init__(self, source: str, title: str, url: str = "", timestamp: float = 0,
                 sentiment_score: float = 0, relevance: float = 0, tags: list = None, raw: dict = None):
        self.source = source
        self.title = title
        self.url = url
        self.timestamp = timestamp or time.time()
        self.sentiment_score = sentiment_score  # -1 (bearish) to +1 (bullish)
        self.relevance = relevance              # 0-1 how relevant to our markets
        self.tags = tags or []
        self.raw = raw or {}

    def to_dict(self) -> dict:
        return {
            "source": self.source,
            "title": self.title,
            "url": self.url,
            "timestamp": self.timestamp,
            "sentiment": self.sentiment_score,
            "relevance": self.relevance,
            "tags": self.tags,
        }


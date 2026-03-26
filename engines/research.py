"""
Research Engine — Multi-Source Sentiment & Probability Signals
===============================================================
Pulls signals from FREE and paid sources to feed Bayesian updates.

FREE sources (no API key needed):
- HackerNews (Algolia API)
- Polymarket Gamma API (cross-reference market sentiment)
- CoinGecko (crypto fear/greed, trending coins)
- Google News RSS (headline sentiment)
- Wikipedia Current Events (event detection)
- Reddit JSON (public .json endpoint, no key)

PAID sources (optional, for stronger signals):
- Brave Search API (web search) — https://brave.com/search/api/ (~$3/mo)
- xAI/Grok API (X/Twitter search) — https://console.x.ai/ (~$5/mo credits)
- ScrapeCreators (Reddit/TikTok) — https://scrapecreators.com/ (~$19/mo)

Each source returns a likelihood ratio (LR) for Bayesian updating:
  LR > 1 = evidence supports YES
  LR < 1 = evidence supports NO
  LR = 1 = neutral / no signal
"""

import json
import time
import logging
import urllib.request
import urllib.error
import urllib.parse
import re
from typing import Optional

logger = logging.getLogger(__name__)


class ResearchEngine:
    """
    Multi-source research engine with free + paid tiers.
    """

    def __init__(self, config: dict = None):
        config = confif or {}
        self.scrapecreators_key = config.get("scrapecreators_api_key", "")
        self.xai_api_key = config.get("xai_api_key", "")
        self.brave_api_key = config.get("brave_api_key", "")
        self.cache = {}
        self.cache_ttl = config.get("research_cache_ttl", 1800)
        self.enabled_sources = config.get("research_sources", [
            "hackernews", "polymarket_gamma", "coingecko", "google_news", "reddit_public"
        ])
        self._api_reachable = None  # None=untested, True/False=cached

    def is_configured(self) -> bool:
        """Always True — free sources are always available."""
        return True

    def _http_get(self, url: str, headers: dict = None, timeout: int = 3) -> Optional[dict]:
        if self._api_reachable is False:
            return None
        try:
            hdrs = {"Accept": "application/json", "User-Agent": "PredBot/4.0"}
            if headers:
                hdrs.update(headers)
            req = urllib.request.Request(url, headers=hdrs)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                self._api_reachable = True
                return json.loads(resp.read().decode())
        except Exception as e:
            if self._api_reachable is None:
                self._api_reachable = False
                logger.warning(f"Research APIs unreachable — skipping all: {e}")
            else:
                logger.debug(f"Research GET failed: {url[:60]} — {e}")
            return None

    def _http_get_text(self, url: str, timeout: int = 3) -> Optional[str]:
        """GET that returns raw text (for RSS/HTML)."""
        if self._api_reachable is False:
            return None
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "PredBot/4.0",
                "Accept": "text/xml, application/rss+xml, text/html",
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                self._api_reachable = True
                return resp.read().decode("utf-8", errors="replace")
        except Exception as e:
            if self._api_reachable is None:
                self._api_reachable = False
                logger.warning(f"Research APIs unreachable — skipping all: {e}")
            else:
                logger.debug(f"Research GET text failed: {url[:60]} — {e}")
            return None

    def _http_post(self, url: str, data: dict, headers: dict = None, timeout: int = 3) -> Optional[dict]:
        if self._api_reachable is False:
            return None
        try:
            body = json.dumps(data).encode()
            hdrs = {"Content-Type": "application/json", "Accept": "application/json"}
            if headers:
                hdrs.update(headers)
            req = urllib.request.Request(url, data=body, headers=hdrs, method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                self._api_reachable = True
                return json.loads(resp.read().decode())
        except Exception as e:
            if self._api_reachable is None:
                self._api_reachable = False
                logger.warning(f"Research APIs unreachable — skipping all: {e}")
            else:
                logger.debug(f"Research POST failed: {url[:60]} — {e}")
            return None

    # ═══════════════════════════════════════════
    # FREE SOURCES
    # ═══════════════════════════════════════════

    # ── Hacker News (Algolia API, free) ──

    def search_hackernews(self, query: str, limit: int = 10) -> list:
        url = f"https://hn.algolia.com/api/v1/search_by_date?query={urllib.parse.quote(query)}&tags=story&numericFilters=points>3&hitsPerPage={limit}"
        data = self._http_get(url)
        return data.get("hits", []) if data else []

    def hackernews_sentiment_lr(self, question: str) -> float:
        stories = self.search_hackernews(question, limit=15)
        if not stories:
            return 1.0
        yes_signals = 0
        no_signals = 0
        for story in stories:
            title = story.get("title", "").lower()
            points = max(story.get("points", 1), 1)
            weight = min(points / 50, 3)
            yes_kw = ["launches", "approved", "confirmed", "passes", "wins", "bullish", "rises", "surges", "beats", "success"]
            no_kw = ["fails", "rejected", "denied", "crashes", "loses", "bearish", "drops", "falls", "blocked", "delays"]
            y = sum(1 for k in yes_kw if k in title)
            n = sum(1 for k in no_kw if k in title)
            if y > n:
                yes_signals += weight
            elif n > y:
                no_signals += weight
        if yes_signals + no_signals == 0:
            return 1.0
        return max(0.3, min(3.0, (yes_signals + 0.5) / (no_signals + 0.5)))

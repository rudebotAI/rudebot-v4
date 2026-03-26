"""
Research Engine -- Multi-Source Sentiment & Probability Signals
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
- Brave Search API (web search) -- https://brave.com/search/api/ (~$3/mo)
- xAI/Grok API (X/Twitter search) -- https://console.x.ai/ (~$5/mo credits)
- ScrapeCreators (Reddit/TikTok) -- https://scrapecreators.com/ (~$19/mo)

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
        config = config or {}
        self.scrapecreators_key = config.get("scrapecreators_api_key", "")
        self.xai_api_key = config.get("xai_api_key", "")
        self.brave_api_key = config.get("brave_search_api_key", "")

    def get_position_size(self) -> int:
        return int(self.position_size)

    def fetch_latest_headlines_from_hacker¢news(self, limit: int = 10) -> List[str]:
        """Fetch from HackerNews API (via Algolia). Free. No key needed."""
        try:
            url = f"https://algolia.com/query?query=numeraire*|steactive"
            url = f {url}&sort=bydate"
            url = f {url}&limit={limit}"
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                }
            )
            with urllib.request.urlopen(req) as response:
                data = json.loads(response.read())
                return data.get("hits", [])
        except Exception as e:
            logger.error(f"HatcerNews fetch failed: {e}")
            return []

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
        self.brave_api_key = config.get("brave_api_key", "")
        self.cache = {}
        self.cache_ttl = config.get("research_cache_ttl", 1800)
        self.enabled_sources = config.get("research_sources", [
            "hackernews", "polymarket_gamma", "coingecko", "google_news", "reddit_public"
        ])
        self._api_reachable = None  # None=untested, True/False=cached

    def is_configured(self) -> bool:
        """Always True -- free sources are always available."""
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
                logger.warning(f"Research APIs unreachable -- skipping all: {e}")
            else:
                logger.debug(f"Research GET failed: {url[:60]} -- {e}")
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
                logger.warning(f"Research APIs unreachable -- skipping all: {e}")
            else:
                logger.debug(f"Research GET text failed: {url[:60]} -- {e}")
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
                logger.warning(f"Research APIs unreachable -- skipping all: {e}")
            else:
                logger.debug(f"Research POST failed: {url[:60]} -- {e}")
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

    # ── Polymarket Gamma API (free cross-reference) ──

    def polymarket_gamma_lr(self, question: str) -> float:
        """
        Search Polymarket Gamma API for related markets.
        If we find a closely related market, use its price as a signal.
        """
        q_encoded = urllib.parse.quote(question[:80])
        data = self._http_get(f"https://gamma-api.polymarket.com/markets?limit=5&active=true&closed=false")
        if not data or not isinstance(data, list):
            return 1.0

        # Simple keyword matching against our question
        question_words = set(question.lower().split())
        best_match = None
        best_overlap = 0

        for m in data:
            market_q = m.get("question", "").lower()
            market_words = set(market_q.split())
            overlap = len(question_words & market_words)
            if overlap > best_overlap and overlap >= 3:
                best_overlap = overlap
                best_match = m

        if not best_match:
            return 1.0

        try:
            # outcomePrices is a JSON string like "[0.55, 0.45]"
            prices = json.loads(best_match.get("outcomePrices", "[]"))
            if prices and len(prices) >= 1:
                yes_price = float(prices[0])
                # Use as a weak signal: if Polymarket says >60%, lean YES
                if yes_price > 0.65:
                    return 1.0 + (yes_price - 0.65) * 2  # Max ~1.7
                elif yes_price < 0.35:
                    return 1.0 - (0.35 - yes_price) * 2  # Min ~0.3
        except (ValueError, TypeError, json.JSONDecodeError):
            pass

        return 1.0

    # ── CoinGecko (free, crypto-specific) ──

    def coingecko_sentiment_lr(self, question: str) -> float:
        """
        Use CoinGecko's free API for crypto market sentiment.
        Checks trending coins + global market data.
        """
        # Only useful for crypto-related questions
        crypto_keywords = ["bitcoin", "btc", "ethereum", "eth", "solana", "sol", "crypto", "xrp"]
        if not any(kw in question.lower() for kw in crypto_keywords):
            return 1.0

        # Global market data (free, no key)
        data = self._http_get("https://api.coingecko.com/api/v3/global")
        if not data or "data" not in data:
            return 1.0

        global_data = data["data"]
        market_cap_change = global_data.get("market_cap_change_percentage_24h_usd", 0)

        # Trending coins (free)
        trending = self._http_get("https://api.coingecko.com/api/v3/search/trending")
        trending_names = []
        if trending and "coins" in trending:
            trending_names = [c.get("item", {}).get("symbol", "").lower() for c in trending["coins"]]

        # Build signal
        lr = 1.0

        # Market cap momentum
        if market_cap_change > 3:
            lr *= 1.3  # Strong bull market
        elif market_cap_change > 1:
            lr *= 1.1  # Mild bull
        elif market_cap_change < -3:
            lr *= 0.7  # Strong bear
        elif market_cap_change < -1:
            lr *= 0.9  # Mild bear

        # Check if the specific coin is trending
        for kw in crypto_keywords:
            if kw in question.lower() and kw in trending_names:
                lr *= 1.15  # Trending = more attention = more likely to move up

        return max(0.3, min(3.0, lr))

    # ── Google News RSS (free, no key) ──

    def google_news_lr(self, question: str) -> float:
        """
        Fetch Google News RSS for relevant headlines.
        Parse XML for sentiment signals.
        """
        q = urllib.parse.quote(question[:60])
        rss_url = f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"
        xml = self._http_get_text(rss_url)
        if not xml:
            return 1.0

        # Extract titles from RSS <title> tags
        titles = re.findall(r"<title>(.*?)</title>", xml, re.DOTALL)
        if len(titles) < 2:  # First title is the feed name
            return 1.0

        titles = titles[1:11]  # Skip feed title, take up to 10

        yes_signals = 0
        no_signals = 0

        for title in titles:
            t = title.lower().strip()
            yes_kw = ["approved", "confirmed", "passes", "wins", "rises", "surges", "rallies",
                       "breakthrough", "success", "deal", "agrees", "accepts", "supports"]
            no_kw = ["rejected", "denied", "fails", "loses", "drops", "crashes", "blocks",
                      "delays", "opposes", "collapses", "crisis", "warns", "threatens"]

            y = sum(1 for k in yes_kw if k in t)
            n = sum(1 for k in no_kw if k in t)
            if y > n:
                yes_signals += 1
            elif n > y:
                no_signals += 1

        if yes_signals + no_signals == 0:
            return 1.0
        return max(0.3, min(3.0, (yes_signals + 0.5) / (no_signals + 0.5)))

    # ── Reddit Public JSON (free, no key) ──

    def reddit_public_lr(self, question: str) -> float:
        """
        Search Reddit using public JSON endpoints (no API key).
        Uses Reddit's .json suffix on search results.
        """
        q = urllib.parse.quote(question[:60])
        url = f"https://www.reddit.com/search.json?q={q}&sort=relevance&t=week&limit=10"
        data = self._http_get(url, headers={
            "User-Agent": "PredBot/4.0 (prediction market research bot)",
        })
        if not data or "data" not in data:
            return 1.0

        posts = data.get("data", {}).get("children", [])
        if not posts:
            return 1.0

        yes_signals = 0
        no_signals = 0

        for post_wrap in posts:
            post = post_wrap.get("data", {})
            title = post.get("title", "").lower()
            score = max(post.get("score", 1), 1)
            weight = min(score / 100, 3)

            yes_kw = ["will", "likely", "confirmed", "expected", "bullish", "yes",
                       "approved", "passing", "agree", "wins", "success"]
            no_kw = ["won't", "unlikely", "denied", "failed", "bearish", "no",
                      "rejected", "blocked", "disagree", "loses", "crisis"]

            y = sum(1 for k in yes_kw if k in title)
            n = sum(1 for k in no_kw if k in title)
            if y > n:
                yes_signals += weight
            elif n > y:
                no_signals += weight

        if yes_signals + no_signals == 0:
            return 1.0
        return max(0.3, min(3.0, (yes_signals + 0.5) / (no_signals + 0.5)))

    # ═══════════════════════════════════════════
    # PAID SOURCES (optional)
    # ═══════════════════════════════════════════

    def reddit_sentiment_lr(self, question: str) -> float:
        """Reddit via ScrapeCreators (paid)."""
        if not self.scrapecreators_key:
            return 1.0
        url = f"https://api.scrapecreators.com/v2/reddit/search?query={urllib.parse.quote(question)}&sort=relevance&time=month&limit=10"
        data = self._http_get(url, headers={"x-api-key": self.scrapecreators_key})
        if not data:
            return 1.0
        posts = data.get("data", data.get("results", []))
        if not posts:
            return 1.0
        yes_s = 0
        no_s = 0
        for post in posts:
            title = (post.get("title", "") + " " + post.get("selftext", "")).lower()
            score = max(post.get("score", 1), 1)
            weight = min(score / 100, 5)
            y = sum(1 for k in ["will", "likely", "confirmed", "expected", "bullish", "yes", "approved"] if k in title)
            n = sum(1 for k in ["won't", "unlikely", "denied", "failed", "bearish", "no", "rejected"] if k in title)
            if y > n:
                yes_s += weight * post.get("upvote_ratio", 0.5)
            elif n > y:
                no_s += weight * post.get("upvote_ratio", 0.5)
        if yes_s + no_s == 0:
            return 1.0
        return max(0.3, min(3.0, (yes_s + 0.5) / (no_s + 0.5)))

    def web_sentiment_lr(self, question: str) -> float:
        """Web search via Brave (paid)."""
        if not self.brave_api_key:
            return 1.0
        url = f"https://api.search.brave.com/res/v1/web/search?q={urllib.parse.quote(question)}&count=10&freshness=pm"
        data = self._http_get(url, headers={
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": self.brave_api_key,
        })
        if not data:
            return 1.0
        results = data.get("web", {}).get("results", [])
        if not results:
            return 1.0
        yes_s = 0
        no_s = 0
        for r in results:
            text = (r.get("title", "") + " " + r.get("description", "")).lower()
            y = sum(1 for k in ["will", "likely", "expected", "confirms", "approved", "passes", "wins", "rises"] if k in text)
            n = sum(1 for k in ["won't", "unlikely", "fails", "denied", "rejected", "loses", "drops", "blocks"] if k in text)
            if y > n:
                yes_s += 1
            elif n > y:
                no_s += 1
        if yes_s + no_s == 0:
            return 1.0
        return max(0.3, min(3.0, (yes_s + 0.5) / (no_s + 0.5)))

    def x_sentiment_lr(self, question: str) -> float:
        """X/Twitter via xAI (paid)."""
        if not self.xai_api_key:
            return 1.0
        data = self._http_post(
            "https://api.x.ai/v1/chat/completions",
            {
                "model": "grok-3-mini",
                "messages": [{"role": "user", "content": f"Search X/Twitter for recent posts about: {question}. Summarize top 5 with sentiment."}],
                "search_parameters": {"mode": "on", "recency_filter": "month"},
            },
            headers={"Authorization": f"Bearer {self.xai_api_key}"},
        )
        if not data:
            return 1.0
        text = data.get("choices", [{}])[0].get("message", {}).get("content", "").lower()
        if not text:
            return 1.0
        bull = sum(text.count(w) for w in ["bullish", "likely", "confirmed", "positive", "will happen", "yes"])
        bear = sum(text.count(w) for w in ["bearish", "unlikely", "denied", "negative", "won't happen", "no"])
        if bull + bear == 0:
            return 1.0
        return max(0.3, min(3.0, (bull + 0.5) / (bear + 0.5)))

    # ═══════════════════════════════════════════
    # COMBINED RESEARCH PIPELINE
    # ═══════════════════════════════════════════

    def research_market(self, question: str) -> dict:
        """
        Run full research pipeline. Uses all enabled sources.
        Returns combined likelihood ratio and per-source breakdown.
        """
        cache_key = question[:100]
        if cache_key in self.cache:
            cached = self.cache[cache_key]
            if time.time() - cached["timestamp"] < self.cache_ttl:
                return cached["data"]

        results = {}
        combined_lr = 1.0
        sources_used = 0

        # ── Free sources (always run) ──
        source_fns = []

        if "hackernews" in self.enabled_sources:
            source_fns.append(("hackernews", self.hackernews_sentiment_lr))

        if "polymarket_gamma" in self.enabled_sources:
            source_fns.append(("polymarket_gamma", self.polymarket_gamma_lr))

        if "coingecko" in self.enabled_sources:
            source_fns.append(("coingecko", self.coingecko_sentiment_lr))

        if "google_news" in self.enabled_sources:
            source_fns.append(("google_news", self.google_news_lr))

        if "reddit_public" in self.enabled_sources:
            source_fns.append(("reddit_public", self.reddit_public_lr))

        # ── Paid sources (only if keys configured) ──
        if "reddit" in self.enabled_sources and self.scrapecreators_key:
            source_fns.append(("reddit_paid", self.reddit_sentiment_lr))

        if "web" in self.enabled_sources and self.brave_api_key:
            source_fns.append(("web_brave", self.web_sentiment_lr))

        if "x" in self.enabled_sources and self.xai_api_key:
            source_fns.append(("x_twitter", self.x_sentiment_lr))

        # Run all sources with timeout protection
        for name, fn in source_fns:
            try:
                lr = fn(question)
                if lr != 1.0:  # Only count non-neutral results
                    results[name] = {
                        "lr": round(lr, 3),
                        "direction": "YES" if lr > 1 else "NO" if lr < 1 else "NEUTRAL",
                    }
                    combined_lr *= lr
                    sources_used += 1
                    logger.debug(f"  Research [{name}]: LR={lr:.3f}")
                else:
                    results[name] = {"lr": 1.0, "direction": "NEUTRAL"}
            except Exception as e:
                logger.debug(f"  Research [{name}] error: {e}")
                results[name] = {"lr": 1.0, "direction": "ERROR", "error": str(e)[:50]}

        # Normalize combined LR (geometric mean)
        if sources_used > 1:
            combined_lr = combined_lr ** (1.0 / sources_used)

        combined_lr = max(0.2, min(5.0, combined_lr))

        output = {
            "question": question,
            "combined_lr": round(combined_lr, 3),
            "direction": "YES" if combined_lr > 1.05 else "NO" if combined_lr < 0.95 else "NEUTRAL",
            "sources": results,
            "sources_used": sources_used,
            "free_sources": sum(1 for n in results if not n.endswith("_paid") and n not in ("web_brave", "x_twitter")),
            "paid_sources": sum(1 for n in results if n.endswith("_paid") or n in ("web_brave", "x_twitter")),
            "timestamp": time.strftime("%H:%M:%S"),
        }

        self.cache[cache_key] = {"data": output, "timestamp": time.time()}
        return output

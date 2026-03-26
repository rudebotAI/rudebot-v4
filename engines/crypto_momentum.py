"""
Crypto Momentum Engine -- Institutional-Grade Short-Term BTC Price Tracking
============================================================================
Connects Coinbase real-time price data to Kalshi's hourly/15-min BTC prediction
markets. Uses technical indicators (RSI, Bollinger Bands, EMA crossovers, VWAP,
ATR) to estimate directional probabilities for "BTC above $X" contracts.

Institutional Metrics:
- RSI (Relative Strength Index) -- overbought/oversold signals
- Bollinger Band %B -- mean-reversion detection
- EMA 9/21 crossover -- trend confirmation
- VWAP deviation -- institutional fair value
- ATR-normalized moves -- volatility-adjusted signals
- Composite score -> probability estimate for Kalshi crypto contracts

Architecture:
    CoinbaseConnector -> candles -> CryptoMomentumEngine -> probability ->
    EVScanner -> KellySizer -> OrderRouter

Designed as a reusable sub-engine: any future bot can import this module.
"""

import math
import time
import logging
from typing import Optional

logger = logging.getLogger(__name__)


class TechnicalIndicators:
    """
    Stateless technical indicator library.
    All methods are pure functions -- feed in candle data, get indicators out.
    Reusable across any asset class or bot project.
    """

    @staticmethod
    def rsi(closes: list, period: int = 14) -> Optional[float]:
        """
        Relative Strength Index (Wilder's smoothing).

        Returns:
            RSI value 0-100. >70 = overbought, <30 = oversold.
        """
        if len(closes) < period + 1:
            return None

        gains = []
        losses = []
        for i in range(1, len(closes)):
            delta = closes[i] - closes[i - 1]
            gains.append(max(delta, 0))
            losses.append(max(-delta, 0))

        if len(gains) < period:
            return None

        avg_gain = sum(gains[:period]) / period
        avg_loss = sum(losses[:period]) / period

        # Wilder's smoothing for remaining periods
        for i in range(period, len(gains)):
            avg_gain = (avg_gain * (period - 1) + gains[i]) / period
            avg_loss = (avg_loss * (period - 1) + losses[i]) / period

        if avg_loss == 0:
            return 100.0
        rs = avg_gain / avg_loss
        return round(100 - (100 / (1 + rs)), 2)

    @staticmethod
    def bollinger_bands(closes: list, period: int = 20, num_std: float = 2.0) -> Optional[dict]:
        """
        Bollinger Bands with %B position indicator.

        Returns:
            dict with upper, middle (SMA), lower bands, bandwidth, and %B.
            %B > 1 = above upper band, %B < 0 = below lower band.
        """
        if len(closes) < period:
            return None

        window = closes[-period:]
        sma = sum(window) / period
        variance = sum((x - sma) ** 2 for x in window) / period
        std = variance ** 0.5

        upper = sma + num_std * std
        lower = sma - num_std * std
        bandwidth = (upper - lower) / sma if sma > 0 else 0

        current = closes[-1]
        pct_b = (current - lower) / (upper - lower) if (upper - lower) > 0 else 0.5

        return {
            "upper": round(upper, 2),
            "middle": round(sma, 2),
            "lower": round(lower, 2),
            "bandwidth": round(bandwidth, 4),
            "pct_b": round(pct_b, 4),
            "price": current,
        }

    @staticmethod
    def ema(values: list, period: int) -> list:
        """
        Exponential Moving Average.
        Returns full EMA series (same length as input).
        """
        if len(values) < period:
            return []

        multiplier = 2.0 / (period + 1)
        ema_values = [sum(values[:period]) / period]  # Seed with SMA

        for i in range(period, len(values)):
            ema_values.append(values[i] * multiplier + ema_values[-1] * (1 - multiplier))

        return ema_values

    @staticmethod
    def ema_crossover(closes: list, fast: int = 9, slow: int = 21) -> Optional[dict]:
        """
        EMA crossover signal.

        Returns:
            dict with fast_ema, slow_ema, spread, signal (BULLISH/BEARISH/NEUTRAL),
            and crossover_strength (normalized spread).
        """
        if len(closes) < slow + 2:
            return None

        fast_ema = TechnicalIndicators.ema(closes, fast)
        slow_ema = TechnicalIndicators.ema(closes, slow)

        if not fast_ema or not slow_ema:
            return None

        current_fast = fast_ema[-1]
        current_slow = slow_ema[-1]
        spread = current_fast - current_slow

        # Normalize spread by price for cross-asset comparability
        price = closes[-1]
        normalized_spread = spread / price * 100 if price > 0 else 0

        # Detect recent crossover (within last 3 periods)
        recent_cross = False
        if len(fast_ema) >= 3 and len(slow_ema) >= 3:
            for i in range(-3, -1):
                try:
                    prev_spread = fast_ema[i] - slow_ema[i]
                    if (prev_spread < 0 and spread > 0) or (prev_spread > 0 and spread < 0):
                        recent_cross = True
                except IndexError:
                    pass

        signal = "BULLISH" if spread > 0 else "BEARISH" if spread < 0 else "NEUTRAL"

        return {
            "fast_ema": round(current_fast, 2),
            "slow_ema": round(current_slow, 2),
            "spread": round(spread, 2),
            "normalized_spread": round(normalized_spread, 4),
            "signal": signal,
            "recent_crossover": recent_cross,
        }

    @staticmethod
    def vwap(candles: list) -> Optional[dict]:
        """
        Volume Weighted Average Price.
        Candles format: [time, low, high, open, close, volume]

        Returns:
            dict with vwap, deviation from current price, and signal.
        """
        if len(candles) < 2:
            return None

        cum_vol = 0
        cum_tp_vol = 0

        for c in candles:
            try:
                low, high, close, volume = c[1], c[2], c[4], c[5]
                typical_price = (high + low + close) / 3
                cum_vol += volume
                cum_tp_vol += typical_price * volume
            except (IndexError, TypeError):
                continue

        if cum_vol <= 0:
            return None

        vwap_val = cum_tp_vol / cum_vol
        current = candles[0][4] if candles else 0  # Most recent close
        deviation = (current - vwap_val) / vwap_val * 100 if vwap_val > 0 else 0

        return {
            "vwap": round(vwap_val, 2),
            "price": round(current, 2),
            "deviation_pct": round(deviation, 4),
            "signal": "ABOVE_VWAP" if deviation > 0.1 else "BELOW_VWAP" if deviation < -0.1 else "AT_VWAP",
        }

    @staticmethod
    def atr(candles: list, period: int = 14) -> Optional[dict]:
        """
        Average True Range -- volatility measure.
        Candles format: [time, low, high, open, close, volume]

        Returns:
            dict with atr value, atr_pct (normalized), and volatility regime.
        """
        if len(candles) < period + 1:
            return None

        true_ranges = []
        for i in range(len(candles) - 1):
            try:
                high = candles[i][2]
                low = candles[i][1]
                prev_close = candles[i + 1][4]
                tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
                true_ranges.append(tr)
            except (IndexError, TypeError):
                continue

        if len(true_ranges) < period:
            return None

        atr_val = sum(true_ranges[:period]) / period
        # Wilder's smoothing
        for tr in true_ranges[period:]:
            atr_val = (atr_val * (period - 1) + tr) / period

        price = candles[0][4] if candles else 1
        atr_pct = atr_val / price * 100 if price > 0 else 0

        regime = "HIGH" if atr_pct > 2.0 else "LOW" if atr_pct < 0.5 else "NORMAL"

        return {
            "atr": round(atr_val, 2),
            "atr_pct": round(atr_pct, 4),
            "regime": regime,
            "price": round(price, 2),
        }

    @staticmethod
    def momentum_score(closes: list, periods: list = None) -> Optional[dict]:
        """
        Multi-timeframe momentum score.
        Computes rate-of-change across multiple lookback windows.

        Returns:
            dict with individual ROCs and composite momentum score (-100 to +100).
        """
        periods = periods or [5, 10, 20]
        if len(closes) < max(periods) + 1:
            return None

        rocs = {}
        score = 0
        weights = {5: 0.5, 10: 0.3, 20: 0.2}  # Recent periods weighted higher

        for p in periods:
            if len(closes) > p:
                roc = (closes[-1] - closes[-(p + 1)]) / closes[-(p + 1)] * 100
                rocs[f"roc_{p}"] = round(roc, 4)
                weight = weights.get(p, 1.0 / len(periods))
                score += roc * weight

        # Normalize to -100..+100
        score = max(-100, min(100, score * 10))

        return {
            "rocs": rocs,
            "composite_score": round(score, 2),
            "signal": "STRONG_UP" if score > 50 else "UP" if score > 10 else
                      "STRONG_DOWN" if score < -50 else "DOWN" if score < -10 else "NEUTRAL",
        }


class CryptoMomentumEngine:
    """
    Connects Coinbase price data to Kalshi BTC prediction markets.

    Pipeline:
    1. Fetch 5-min candles from Coinbase
    2. Compute institutional-grade technical indicators
    3. Generate composite directional probability
    4. Match against Kalshi hourly/15-min BTC contracts
    5. Feed enhanced opportunities into EV scanner

    Config keys (under 'crypto_momentum' in config.yaml):
        enabled: true
        assets: [BTC-USD, ETH-USD]
        candle_granularity: 300  (seconds; 300=5min)
        candle_lookback: 100
        rsi_period: 14
        bb_period: 20
        ema_fast: 9
        ema_slow: 21
        confidence_threshold: 0.55  (minimum directional confidence to signal)
    """

    def __init__(self, coinbase_connector, config: dict = None):
        config = config or {}
        self.coinbase = coinbase_connector
        self.assets = config.get("assets", ["BTC-USD"])
        self.granularity = config.get("candle_granularity", 300)
        self.lookback = config.get("candle_lookback", 100)
        self.rsi_period = config.get("rsi_period", 14)
        self.bb_period = config.get("bb_period", 20)
        self.ema_fast = config.get("ema_fast", 9)
        self.ema_slow = config.get("ema_slow", 21)
        self.confidence_threshold = config.get("confidence_threshold", 0.55)
        self.indicators = TechnicalIndicators()

        # Signal history for tracking accuracy
        self._signal_history = []
        self._cache = {}
        self._cache_ttl = config.get("cache_ttl", 30)

    def analyze_asset(self, product_id: str = "BTC-USD") -> Optional[dict]:
        """
        Full technical analysis on a single asset.
        Returns all indicators + composite directional probability.
        """
        # Check cache
        cache_key = f"{product_id}_{self.granularity}"
        if cache_key in self._cache:
            cached = self._cache[cache_key]
            if time.time() - cached["ts"] < self._cache_ttl:
                return cached["data"]

        # Fetch candles
        candles = self.coinbase.get_candles(
            product_id=product_id,
            granularity=self.granularity,
            limit=self.lookback,
        )
        if not candles or len(candles) < 15:
            logger.warning(f"Insufficient candle data for {product_id}: {len(candles) if candles else 0}")
            return None

        # Candles are [time, low, high, open, close, volume] newest first
        # Reverse for indicator calculations (oldest first)
        candles_asc = list(reversed(candles))
        closes = [c[4] for c in candles_asc]

        # ── Compute all indicators ──
        rsi = self.indicators.rsi(closes, self.rsi_period)
        bb = self.indicators.bollinger_bands(closes, self.bb_period)
        ema_cross = self.indicators.ema_crossover(closes, self.ema_fast, self.ema_slow)
        vwap = self.indicators.vwap(candles)  # Newest first for VWAP
        atr = self.indicators.atr(candles, 14)
        momentum = self.indicators.momentum_score(closes)

        # ── Composite probability estimate ──
        prob = self._compute_directional_probability(rsi, bb, ema_cross, vwap, atr, momentum)

        current_price = closes[-1] if closes else 0
        price_1h_ago = closes[-12] if len(closes) >= 12 else closes[0]
        pct_change_1h = (current_price - price_1h_ago) / price_1h_ago * 100 if price_1h_ago > 0 else 0

        analysis = {
            "product": product_id,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "current_price": round(current_price, 2),
            "pct_change_1h": round(pct_change_1h, 3),
            "candle_count": len(candles),
            "granularity_sec": self.granularity,
            "indicators": {
                "rsi": rsi,
                "bollinger": bb,
                "ema_crossover": ema_cross,
                "vwap": vwap,
                "atr": atr,
                "momentum": momentum,
            },
            "directional_prob": prob,
            "signal": self._classify_signal(prob),
            "confidence": round(abs(prob - 0.5) * 2, 4),  # 0-1 scale
        }

        # Cache
        self._cache[cache_key] = {"data": analysis, "ts": time.time()}

        logger.info(
            f"[CRYPTO] {product_id}: ${current_price:,.2f} | "
            f"RSI={rsi} | BB%B={bb['pct_b'] if bb else 'N/A'} | "
            f"EMA={ema_cross['signal'] if ema_cross else 'N/A'} | "
            f"Prob={prob:.3f} -> {analysis['signal']}"
        )

        return analysis

    def _compute_directional_probability(
        self, rsi, bb, ema_cross, vwap, atr, momentum
    ) -> float:
        """
        Combine all indicators into a single directional probability.
        Output: 0.0 (certain DOWN) to 1.0 (certain UP).

        Weighting scheme (institutional-grade):
            - Momentum/Trend (EMA, momentum score):  35%
            - Mean reversion (RSI, BB):               30%
            - Volume/Value (VWAP):                    20%
            - Volatility regime (ATR):                15%
        """
        signals = []
        weights = []

        # ── Trend signals (35%) ──
        if ema_cross:
            # Convert EMA spread to probability
            spread = ema_cross.get("normalized_spread", 0)
            ema_prob = 0.5 + max(-0.3, min(0.3, spread * 0.15))
            if ema_cross.get("recent_crossover"):
                ema_prob = 0.5 + (ema_prob - 0.5) * 1.5  # Amplify crossover signal
            signals.append(ema_prob)
            weights.append(0.20)

        if momentum:
            score = momentum.get("composite_score", 0)
            mom_prob = 0.5 + max(-0.3, min(0.3, score / 200))
            signals.append(mom_prob)
            weights.append(0.15)

        # ── Mean reversion signals (30%) ──
        if rsi is not None:
            # RSI -> probability (inverted: high RSI = likely reversal DOWN)
            if rsi > 70:
                rsi_prob = 0.5 - (rsi - 70) / 100  # Overbought -> slight bearish
            elif rsi < 30:
                rsi_prob = 0.5 + (30 - rsi) / 100  # Oversold -> slight bullish
            else:
                # Neutral zone: slight trend-following
                rsi_prob = 0.5 + (rsi - 50) / 200
            signals.append(max(0.2, min(0.8, rsi_prob)))
            weights.append(0.15)

        if bb:
            pct_b = bb.get("pct_b", 0.5)
            # Mean reversion: extreme %B -> expect revert
            if pct_b > 0.9:
                bb_prob = 0.5 - (pct_b - 0.9) * 2  # Above upper band -> bearish
            elif pct_b < 0.1:
                bb_prob = 0.5 + (0.1 - pct_b) * 2  # Below lower band -> bullish
            else:
                bb_prob = 0.5 + (pct_b - 0.5) * 0.2  # Slight trend-follow in middle
            signals.append(max(0.2, min(0.8, bb_prob)))
            weights.append(0.15)

        # ── Volume/Value signals (20%) ──
        if vwap:
            dev = vwap.get("deviation_pct", 0)
            # Price above VWAP = bullish, below = bearish
            vwap_prob = 0.5 + max(-0.2, min(0.2, dev * 0.1))
            signals.append(vwap_prob)
            weights.append(0.20)

        # ── Volatility regime (15%) ──
        if atr:
            regime = atr.get("regime", "NORMAL")
            # High volatility -> more extreme probabilities (confidence boost)
            # Low volatility -> compress toward 0.5
            vol_multiplier = 1.3 if regime == "HIGH" else 0.7 if regime == "LOW" else 1.0
            # Apply as weight modifier rather than direct signal
            for i in range(len(weights)):
                weights[i] *= vol_multiplier

        # ── Weighted combination ──
        if not signals:
            return 0.5

        total_weight = sum(weights)
        if total_weight == 0:
            return 0.5

        weighted_prob = sum(s * w for s, w in zip(signals, weights)) / total_weight

        # Bound to 0.15-0.85 (never be >85% confident on short-term crypto)
        return round(max(0.15, min(0.85, weighted_prob)), 4)

    def _classify_signal(self, prob: float) -> str:
        """Classify probability into a trading signal."""
        if prob >= 0.70:
            return "STRONG_BULLISH"
        elif prob >= 0.58:
            return "BULLISH"
        elif prob <= 0.30:
            return "STRONG_BEARISH"
        elif prob <= 0.42:
            return "BEARISH"
        return "NEUTRAL"

    def match_kalshi_crypto_markets(self, kalshi_markets: list, analysis: dict) -> list:
        """
        Filter Kalshi markets to find BTC hourly/15-min price contracts
        and inject our model probability.

        Kalshi BTC markets typically have titles like:
        - "Bitcoin above $87,000 at 4 PM ET?"
        - "BTC above 85.5K?"

        Returns:
            List of enhanced market dicts with model_prob injected.
        """
        if not analysis:
            return []

        current_price = analysis.get("current_price", 0)
        direction_prob = analysis.get("directional_prob", 0.5)
        atr_data = analysis.get("indicators", {}).get("atr")

        btc_keywords = ["bitcoin", "btc", "crypto"]
        price_markets = []

        for m in kalshi_markets:
            question = m.get("question", "").lower()

            # Filter for BTC price markets
            is_btc = any(kw in question for kw in btc_keywords)
            if not is_btc:
                continue

            # Try to extract strike price from the question
            strike = self._extract_strike_price(question)
            if strike is None:
                continue

            # Compute probability that BTC will be above strike
            model_prob = self._price_probability(
                current_price, strike, direction_prob, atr_data
            )

            enhanced = {
                **m,
                "model_prob": model_prob,
                "strike_price": strike,
                "current_btc_price": current_price,
                "btc_direction": analysis.get("signal", "NEUTRAL"),
                "momentum_indicators": {
                    "rsi": analysis["indicators"].get("rsi"),
                    "ema_signal": analysis["indicators"].get("ema_crossover", {}).get("signal"),
                    "momentum_score": analysis["indicators"].get("momentum", {}).get("composite_score"),
                },
                "crypto_engine": True,  # Flag for scanner to know this came from momentum engine
            }
            price_markets.append(enhanced)

            logger.debug(
                f"  BTC market: {m.get('question', '')[:60]} | "
                f"strike=${strike:,.0f} | model_prob={model_prob:.3f}"
            )

        price_markets.sort(key=lambda x: abs(x["model_prob"] - x.get("yes_price", 0.5)), reverse=True)
        return price_markets

    def _extract_strike_price(self, question: str) -> Optional[float]:
        """
        Extract the dollar strike price from a Kalshi market question.
        Handles formats like: "$87,000", "87K", "$87.5K", "87000"
        """
        import re

        # Pattern: $XX,XXX or $XX.XK or XXXK or plain number
        patterns = [
            r'\$?([\d,]+(?:\.\d+)?)\s*(?:k|K)',           # "87.5K" or "$87K"
            r'\$?([\d]{2,3}(?:,\d{3})+(?:\.\d+)?)',       # "$87,000" or "87,000"
            r'\$?([\d]{4,6}(?:\.\d+)?)',                    # "$87000" or "87000"
        ]

        for pattern in patterns:
            match = re.search(pattern, question)
            if match:
                val_str = match.group(1).replace(",", "")
                try:
                    val = float(val_str)
                    # If it ends with K, multiply
                    if "k" in question[match.start():match.end() + 2].lower():
                        val *= 1000
                    # Sanity check: BTC should be between $1K and $1M
                    if 1000 < val < 1_000_000:
                        return val
                except ValueError:
                    continue

        return None

    def _price_probability(
        self, current: float, strike: float, direction_prob: float,
        atr_data: Optional[dict]
    ) -> float:
        """
        Estimate probability that BTC will be above 'strike' at contract expiry.

        Uses a log-normal model centered on current price, biased by direction_prob,
        with volatility estimated from ATR.

        This is a simplified version of what institutional desks use for
        short-dated binary options pricing.
        """
        if current <= 0 or strike <= 0:
            return 0.5

        # Distance from strike as % of price
        distance_pct = (strike - current) / current

        # Estimate hourly volatility from ATR
        if atr_data and atr_data.get("atr_pct"):
            # ATR is typically for the candle period; annualize then hourly-ize
            hourly_vol = atr_data["atr_pct"] / 100 * 0.5  # Rough hourly vol
        else:
            hourly_vol = 0.01  # Default 1% hourly vol for BTC

        # Z-score: how many standard deviations is strike from current
        if hourly_vol > 0:
            z = distance_pct / hourly_vol
        else:
            z = distance_pct * 100

        # Apply directional bias from technical indicators
        # direction_prob > 0.5 means we think price goes UP
        bias = (direction_prob - 0.5) * 2  # -1 to +1

        # Adjusted z-score (shift distribution by our directional view)
        z_adjusted = z - bias * 0.5

        # Convert to probability using logistic function (approximation of normal CDF)
        # P(above strike) = 1 - Φ(z) ~ sigmoid(-z)
        prob = 1.0 / (1.0 + math.exp(z_adjusted * 2.5))

        # Bound: never be more than 90% or less than 10% confident
        return round(max(0.10, min(0.90, prob)), 4)

    def generate_opportunities(self, kalshi_markets: list) -> list:
        """
        Full pipeline: analyze BTC -> match markets -> return enhanced opportunities.
        Called from main bot's _tick() method.
        """
        all_opportunities = []

        for asset in self.assets:
            analysis = self.analyze_asset(asset)
            if not analysis:
                continue

            # Store signal for accuracy tracking
            self._signal_history.append({
                "time": time.time(),
                "asset": asset,
                "price": analysis["current_price"],
                "signal": analysis["signal"],
                "prob": analysis["directional_prob"],
            })

            # Only keep last 500 signals
            self._signal_history = self._signal_history[-500:]

            # Match against Kalshi markets
            matched = self.match_kalshi_crypto_markets(kalshi_markets, analysis)
            all_opportunities.extend(matched)

            logger.info(
                f"[CRYPTO] {asset}: {len(matched)} matching Kalshi markets found | "
                f"Signal={analysis['signal']} | Confidence={analysis['confidence']:.2f}"
            )

        return all_opportunities

    def get_signal_accuracy(self) -> dict:
        """
        Compute historical accuracy of directional signals.
        Checks if price actually moved in predicted direction.
        """
        if len(self._signal_history) < 10:
            return {"accuracy": 0, "total_signals": len(self._signal_history), "insufficient_data": True}

        correct = 0
        total = 0
        for i in range(len(self._signal_history) - 1):
            s = self._signal_history[i]
            next_s = self._signal_history[i + 1]
            if next_s["asset"] != s["asset"]:
                continue

            predicted_up = s["prob"] > 0.5
            actual_up = next_s["price"] > s["price"]
            if predicted_up == actual_up:
                correct += 1
            total += 1

        accuracy = correct / total * 100 if total > 0 else 0
        return {
            "accuracy": round(accuracy, 1),
            "correct": correct,
            "total_signals": total,
            "insufficient_data": False,
        }

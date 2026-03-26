"""
WebSocket Feed Engine -- Real-Time Data Streams
================================================
Replaces REST polling with WebSocket connections for:
- Binance BTC/ETH/SOL/XRP tick data (1s klines + trades)
- Polymarket CLOB orderbook (live bids/asks)

Architecture pattern from reference bots (polyrec, 4coinsbot):
  WebSocket -> callback -> shared state dict -> strategy engines read latest

Thread-safe: uses threading.Lock for state updates.
"""

import json
import time
import logging
import threading
from typing import Optional, Callable

logger = logging.getLogger(__name__)

# Binance WebSocket streams
BINANCE_WS = "wss://stream.binance.com:9443/ws"
BINANCE_STREAM = "wss://stream.binance.com:9443/stream"

# Polymarket WebSocket
POLYMARKET_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market"


class WebSocketFeed:
    """
    Real-time market data aggregator via WebSocket.

    Maintains a shared state dict with latest prices, orderbooks,
    and derived metrics (microprice, spread, imbalance).

    Usage:
        feed = WebSocketFeed(config)
        feed.start()  # Background threads
        ...
        data = feed.get_latest("BTC-USD")
        feed.stop()
    """

    def __init__(self, config: dict = None):
        config = config or {}
        self.enabled = config.get("enabled", True)
        self.assets = config.get("assets", ["btcusdt"])
        self.polymarket_tokens = config.get("polymarket_tokens", [])

        # Shared state -- thread-safe reads/writes
        self._lock = threading.Lock()
        self._state = {}  # {symbol: {price, bid, ask, volume, ts, ...}}
        self._orderbooks = {}  # {token_id: {bids: [], asks: []}}
        self._callbacks = []  # External listeners

        # Connection tracking
        self._threads = []
        self._running = False
        self._reconnect_delay = 1
        self._max_reconnect_delay = 60

        # Metrics
        self._msg_count = 0
        self._last_msg_time = 0
        self._errors = 0

    def start(self):
        """Start all WebSocket feeds in background threads."""
        if not self.enabled:
            logger.info("WebSocket feeds disabled")
            return

        self._running = True

        # Start Binance feeds
        for asset in self.assets:
            symbol = asset.lower().replace("-", "")
            if not symbol.endswith("usdt"):
                symbol = symbol.replace("usd", "usdt")

            t = threading.Thread(
                target=self._binance_stream,
                args=(symbol,),
                daemon=True,
                name=f"ws-binance-{symbol}",
            )
            t.start()
            self._threads.append(t)
            logger.info(f"WebSocket started: Binance {symbol}")

        # Start Polymarket orderbook feed
        if self.polymarket_tokens:
            t = threading.Thread(
                target=self._polymarket_stream,
                daemon=True,
                name="ws-polymarket",
            )
            t.start()
            self._threads.append(t)
            logger.info(f"WebSocket started: Polymarket ({len(self.polymarket_tokens)} tokens)")

        logger.info(f"WebSocket feed engine started: {len(self._threads)} streams")

    def stop(self):
        """Stop all feeds."""
        self._running = False
        for t in self._threads:
            t.join(timeout=5)
        self._threads.clear()
        logger.info("WebSocket feeds stopped")

    def add_callback(self, fn: Callable):
        """Register a callback for tick updates: fn(symbol, data)."""
        self._callbacks.append(fn)

    # ── Public API ──

    def get_latest(self, symbol: str) -> Optional[dict]:
        """Get latest price data for a symbol."""
        key = symbol.upper().replace("-", "")
        with self._lock:
            return self._state.get(key, None)

    def get_orderbook(self, token_id: str) -> Optional[dict]:
        """Get latest Polymarket orderbook for a token."""
        with self._lock:
            return self._orderbooks.get(token_id, None)

    def get_microprice(self, token_id: str) -> Optional[float]:
        """
        Compute microprice from orderbook -- better than midpoint.
        Microprice = (bid_size * ask_price + ask_size * bid_price) / (bid_size + ask_size)
        """
        book = self.get_orderbook(token_id)
        if not book:
            return None

        bids = book.get("bids", [])
        asks = book.get("asks", [])
        if not bids or not asks:
            return None

        best_bid_price = bids[0][0]
        best_bid_size = bids[0][1]
        best_ask_price = asks[0][0]
        best_ask_size = asks[0][1]

        total_size = best_bid_size + best_ask_size
        if total_size <= 0:
            return (best_bid_price + best_ask_price) / 2

        microprice = (best_bid_size * best_ask_price + best_ask_size * best_bid_price) / total_size
        return round(microprice, 6)

    def get_spread(self, token_id: str) -> Optional[float]:
        """Get current bid-ask spread for a token."""
        book = self.get_orderbook(token_id)
        if not book:
            return None
        bids = book.get("bids", [])
        asks = book.get("asks", [])
        if not bids or not asks:
            return None
        return round(asks[0][0] - bids[0][0], 6)

    def get_imbalance(self, token_id: str) -> Optional[float]:
        """
        Orderbook imbalance -- predictive of short-term direction.
        +1 = all bid pressure, -1 = all ask pressure.
        """
        book = self.get_orderbook(token_id)
        if not book:
            return None
        bids = book.get("bids", [])
        asks = book.get("asks", [])
        bid_vol = sum(b[1] for b in bids[:5])
        ask_vol = sum(a[1] for a in asks[:5])
        total = bid_vol + ask_vol
        if total <= 0:
            return 0.0
        return round((bid_vol - ask_vol) / total, 4)

    def get_stats(self) -> dict:
        """Feed health stats."""
        return {
            "running": self._running,
            "streams": len(self._threads),
            "msg_count": self._msg_count,
            "errors": self._errors,
            "symbols_tracked": len(self._state),
            "orderbooks_tracked": len(self._orderbooks),
            "last_msg_age_sec": round(time.time() - self._last_msg_time, 1) if self._last_msg_time else None,
        }

    def is_healthy(self) -> bool:
        """Check if feeds are receiving data."""
        if not self._running:
            return False
        if self._last_msg_time == 0:
            return False
        return (time.time() - self._last_msg_time) < 30

    # ── Binance Stream ──

    def _binance_stream(self, symbol: str):
        """Connect to Binance WebSocket for a symbol (kline + miniTicker)."""
        try:
            import websocket
        except ImportError:
            logger.warning("websocket-client not installed -- falling back to REST. Install: pip install websocket-client")
            self._binance_rest_fallback(symbol)
            return

        streams = f"{symbol}@kline_1s/{symbol}@miniTicker"
        url = f"{BINANCE_STREAM}?streams={streams}"

        while self._running:
            try:
                ws = websocket.WebSocketApp(
                    url,
                    on_message=lambda ws, msg: self._on_binance_msg(msg, symbol),
                    on_error=lambda ws, err: self._on_error("binance", err),
                    on_close=lambda ws, code, msg: logger.debug(f"Binance WS closed: {code}"),
                )
                ws.run_forever(ping_interval=30, ping_timeout=10)
            except Exception as e:
                self._errors += 1
                logger.warning(f"Binance WS error ({symbol}): {e}")

            if self._running:
                delay = min(self._reconnect_delay, self._max_reconnect_delay)
                logger.info(f"Reconnecting Binance {symbol} in {delay}s...")
                time.sleep(delay)
                self._reconnect_delay = min(self._reconnect_delay * 2, self._max_reconnect_delay)

    def _on_binance_msg(self, msg: str, symbol: str):
        """Process Binance WebSocket message."""
        try:
            data = json.loads(msg)
            # Combined stream format: {"stream": "...", "data": {...}}
            if "data" in data:
                data = data["data"]

            event = data.get("e", "")
            key = symbol.upper()

            if event == "kline":
                k = data["k"]
                update = {
                    "price": float(k["c"]),
                    "open": float(k["o"]),
                    "high": float(k["h"]),
                    "low": float(k["l"]),
                    "volume": float(k["v"]),
                    "trades": int(k["n"]),
                    "ts": time.time(),
                    "source": "binance_ws",
                    "interval": k["i"],
                }
                with self._lock:
                    self._state[key] = {**self._state.get(key, {}), **update}

            elif event == "24hrMiniTicker":
                update = {
                    "price": float(data.get("c", 0)),
                    "volume_24h": float(data.get("v", 0)),
                    "quote_volume_24h": float(data.get("q", 0)),
                    "ts": time.time(),
                    "source": "binance_ws",
                }
                with self._lock:
                    self._state[key] = {**self._state.get(key, {}), **update}

            self._msg_count += 1
            self._last_msg_time = time.time()
            self._reconnect_delay = 1

            # Fire callbacks
            for cb in self._callbacks:
                try:
                    cb(key, self._state.get(key, {}))
                except Exception:
                    pass

        except Exception as e:
            logger.debug(f"Binance msg parse error: {e}")

    def _binance_rest_fallback(self, symbol: str):
        """
        REST polling fallback if websocket-client not available.
        Polls every 2 seconds -- much less efficient but works everywhere.
        Stops polling after 3 consecutive failures (API unreachable).
        """
        import urllib.request
        url = f"https://api.binance.com/api/v3/ticker/price?symbol={symbol.upper()}"
        logger.info(f"Binance REST fallback active for {symbol}")
        consecutive_failures = 0

        while self._running:
            try:
                req = urllib.request.Request(url, headers={"Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=3) as resp:
                    data = json.loads(resp.read().decode())
                    key = symbol.upper()
                    update = {
                        "price": float(data.get("price", 0)),
                        "ts": time.time(),
                        "source": "binance_rest",
                    }
                    with self._lock:
                        self._state[key] = {**self._state.get(key, {}), **update}
                    self._msg_count += 1
                    self._last_msg_time = time.time()
                    consecutive_failures = 0
            except Exception as e:
                consecutive_failures += 1
                self._errors += 1
                if consecutive_failures >= 3:
                    logger.warning(f"Binance REST unreachable for {symbol} -- stopping poll thread")
                    return
                logger.debug(f"Binance REST poll error: {e}")

            time.sleep(2)

    # ── Polymarket Stream ──

    def _polymarket_stream(self):
        """Connect to Polymarket CLOB WebSocket for orderbook updates."""
        try:
            import websocket
        except ImportError:
            logger.warning("websocket-client not installed -- Polymarket WS disabled")
            return

        while self._running:
            try:
                ws = websocket.WebSocketApp(
                    POLYMARKET_WS,
                    on_open=lambda ws: self._poly_subscribe(ws),
                    on_message=lambda ws, msg: self._on_poly_msg(msg),
                    on_error=lambda ws, err: self._on_error("polymarket", err),
                    on_close=lambda ws, code, msg: logger.debug(f"Polymarket WS closed: {code}"),
                )
                ws.run_forever(ping_interval=30, ping_timeout=10)
            except Exception as e:
                self._errors += 1
                logger.warning(f"Polymarket WS error: {e}")

            if self._running:
                delay = min(self._reconnect_delay, self._max_reconnect_delay)
                logger.info(f"Reconnecting Polymarket in {delay}s...")
                time.sleep(delay)
                self._reconnect_delay = min(self._reconnect_delay * 2, self._max_reconnect_delay)

    def _poly_subscribe(self, ws):
        """Subscribe to orderbook channels for tracked tokens."""
        for token_id in self.polymarket_tokens:
            msg = json.dumps({
                "type": "market",
                "assets_ids": [token_id],
            })
            ws.send(msg)
            logger.debug(f"Subscribed to Polymarket token: {token_id[:16]}...")

    def _on_poly_msg(self, msg: str):
        """Process Polymarket orderbook update."""
        try:
            data = json.loads(msg)
            event_type = data.get("event_type", "")

            if event_type in ("book", "price_change", "tick_size_change"):
                asset_id = data.get("asset_id", "")
                if not asset_id:
                    return

                # Parse orderbook
                bids = []
                asks = []
                for entry in data.get("bids", []):
                    bids.append([float(entry.get("price", 0)), float(entry.get("size", 0))])
                for entry in data.get("asks", []):
                    asks.append([float(entry.get("price", 0)), float(entry.get("size", 0))])

                # Sort: bids descending, asks ascending
                bids.sort(key=lambda x: x[0], reverse=True)
                asks.sort(key=lambda x: x[0])

                book = {
                    "bids": bids,
                    "asks": asks,
                    "ts": time.time(),
                    "mid": (bids[0][0] + asks[0][0]) / 2 if bids and asks else None,
                }

                with self._lock:
                    self._orderbooks[asset_id] = book

                self._msg_count += 1
                self._last_msg_time = time.time()

        except Exception as e:
            logger.debug(f"Polymarket msg parse error: {e}")

    def _on_error(self, source: str, error):
        """Handle WebSocket error."""
        self._errors += 1
        logger.warning(f"WebSocket error ({source}): {error}")

# Prediction Bot Reference Knowledge Base
## Extracted from txbabaxyz GitHub repos — March 2026

This document consolidates architecture, strategies, APIs, and patterns from 5 production Polymarket trading systems. Use as reference when building or improving prediction market bots.

---

## 1. polyterminal — Live Trading Terminal

**Purpose:** Manual/semi-automated trading terminal for Polymarket 15-minute crypto prediction markets (BTC, ETH, SOL, XRP).

### Key Architecture
- **Entry point:** `launcher.py` (menu) → `trade.py` (main trading)
- **Auth:** Polygon wallet private key + signature type (EOA / POLY_PROXY / POLY_GNOSIS_SAFE)
- **Data feed:** WebSocket subscriptions for real-time orderbook from Polymarket
- **Execution:** py-clob-client SDK for order placement on Polygon chain
- **Notifications:** Telegram bot with remote control (`/status`, `/balance`, `/redeemall`, `/stop`, `/restart`)

### Config Pattern (.env)
```
PRIVATE_KEY=0x...
SIGNATURE_TYPE=0  # 0=EOA, 1=POLY_PROXY (Magic Link), 2=POLY_GNOSIS_SAFE (MetaMask)
FUNDER_ADDRESS=   # Only for types 1/2
CONTRACTS_SIZE=10 # Position size in contracts
RPC_URL=https://polygon-rpc.com  # Use Alchemy/Ankr for stability
```

### Trading Controls (Hotkeys)
| Key | Action |
|-----|--------|
| 1 | BUY UP (bet on price increase) |
| 2 | BUY DOWN (bet on price decrease) |
| S/D | Increase/decrease position size |
| F | Toggle FOK/FAK mode |
| R | Refresh balance |
| M | Menu (Redeem/Settings) |
| C | Switch cryptocurrency |

### Key Files
| File | Purpose |
|------|---------|
| `trade.py` | Main trading logic |
| `redeem.py` / `redeemall.py` | Winnings collection |
| `set_allowances.py` | First-time USDC contract permissions |
| `generate_keys.py` | API key generation |
| `telegram_bot.py` | Remote control |
| `redeem_lock.py` | File lock for concurrent redeems |

### Important Notes
- Uses **USDC (Bridged)**, NOT USDC.e (Native) — swap on QuickSwap if needed
- Needs small POL/MATIC balance for gas fees
- Log rotation: 3-hour files in `logs/`
- `negRisk` flag matters for signature → toggle if "invalid signature" errors

---

## 2. polyrec — Real-Time Dashboard + Backtesting

**Purpose:** Data collection dashboard aggregating Chainlink oracle, Binance, and Polymarket orderbook for BTC 15-min markets. Includes backtesting tools.

### Data Sources (Critical for any Polymarket bot)
| Source | Type | URL |
|----------|-------|-----|
| Binance | WebSocket | `wss://stream.binance.com:9443/ws/btcusdt@kline_1s` |
| Polymarket Orderbook | WebSocket | `wss://ws-subscriptions-clob.polymarket.com/ws/market` |
| Polymarket Gamma API | REST | `https://gamma-api.polymarket.com` |
| Chainlink Oracle | External | Via Polymarket RTDS (`wss://ws-live-data.polymarket.com`) |

### CSV Log Format (70+ columns per market)
- **Timestamps:** `timestamp_ms`, `timestamp_et`, `seconds_till_end`
- **Prices:** `oracle_btc_price`, `binance_btc_price`, `lag`
- **Returns:** `binance_ret1s_x100`, `binance_ret5s_x100`
- **Volume:** `binance_volume_1s`, `binance_volume_5s`, `binance_volma_30s`
- **Volatility:** `binance_atr_5s`, `binance_atr_30s`, `binance_rvol_30s`
- **Orderbook:** 5 levels of bids/asks for UP and DOWN markets
- **Analytics:** `spread`, `imbalance`, `microprice`, `slope`, `eat-flow`

### Backtesting Strategies
1. **`replicate_balance.py`** — Balance replication strategy simulator
2. **`fade_impulse_backtest.py`** — Impulse fade strategy (contrarian)
3. **`visualize_fade_impulse.py`** — Strategy visualization

### Key Insight: Chainlink Oracle as Ground Truth
The dashboard uses the Chainlink BTC/USD oracle price (via Polymarket RTDS WebSocket) as the reference price, comparing it against Binance and Polymarket orderbook prices. The lag between these sources IS the edge.

---

## 3. 4coinsbot — Multi-Coin Automated Trading (Late Entry V3)

**Purpose:** Fully automated bot trading BTC/ETH/SOL/XRP in parallel on Polymarket 15-min markets. This is the most production-ready reference.

### Architecture
```
┌────────────────────────────────────────┐
│           MAIN TRADING LOOP             │
├─────────────────────────────────────────┤
│  BTC Trader | ETH Trader | SOL | XRP   │
│       └──────────┬──────────┘           │
│         Order Executor | Data Feed      │
└─────────────────────────────────────────┘
```

### Late Entry V3 Strategy (THE CORE STRATEGY)
1. **Entry Window:** Only enter in the **last 4 minutes** (240 seconds) before market close
2. **Favorite Detection:** Buy the side with **higher ask price** (market consensus)
3. **Confidence Filter:** Only enter when price difference exceeds **30%**
4. **Time-based Sizing:**
   - Above 180s remaining → 8 contracts
   - Above 120s remaining → 10 contracts
   - Below 120s remaining → 12 contracts (more aggressive closer to close)
5. **Exit Strategies:**
   - Natural close (market resolution)
   - Stop-loss (configurable per coin)
   - Flip-stop (when your position becomes the underdog)

### Safety Guard System
- `dry_run: true/false` — Paper mode toggle
- `max_order_size_usd: 150` — Per-order cap
- `max_total_investment: 1000` — Per-market cap
- Rate limiting on orders per minute
- Emergency stop via keyboard (`E` key) or Telegram (`/off`)
- Position persistence on shutdown

### Config Structure (config/config.json)
```json
{
  "safety": {
    "dry_run": true,
    "max_order_size_usd": 150,
    "max_total_investment": 1000
  },
  "trading": {
    "btc": { "enabled": true },
    "eth": { "enabled": true },
    "sol": { "enabled": true },
    "xrp": { "enabled": true }
  },
  "strategy": {
    "entry_window_sec": 240,
    "min_confidence": 0.30,
    "price_max": 0.92
  },
  "exit": {
    "stop_loss": {
      "per_coin": { "btc": { "value": -12 } }
    }
  }
}
```

### Key Files
| File | Purpose |
|------|---------|
| `src/main.py` | Entry point |
| `src/strategy.py` | Late Entry V3 logic |
| `src/data_feed.py` | WebSocket data feeds |
| `src/multi_trader.py` | Multi-market manager |
| `src/trader.py` | Individual coin trader |
| `src/order_executor.py` | Order execution engine |
| `src/position_tracker.py` | REST API position tracking |
| `src/safety_guard.py` | Safety limits + emergency stop |
| `src/simple_redeem_collector.py` | Auto-redeem background task |
| `src/polymarket_api.py` | Polymarket API wrapper |
| `src/pnl_chart_generator.py` | PnL charts via matplotlib |

### Logging Pattern
- `trades.jsonl` — All executed trades (JSON Lines)
- `orders.jsonl` — Order execution details
- `safety.log` — Safety guard events
- `session.json` — Current session state
- `error.log` — Error messages

---

## 4. collectmarkets2 — Wallet Activity Collector

**Purpose:** Collect and analyze trading activity from any Polymarket wallet. Useful for studying winning traders.

### API Endpoint
```
https://data-api.polymarket.com/activity
- Rate limit: 0.5s between requests (built-in)
- Max records: 10,000 per wallet
- Automatic pagination
```

### Data Fields
| Field | Description |
|-------|-------------|
| `timestamp` | Unix timestamp |
| `type` | TRADE, MERGE, SPLIT |
| `outcome` | Up/Down |
| `size` | Number of contracts |
| `usdcSize` | Trade size in USDC |
| `price` | Contract price (0.01-0.99) |
| `transactionHash` | Blockchain tx hash |
| `title` | Market question |
| `slug` | Market identifier |

### Cyclic Collection (Live Monitoring)
- Configure intervals (every 1, 5, 10 minutes)
- Automatic data merging across cycles
- Duplicate removal via transaction hash
- Markets with <30 trades filtered out

### Visualization
- Trade scatter plot (price vs time, point size = USDC amount)
- Cumulative contract accumulation over time
- Green = UP trades, Red = DOWN trades

### Use Case for Our Bot
Copy winning wallet addresses → collect their activity → analyze patterns → replicate strategies.

---

## 5. mlmodelpoly — Institutional-Grade Data Collector + Edge Engine

**Purpose:** Real-time Binance Futures/Spot data collector with Polymarket integration, fair value model, and edge calculation. **This is the most sophisticated reference.**

### Architecture
```
Binance WebSocket → Pipeline → Features → Edge Engine → Decision
     ↓                                        ↑
Polymarket WS → Book Store → Fair Model ──────┘
     ↓
TAAPI.io → Context Engine → Bias Model
```

### Feature Set (Computed in Real-Time)
- **CVD** (Cumulative Volume Delta) — buy/sell pressure
- **RVOL** (Relative Volume) — volume vs rolling average
- **Impulse Detection** — price momentum spices
- **Microprice** — volume-weighted mid price
- **Basis** — Futures vs Spot premium/discount
- **Anchored VWAP** — session VWAP with deviation
- **Liquidation Tracking** — large forced liquidations
- **Multi-timeframe Bias** — directional bias model

### Fair Value Model
- **Probability estimation** with fast/smooth modes
- **Spike detection** — microstructure spice/dip detection
- **Edge calculation** — trading edge in basis points

### Polymarket Integration Config
```
POLYMARKET_ENABLED=true
POLYMARKET_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
POLYMARKET_STALE_THRESHOLD_SEC=5.0
POLYMARKET_MIN_DEPTH=200.0        # Min depth for execution
POLYMARKET_MAX_SPREAD_BPS=500.0   # Max spread before veto
POLY_UP_IS_YES=true               # UP = YES token mapping
```

### Trading Parameters
```
SLICE_USD=20.0              # Standard slice size
MAX_SLICES_PER_WINDOW=30    # Max slices per 15-min window
MAX_USD_PER_WINDOW=300.0    # Max USD per window
COOLDOWN_SEC=2.0            # Cooldown between executions
EDGE_BUFFER_BPS=25.0        # Required edge buffer
```

### Key Files
| File | Purpose |
|------|---------|
| `src/collector/main.py` | Entry point |
| `src/collector/config.py` | Pydantic settings |
| `src/collector/ws_client.py` | Binance WebSocket |
| `src/collector/pipeline.py` | Event processing |
| `src/collector/features.py` | Feature computation |
| `src/collector/bars.py` | OHLCV bar aggregation (5s/15s/1m) |
| `src/collector/edge_engine.py` | **Trading edge calculation** |
| `src/collector/fair_model.py` | **Fair value estimation** |
| `src/collector/bias_model.py` | **Directional bias model** |
| `src/collector/volatility.py` | Fast/slow/blend sigma |
| `src/collector/accumulate_engine.py` | Trade accumulation |
| `src/collector/polymarket/ws_client.py` | PM WebSocket |
| `src/collector/polymarket/book_store.py` | Orderbook storage |
| `src/collector/polymarket/market_resolver.py` | Token ID resolution |
| `src/collector/polymarket/normalize_updown.py` | UP/DOWN normalization |
| `src/collector/taapi/client.py` | TAAPI.io HTTP client |
| `src/strategies/z_contra_fav_dip_hedge.py` | **Contra-favorite dip hedge strategy** |

### HTTP REST API
```
GET /health          — Health check
GET /state           — Current system state
GET /latest/features — Latest computed features
GET /latest/bars     — Latest OHLCV bars
GET /latest/edge     — Latest edge decision
POST /control/anchor/reset — Reset VWAP anchor
```

### Data Quality System
- Quality modes: OK / DEGRADED / BAD
- Stale data threshold: 5 seconds
- Prometheus metrics for lag, throughput, error tracking
- Structured JSON logging

---

## Cross-Cutting Patterns (Apply to Our Bot)

### 1. WebSocket-First Architecture
All 5 repos use WebSocket for real-time data, NOT REST polling:
- **Binance:** `wss://stream.binance.com:9443/ws/btcusdt@kline_1s`
- **Polymarket Orderbook:** `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- **Chainlink Oracle:** `wss://ws-live-data.polymarket.com`

### 2. Polymarket API Endpoints
| Endpoint | Purpose |
|----------|---------|
| `https://gamma-api.polymarket.com` | Market discovery (REST) |
| `https://clob.polymarket.com` | Order placement (REST) |
| `wss://ws-subscriptions-clob.polymarket.com/ws/market` | Real-time orderbook (WS) |
| `https://data-api.polymarket.com/activity` | Wallet activity history |
| `wss://ws-live-data.polymarket.com` | Chainlink oracle live data |

### 3. The 15-Minute Crypto Market Pattern
All crypto bots focus on Polymarket's 15-minute prediction markets:
- Markets ask "Will BTC/ETH/SOL/XRP be above $X at time Y?"
- New market opens every 15 minutes
- Resolution via Chainlink oracle
- Key edge: enter → **last 4 minutes** when price direction is more certain

### 4. Execution Best Practices
- **FOK/FAK modes** (Fill-or-Kill / Fill-and-Kill) for order types
- **Auto-redeem** background tasks after market resolution
- **Position persistence** on shutdown/restart
- **File locks** for concurrent operations (redeem_lock.py)
- **Safety guards** with per-order, per-market, and per-session limits

### 5. Auth Pattern (Polymarket)
```python
# Three signature types for different registration methods
SIGNATURE_TYPE = 0  # EOA (self-created wallet)
SIGNATURE_TYPE = 1  # POLY_PROXY (Magic Link / Email registration)
SIGNATURE_TYPE = 2  # POLY_GNOSIS_SAFE (MetaMask / Phantom registration)
```

### 6. Winning Strategy Elements
1. **Late entry** — wait until market direction is clearer (last 4 min)
2. **Favorite detection** — buy the consensus side (higher ask)
3. **Confidence threshold** — minimum 30% price gap before entering
4. **Time-scaled sizing** — more aggressive as expiry approaches
5. **Stop-loss + flip-stop** — exit if your side becomes the underdog
6. **Edge calculation in bps** — quantify edge before entering
7. **Fair value model** — compare market price to model price
8. **Multiple data sources** — oracle + exchange + orderbook

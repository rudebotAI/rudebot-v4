# Prediction Bot Reference Knowledge Base
## Extracted from txbabaxyz GitHub repos -- March 2026

This document consolidates architecture, strategies, APIs, and patterns from 5 production Polymarket trading systems. Use as reference when building or improving prediction market bots.

---

## 1. polyterminal -- Live Trading Terminal

**Purpose:** Manual/semi-automated trading terminal for Polymarket 15-minute crypto prediction markets (BTC, ETH, SOL, XRP).

### Key Architecture
- **Entry point:** `launcher.py` (menu) -> `trade.py` (main trading)
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
- Uses **USDC (Bridged)**, NOT USDC.e (Native) -- swap on QuickSwap if needed
- Needs small POL/MATIC balance for gas fees
- Log rotation: 3-hour files in `logs/`
- `negRisk` flag matters for signature -- toggle if "invalid signature" errors

---

## 2. polyrec -- Real-Time Dashboard + Backtesting

**Purpose:** Data collection dashboard aggregating Chainlink oracle, Binance, and Polymarket orderbook for BTC 15-min markets. Includes backtesting tools.

### Data Sources (Critical for any Polymarket bot)
| Source | Type | URL |
|---------|--------|-----|
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
1. **`replicate_balance.py`** -- Balance replication strategy simulator
2. **`fade_impulse_backtest.py`** -- Impulse fade strategy (contrarian)
3. **`visualize_fade_impulse.py`** -- Strategy visualization

### Key Insight: Chainlink Oracle as Ground Truth
The dashboard uses the Chainlink BTC/USD oracle price (via Polymarket RTDS WebSocket) as the reference price, comparing it against Binance and Polymarket orderbook prices. The lag between these sources IS the edge.

---

## 3. 4coinsbot -- Multi-Coin Automated Trading (Late Entry V3)

**Purpose:** Fully automated bot trading BTC/ETH/SOL/XRP in parallel on Polymarket 15-min markets. This is the most production-ready reference.

### Architecture
```
┌────────────────────────────────────────┐
│           MAIN TRADING LOOP             │
├─────────────────────────────────────────┤
│  BTC Trader | ETH Trader | SOL | XRP   │
│       └──────────┬──────────┘              │
│         Order Executor | Data Feed      │
└─────────────────────────────────────────┘
```

### Late Entry V3 Strategy (THE CORE STRATEGY)
1. **Entry Window:** Only enter in the **last 4 minutes** (240 seconds) before market close
2. **Favorite Detection:** Buy the side with **higher ask price** (market consensus)
3. **Confidence Filter:** Only enter when price difference exceeds **30%**
4. **Time-based Sizing:**
   - Above 180s remaining -> 8 contracts
   - Above 120s remaining -> 10 contracts
   - Below 120s remaining -> 12 contracts (more aggressive closer to close)
5. **Exit Strategies:**
   - Natural close (market resolution)
   - Stop-loss (configurable per coin)
   - Flip-stop (when your position becomes the underdog)

### Safety Guard System
- `dry_run: true/false` -- Paper mode toggle
- `max_order_size_usd: 150` -- Per-order cap
- `max_total_investment: 1000` -- Per-market cap
- Rate limiting on orders per minute
- Emergency stop via keyboard (`E` key) or Telegram (`/off`)
- Position persistence on shutdown
0
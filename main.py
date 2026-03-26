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
        logger.error("Copy config.yaml.example -> config.yaml and fill in your keys.")
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        cfg = yaml.safe_load(f)

    # Overlay environment variables (Railway / Docker / CI)
    import os
    env_map = {
        "KALSHI_API_KEY":       ("kalshi", "api_key"),
        "KALSHI_API_SECRET":    ("kalshi", "api_secret"),
        "KALSHI_EMAIL":         ("kalshi", "email"),
        "POLYMARKET_PRIVATE_KEY": ("polymarket", "private_key"),
        "POLYMARKET_FUNDER":    ("polymarket", "funder_address"),
        "TELEGRAM_BOT_TOKEN":   ("telegram", "bot_token"),
        "TELEGRAM_CHAT_ID":     ("telegram", "chat_id"),
        "BRAVE_API_KEY":        ("research", "brave_api_key"),
        "XAI_API_KEY":          ("research", "xai_api_key"),
        "SCRAPECREATORS_API_KEY": ("research", "scrapecreators_api_key"),
        "BOT_MODE":             (None, "mode"),
        "BANKROLL_USD":         ("risk", "bankroll_usd"),
    }
    for env_key, (section, field) in env_map.items():
        val = os.environ.get(env_key)
        if val:
            if section:
                cfg.setdefault(section, {})[field] = val
            else:
                cfg[field] = val
            logger.info(f"  ENV override: {env_key} -> {section or ''}.{field}")

    return cfg


# ── Import Modules ──
from connectors.polymarket import PolymarketConnector
from connectors.kalshi import KalshiConnector
from engines.scanner import EVScanner
from engines.sizing import KellySizer
from engines.lmsr import LMSREngine
from engines.divergence import DivergenceScanner
from engines.bayesian import BayesianUpdater
from engines.arbitrage import ArbitrageDetector
from execution.paper import PaperTrader
from execution.live import LiveTrader
from execution.risk import RiskManager
from alerts.telegram import TelegramAlerts
from engines.research import ResearchEngine
from connectors.coinbase import CoinbaseConnector
from execution.state_store import StateStore
from execution.order_router import OrderRouter
from mcp_plugin import MCPPlugin
from dashboard import update_dashboard
from engines.crypto_momentum import CryptoMomentumEngine
from subbots.price_tracker import PriceTracker
from subbots.news_sentinel import NewsSentinel

# ── New Edge Engines ──
from engines.websocket_feed import WebSocketFeed
from engines.late_entry import LateEntryStrategy
from engines.fair_value import FairValueModel
from engines.backtester import DataLogger
from engines.safety_guard import SafetyGuard
from engines.auto_redeem import AutoRedeemer

# Need json for command handler
import json


class PredictionBot:
    """Main bot orchestrator -- v4.0 with edge engines."""

    def __init__(self, config: dict):
        self.config = config
        self.mode = config.get("mode", "paper")
        self.scan_interval = config.get("strategy", {}).get("scan_interval_sec", 120)
        self.running = True
        self.scan_number = 0
        self.recent_signals = []
        self.errors = []

        # ── Initialize connectors ──
        logger.info("Initializing connectors...")
        self.poly = PolymarketConnector(config.get("polymarket", {}))
        self.kalshi = KalshiConnector(config.get("kalshi", {}))

        logger.info("Initializing engines...")
        strategy = config.get("strategy", {})
        risk_config = config.get("risk", {})

        self.scanner = EVScanner(strategy)
        self.sizer = KellySizer(strategy | risk_config)
        self.lmsr = LMSREngine()
        self.divergence = DivergenceScanner()
        self.bayesian = BayesianUpdater()
        self.arbitrage = ArbitrageDetector(strategy)
        self.research = ResearchEngine(config.get("research", {}))
        self.coinbase = CoinbaseConnector(config.get("coinbase", {}))

        logger.info("Initializing execution...")
        log_config = config.get("logging", {})
        self.risk = RiskManager(risk_config)
        self.paper = PaperTrader(log_config)
        self.live = LiveTrader(self.poly, self.kalshi, self.risk)
        self.state_store = StateStore(log_config.get("state_file", "logs/state.json"))

        logger.info("Initializing order router...")
        self.order_router = OrderRouter(
            self.risk, self.paper, self.live, self.state_store,
            TelegramAlerts(config.get("telegram", {})),  # alerts for router
            mode=self.mode,
        )

        if self.mode == "live":
            logger.critical("MODE: LIVE -- Real money at risk!")
            self.live.enable()
        else:
            logger.info("MODE: PAPER -- No real money")

        logger.info("Initializing alerts...")
        self.telegram = TelegramAlerts(config.get("telegram", {}))

        self.bankroll = risk_config.get("bankroll_usd", 50.0)

        # ── Initialize crypto momentum engine + sub-bots ──
        logger.info("Initializing crypto momentum engine...")
        crypto_config = config.get("crypto_momentum", {})
        self.crypto_engine = CryptoMomentumEngine(self.coinbase, crypto_config)

        logger.info("Initializing sub-bots...")
        self.price_tracker = PriceTracker(self.coinbase, crypto_config.get("price_tracker", {}))
        self.news_sentinel = NewsSentinel(config.get("news_sentinel", {}))

        # Start sub-bots (background threads)
        if crypto_config.get("enabled", True):
            self.price_tracker.start()
            self.news_sentinel.start()

        # ── NEW: Edge Engines ──
        logger.info("Initializing edge engines...")

        # WebSocket real-time feeds
        ws_config = config.get("websocket", {})
        self.ws_feed = WebSocketFeed(ws_config)

        # Late Entry V3 strategy
        le_config = config.get("late_entry", {})
        self.late_entry = LateEntryStrategy(le_config)

        # Fair Value model
        fv_config = config.get("fair_value", {})
        self.fair_value = FairValueModel(fv_config)

        # Backtesting data logger
        bt_config = config.get("backtesting", {})
        self.data_logger = DataLogger(bt_config.get("log_dir", "logs/backtest"))

        # Safety guard (replaces basic risk manager for order validation)
        safety_config = {**risk_config, **config.get("safety", {})}
        self.safety = SafetyGuard(safety_config)

        # Auto-redeem
        redeem_config = config.get("auto_redeem", {})
        self.auto_redeemer = AutoRedeemer(self.poly, redeem_config, self.telegram)

        logger.info("Initializing MCP plugin...")
        self.mcp = MCPPlugin(self)

    def start(self):
        """Main entry -- send startup message and begin loop."""
        platforms = self.config.get("strategy", {}).get("platforms", ["polymarket", "kalshi"])

        banner = (
            f"{'=' * 50}\n"
            f"  PredictionBot v4.0 -- Edge Edition\n"
            f"  Mode: {self.mode.upper()}\n"
            f"  Platforms: {', '.join(platforms)}\n"
            f"  Bankroll: ${self.bankroll:.2f}\n"
            f"  Scan interval: {self.scan_interval}s\n"
            f"  WebSocket: {'ON' if self.ws_feed.enabled else 'OFF'}\n"
            f"  Late Entry V3: {'ON' if self.late_entry.enabled else 'OFF'}\n"
            f"  Fair Value Model: ON\n"
            f"  Backtesting Logger: ON\n"
            f"  Safety Guard: ON (max ${self.safety.max_order_usd}/order)\n"
            f"  Auto-Redeem: {'ON' if self.auto_redeemer.enabled else 'OFF'}\n"
            f"{'=' * 50}"
        )
        print(banner)

        # Start WebSocket feeds
        self.ws_feed.start()

        # Start auto-redeemer
        self.auto_redeemer.start()

        if self.telegram.is_configured():
            self.telegram.send(
                f"<b>PredBot v4.0 Started</b>\n"
                f"Mode: {self.mode.upper()}\n"
                f"Platforms: {', '.join(platforms)}\n"
                f"Bankroll: ${self.bankroll:.2f}\n"
                f"WebSocket: {'ON' if self.ws_feed.enabled else 'OFF'}\n"
                f"Late Entry V3: {'ON' if self.late_entry.enabled else 'OFF'}\n"
                f"Safety: max ${self.safety.max_order_usd}/order\n"
                f"Send /help for commands"
            )

        # Write initial dashboard
        update_dashboard({
            "mode": self.mode, "bankroll": self.bankroll, "scan_number": 0,
            "poly_markets": 0, "kalshi_markets": 0, "ev_opportunities": 0,
            "arb_opportunities": 0, "div_signals": 0, "risk_status": "Active",
            "daily_pnl": 0, "total_pnl": 0, "total_trades": 0, "wins": 0,
            "losses": 0, "win_rate": 0, "open_positions": [], "recent_signals": [],
            "errors": [], "scan_interval": self.scan_interval,
        })

        # Auto-open dashboard in browser
        import webbrowser
        dash_path = Path(__file__).parent / "dashboard.html"
        webbrowser.open(f"file://{dash_path.resolve()}")
        logger.info(f"Dashboard opened: {dash_path}")

        # Graceful shutdown handler
        signal.signal(signal.SIGINT, self._shutdown)
        signal.signal(signal.SIGTERM, self._shutdown)

    def run_loop(self):
        """Main scan loop -- runs until stopped."""
        self.start()

        while self.running:
            try:
                self._tick()
                logger.info(f"Sleeping {self.scan_interval}s...")
                time.sleep(self.scan_interval)
            except KeyboardInterrupt:
                break
            except Exception as e:
                logger.error(f"Loop error: {e}", exc_info=True)
                self.errors.append(f"{time.strftime('%H:%M:%S')} -- {str(e)[:150]}")
                if self.telegram.is_configured():
                    self.telegram.send_error(str(e))
                time.sleep(10)

        self._cleanup()

    def run_once(self):
        """Single scan -- useful for testing."""
        self.start()
        self._tick()
        self._cleanup()

    def _tick(self):
        """One full scan cycle -- enhanced with edge engines."""
        now = time.strftime("%H:%M:%S")
        logger.info(f"[{now}] Starting scan...")

        # 1. Check risk + safety status
        can_trade, reason = self.risk.can_trade()
        if not can_trade:
            logger.warning(f"Risk: {reason}")
            if self.telegram.is_configured():
                self.telegram.send_risk_alert(self.risk.status())
            return

        safety_status = self.safety.status()
        if not safety_status["can_trade"]:
            logger.warning(f"Safety: {safety_status['reason']}")
            return

        # 2. Fetch markets from both platforms
        platforms = self.config.get("strategy", {}).get("platforms", ["polymarket", "kalshi"])
        poly_markets = []
        kalshi_markets = []

        if "polymarket" in platforms:
            logger.info("Scanning Polymarket...")
            try:
                poly_markets = self.poly.scan_markets_with_prices(limit=50)
                logger.info(f"  Found {len(poly_markets)} Polymarket markets")
            except Exception as e:
                logger.warning(f"  Polymarket scan failed: {e}")

        if "kalshi" in platforms:
            logger.info("Scanning Kalshi...")
            try:
                kalshi_markets = self.kalshi.scan_markets_with_prices(limit=50)
                logger.info(f"  Found {len(kalshi_markets)} Kalshi markets")
            except Exception as e:
                logger.warning(f"  Kalshi scan failed: {e}")

        # 3. Cross-reference markets
        all_markets = self.scanner.cross_reference_markets(poly_markets, kalshi_markets)
        logger.info(f"Total markets after cross-reference: {len(all_markets)}")

        # 4. Run EV scanner
        opportunities = self.scanner.scan(all_markets)
        logger.info(f"EV opportunities found: {len(opportunities)}")

        # 5. Run Fair Value model on all markets -- THE KEY EDGE
        fair_values = {}
        fv_opportunities = []
        btc_analysis = None

        # Get crypto analysis for FV model overlay
        if self.config.get("crypto_momentum", {}).get("enabled", True):
            try:
                btc_analysis = self.crypto_engine.analyze_asset("BTC-USD")
            except Exception as e:
                logger.warning(f"Crypto momentum failed: {e}")

        for m in all_markets:
            market_id = m.get("market_id", m.get("condition_id", ""))
            fv_result = self.fair_value.compute(
                m,
                ws_feed=self.ws_feed,
                crypto_analysis=btc_analysis if "btc" in m.get("question", "").lower() else None,
            )
            fair_values[market_id] = fv_result

            if fv_result.get("tradeable"):
                # Build opportunity from fair value
                fv_opp = {
                    **m,
                    "signal": fv_result["side"],
                    "ev": self.fair_value.compute_ev_from_fv(fv_result["fair_value"], m.get("yes_price", 0.5)),
                    "model_prob": fv_result["fair_value"],
                    "market_price": m.get("yes_price") if fv_result["side"] == "YES" else m.get("no_price", 1 - m.get("yes_price", 0.5)),
                    "edge": fv_result["edge_pct"] / 100,
                    "edge_bps": fv_result["edge_bps"],
                    "strategy": "fair_value",
                    "fv_models": fv_result.get("model_names", []),
                }
                fv_opportunities.append(fv_opp)

        if fv_opportunities:
            logger.info(f"Fair Value opportunities: {len(fv_opportunities)}")

        # 6. Run Late Entry V3 on short-duration markets
        late_entry_opps = []
        if self.late_entry.enabled:
            le_markets = kalshi_markets + poly_markets
            late_entry_opps = self.late_entry.evaluate_markets(le_markets, ws_feed=self.ws_feed)
            if late_entry_opps:
                logger.info(f"Late Entry V3 opportunities: {len(late_entry_opps)}")

        # 7. Run LMSR analysis on top EV opportunities
        for opp in opportunities[:10]:
            lmsr_data = self.lmsr.analyze_market(opp, self.sizer.max_position_usd)
            opp["lmsr"] = lmsr_data
            if lmsr_data.get("is_thin"):
                logger.warning(f"  Thin pool warning: {opp['question'][:40]} (b={lmsr_data['b_estimate']})")

        # 8. Run cross-platform arbitrage scan
        arbs = self.arbitrage.detect_same_event_arb(poly_markets, kalshi_markets)
        if arbs:
            logger.info(f"Arbitrage opportunities: {len(arbs)}")
            for arb in arbs[:3]:
                logger.info(f"  ARB: {arb['question'][:40]} | gap={arb['gap']:.3f}")

        # 9. Run KL-Divergence scan
        divergences = self.divergence.scan_cross_platform(poly_markets, kalshi_markets)
        if divergences:
            logger.info(f"KL-Divergence signals: {len(divergences)}")

        # 10. Crypto Momentum
        crypto_opps = []
        if self.config.get("crypto_momentum", {}).get("enabled", True):
            try:
                crypto_opps = self.crypto_engine.generate_opportunities(kalshi_markets)
                if crypto_opps:
                    logger.info(f"Crypto momentum opportunities: {len(crypto_opps)}")
            except Exception as e:
                logger.warning(f"Crypto momentum error: {e}")

        # 11. News Sentinel -- inject sentiment into Bayesian updates
        try:
            news_lr = self.news_sentinel.get_sentiment_lr()
            if news_lr != 1.0 and abs(news_lr - 1.0) > 0.05:
                for opp in (opportunities + crypto_opps)[:5]:
                    if opp.get("crypto_engine"):
                        old_prob = opp.get("model_prob", 0.5)
                        new_prob = self.bayesian.update(old_prob, news_lr)
                        opp["model_prob"] = new_prob
                        opp["news_adjusted"] = True
        except Exception as e:
            logger.debug(f"News sentinel LR error: {e}")

        # 12. Research layer
        if self.research.is_configured():
            logger.info("Running research layer...")
            for opp in opportunities[:5]:
                try:
                    research = self.research.research_market(opp.get("question", ""))
                    opp["research"] = research
                    if research["combined_lr"] != 1.0 and research["sources_used"] > 0:
                        old_prob = opp.get("model_prob", 0.5)
                        new_prob = self.bayesian.update(old_prob, research["combined_lr"])
                        opp["model_prob"] = new_prob
                        opp["research_adjusted"] = True
                        logger.info(
                            f"  Research: {opp['question'][:40]} | "
                            f"LR={research['combined_lr']:.2f} ({research['direction']}) | "
                            f"prob {old_prob:.3f} -> {new_prob:.3f}"
                        )
                except Exception as e:
                    logger.debug(f"Research failed for {opp.get('question','')[:30]}: {e}")
        else:
            logger.info("Research layer: no API keys configured -- skipping")

        # ── Merge all opportunity sources and rank ──
        all_opps = []
        # Priority: Late Entry > Fair Value > Crypto Momentum > EV Scanner
        for opp in late_entry_opps:
            opp["priority"] = 1
            all_opps.append(opp)
        for opp in fv_opportunities:
            opp["priority"] = 2
            all_opps.append(opp)
        for opp in crypto_opps:
            opp["priority"] = 3
            all_opps.append(opp)
        for opp in opportunities:
            opp["priority"] = 4
            all_opps.append(opp)

        # Sort by: priority first, then EV
        all_opps.sort(key=lambda x: (-x.get("priority", 99), -x.get("ev", 0)))
        # Deduplicate by market_id
        seen = set()
        deduped = []
        for opp in all_opps:
            key = opp.get("market_id", opp.get("condition_id", opp.get("question", "")))
            if key not in seen:
                seen.add(key)
                deduped.append(opp)
        all_opps = deduped

        logger.info(f"Total ranked opportunities: {len(all_opps)}")

        # 13. Size and execute top opportunities
        for opp in all_opps[:5]:
            sizing = self.sizer.compute_size(
                opp.get("model_prob", 0.5),
                opp.get("market_price", 0.5),
                self.bankroll
            )

            # Late Entry uses its own time-based sizing (not Kelly)
            if opp.get("late_entry") and opp.get("size_usd_suggested"):
                sizing["size_usd"] = opp["size_usd_suggested"]

            if sizing["size_usd"] < 0.50:
                continue

            opp["kelly_fraction"] = sizing["kelly_fractional"]

            # Skip thin pools unless arb or late entry
            if opp.get("lmsr", {}).get("is_thin") and opp.get("ev", 0) < 0.10 and not opp.get("late_entry"):
                logger.info(f"  Skipping thin pool: {opp['question'][:40]}")
                self.paper.skip_opportunity(opp, "thin_pool")
                continue

            # Safety guard validation
            market_id = opp.get("market_id", opp.get("condition_id", ""))
            safe, safe_reason = self.safety.validate_order(market_id, sizing["size_usd"])
            if not safe:
                logger.warning(f"  Safety blocked: {safe_reason}")
                continue

            strategy_tag = opp.get("strategy", "ev_scanner")
            logger.info(
                f"  SIGNAL [{strategy_tag}]: {opp['signal']} {opp['question'][:40]} | "
                f"EV={opp['ev']:.3f} Edge={opp.get('edge', 0):.3f} "
                f"{'(' + str(opp.get('edge_bps', '')) + 'bps)' if opp.get('edge_bps') else ''} | "
                f"${sizing['size_usd']:.2f}"
            )
            self.recent_signals.append({
                "signal": opp.get("signal"), "question": opp.get("question", ""),
                "ev": opp.get("ev", 0), "edge": opp.get("edge", 0),
                "edge_bps": opp.get("edge_bps"), "strategy": strategy_tag,
                "size_usd": sizing["size_usd"], "time": time.strftime("%H:%M:%S"),
                "research_direction": opp.get("research", {}).get("direction"),
            })

            # Send Telegram alert
            if self.telegram.is_configured():
                self.telegram.send_opportunity(opp, sizing)

            # Auto-execute if confirm not required
            if not self.telegram.require_confirm:
                self._execute_trade(opp, sizing)

        # 14. Process Telegram callbacks
        if self.telegram.is_configured():
            confirmed = self.telegram.poll_callbacks()
            for item in confirmed:
                if isinstance(item, dict) and "command" in item:
                    self._handle_command(item["command"])
                elif isinstance(item, dict) and "opp" in item:
                    self._execute_trade(item["opp"], item["sizing"])

        # 15. Log data for backtesting
        try:
            self.data_logger.log_tick(
                scan_number=self.scan_number,
                markets=all_markets,
                opportunities=all_opps,
                crypto_analysis=btc_analysis,
                fair_values=fair_values,
            )
        except Exception as e:
            logger.debug(f"Backtest logging error: {e}")

        # 16. Save state snapshot
        self.state_store.save_snapshot(all_markets, all_opps, arbs)

        # 17. Update dashboard
        self.scan_number += 1
        try:
            perf = self.paper.get_performance()
            risk_st = self.risk.status()
            safety_st = self.safety.status()
            ws_stats = self.ws_feed.get_stats()
            le_perf = self.late_entry.get_performance()
            bt_stats = self.data_logger.get_stats()

            update_dashboard({
                "mode": self.mode,
                "bankroll": self.bankroll,
                "scan_number": self.scan_number,
                "poly_markets": len(poly_markets),
                "kalshi_markets": len(kalshi_markets),
                "ev_opportunities": len(opportunities),
                "fv_opportunities": len(fv_opportunities),
                "late_entry_opportunities": len(late_entry_opps),
                "arb_opportunities": len(arbs),
                "div_signals": len(divergences),
                "risk_status": "HALTED" if risk_st.get("halted") or safety_st.get("halted") else "Active",
                "daily_pnl": safety_st.get("daily_pnl", risk_st.get("daily_pnl", 0)),
                "total_pnl": perf.get("total_pnl", 0),
                "total_trades": perf.get("total_trades", 0),
                "wins": perf.get("wins", 0),
                "losses": perf.get("losses", 0),
                "win_rate": perf.get("win_rate", 0),
                "open_positions": self.paper.get_open_positions(),
                "recent_signals": self.recent_signals[-10:],
                "errors": self.errors[-5:],
                "scan_interval": self.scan_interval,
                "crypto_opportunities": len(crypto_opps),
                "price_tracker": self.price_tracker.get_status() if hasattr(self, 'price_tracker') else {},
                "news_sentiment": self.news_sentinel.get_sentiment_summary() if hasattr(self, 'news_sentinel') else {},
                "websocket": ws_stats,
                "late_entry_perf": le_perf,
                "safety": safety_st,
                "backtest_rows": bt_stats.get("rows_logged", 0),
                "auto_redeem": self.auto_redeemer.get_stats(),
            })
            logger.info("Dashboard updated")
        except Exception as e:
            logger.error(f"Dashboard update failed: {e}")

        if self.telegram.is_configured() and self.config.get("telegram", {}).get("send_scan_summary", False):
            self.telegram.send_scan_summary(
                len(poly_markets), len(kalshi_markets),
                len(all_opps), len(arbs), len(divergences)
            )

        # 18. Check open positions for exit (including Late Entry exits)
        self._check_exits()

    def _execute_trade(self, opp: dict, sizing: dict):
        """Execute a trade through the order router with safety check."""
        market_id = opp.get("market_id", opp.get("condition_id", ""))

        # Safety guard final check
        safe, reason = self.safety.validate_order(market_id, sizing["size_usd"])
        if not safe:
            logger.warning(f"Safety blocked execution: {reason}")
            return

        result = self.order_router.route_order(opp, sizing["size_usd"])
        if result.get("success"):
            # Record in safety guard
            self.safety.record_order(market_id, sizing["size_usd"])
            # Record in Late Entry tracker if applicable
            if opp.get("late_entry"):
                self.late_entry.record_entry(market_id, {
                    "entry_price": result.get("fill_price", opp.get("market_price")),
                    "signal": opp.get("signal"),
                    "size_usd": sizing["size_usd"],
                })
        else:
            logger.warning(f"Trade failed: {result.get('error', 'unknown')}")

    def _check_exits(self):
        """Check open paper positions for exit conditions."""
        for trade in self.paper.get_open_positions():
            token_id = trade.get("token_id")
            if not token_id:
                continue

            # Try WebSocket price first, fall back to REST
            current_price = None
            ws_data = self.ws_feed.get_latest(token_id)
            if ws_data:
                current_price = ws_data.get("price")

            if current_price is None:
                current_price = self.poly.get_midpoint(token_id)

            if current_price is None:
                continue

            entry = trade["entry_price"]
            signal = trade["signal"]
            market_id = trade.get("market_id", trade.get("condition_id", ""))

            # P&L check
            if signal == "YES":
                pnl_pct = (current_price - entry) / entry * 100
            else:
                pnl_pct = (entry - current_price) / entry * 100

            # Check Late Entry exit conditions first
            if trade.get("late_entry") or trade.get("strategy") == "late_entry_v3":
                le_exit = self.late_entry.check_exit(trade, current_price)
                if le_exit:
                    self.order_router.close_position(trade["id"], current_price, le_exit["reason"])
                    self.safety.record_result(pnl_pct / 100 * trade.get("size_usd", 0))
                    self.late_entry.record_exit(market_id, pnl_pct)
                    continue

            # Standard exit conditions
            should_exit = False
            reason = ""

            if pnl_pct >= 50:  # Take profit at +50%
                should_exit = True
                reason = "take_profit_50pct"
            elif pnl_pct <= -30:  # Stop loss at -30%
                should_exit = True
                reason = "stop_loss_30pct"
            elif current_price >= 0.95 or current_price <= 0.05:  # Near resolution
                should_exit = True
                reason = "near_resolution"

            if should_exit:
                self.order_router.close_position(trade["id"], current_price, reason)
                pnl_usd = pnl_pct / 100 * trade.get("size_usd", 0)
                self.safety.record_result(pnl_usd)

    def _handle_command(self, cmd: str):
        """Handle Telegram text commands."""
        if cmd == "pnl":
            perf = self.paper.get_performance()
            self.telegram.send_performance(perf, self.risk.status())
        elif cmd == "status":
            status = {**self.risk.status(), **self.safety.status()}
            self.telegram.send(f"<b>Bot Status</b>\n{json.dumps(status, indent=2)}")
        elif cmd == "resume":
            self.risk.manual_resume()
            self.safety.manual_resume()
            self.telegram.send("<b>Trading Resumed</b>\nRisk + safety managers reset.")
        elif cmd == "positions":
            positions = self.paper.get_open_positions()
            if not positions:
                self.telegram.send("No open positions.")
            else:
                lines = ["<b>Open Positions</b>\n"]
                for p in positions:
                    lines.append(f"* {p['signal']} {p['question'][:40]}\n  @ {p['entry_price']:.3f} | ${p['size_usd']:.2f}")
                self.telegram.send("\n".join(lines))
        elif cmd == "stop":
            self.safety.emergency_stop()
            self.telegram.send("<b>EMERGENCY STOP</b>\nAll trading halted.")
        elif cmd == "redeem":
            stats = self.auto_redeemer.force_redeem()
            self.telegram.send(f"<b>Redeem</b>\nCollected: ${stats.get('total_redeemed_usd', 0):.2f}")
        elif cmd == "ws":
            stats = self.ws_feed.get_stats()
            self.telegram.send(f"<b>WebSocket</b>\n{json.dumps(stats, indent=2)}")

    def _shutdown(self, *args):
        """Graceful shutdown."""
        logger.info("Shutting down...")
        self.running = False

    def _cleanup(self):
        """Final cleanup on exit."""
        # Stop all background services
        self.ws_feed.stop()
        self.auto_redeemer.stop()
        if hasattr(self, 'price_tracker'):
            self.price_tracker.stop()
        if hasattr(self, 'news_sentinel'):
            self.news_sentinel.stop()

        self.paper.save_daily_performance()

        if self.telegram.is_configured():
            perf = self.paper.get_performance()
            le_perf = self.late_entry.get_performance()
            self.telegram.send(
                f"<b>Bot Stopped</b>\n"
                f"Total P&L: ${perf.get('total_pnl', 0):.2f}\n"
                f"Trades: {perf.get('total_trades', 0)}\n"
                f"Late Entry: {le_perf.get('trades', 0)} trades, {le_perf.get('win_rate', 0)}% WR"
            )
        logger.info("Shutdown complete.")


def main():
    parser = argparse.ArgumentParser(description="PredictionBot v4.0 -- Edge Edition")
    parser.add_argument("--once", action="store_true", help="Run a single scan and exit")
    args = parser.parse_args()

    config = load_config()
    bot = PredictionBot(config)

    if args.once:
        bot.run_once()
    else:
        bot.run_loop()


if __name__ == "__main__":
    main()

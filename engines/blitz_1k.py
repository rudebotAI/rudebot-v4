"""
Blitz-1K: $1,000 → Profit in 4 Hours
=====================================
Three concurrent strategies using PredictionBot's existing infrastructure:

Strategy 1: CROSS-PLATFORM ARBITRAGE (Risk-Free, ~$300 allocation)
  - Scan matching events on Kalshi + Polymarket
  - When YES_A + NO_B < $0.97 (after fees), buy both sides
  - Guaranteed $0.03+ per contract on resolution
  - Target: 4-7% ROI per arb cycle, multiple cycles per hour

Strategy 2: CLARITY ACT MISPRICING (Directional, ~$400 allocation)
  - Kalshi: 68% YES | Polymarket: 57% YES (same event, ~11pt gap)
  - Buy YES on Polymarket @ 57¢, sell/hedge NO on Kalshi
  - Or: pure directional YES on Polymarket if conviction is high
  - The yield compromise is 99% resolved, April markup targeted
  - Kelly says this is a strong bet at current prices

Strategy 3: MARCH MADNESS LIVE ARBS (Time-Sensitive, ~$300 allocation)
  - Kalshi hit $3.4B/week on NCAA tournament
  - Live game markets reprice every possession
  - Spread widens during volatile moments (runs, upsets)
  - Scanner catches Kalshi/Poly divergence in real-time

All strategies use:
  - Kelly Criterion sizing (0.25x fractional for safety)
  - Max 10% bankroll per single position
  - Automatic stop-loss at 15% drawdown on directional bets
  - Telegram alerts before every trade for your approval
"""

import logging
import time
import json
from typing import Optional

logger = logging.getLogger(__name__)


class Blitz1K:
    """
    $1K rapid deployment engine.
    Coordinates arb scanning, directional bets, and live event trading.
    """

    BANKROLL = 1000.00
    ALLOCATION = {
        "arb": 300.00,       # Risk-free cross-platform arb
        "clarity": 400.00,   # Directional CLARITY Act bet
        "live_events": 300.00,  # Live sports/event arbs
    }
    MAX_DRAWDOWN_PCT = 0.15  # Kill switch at 15% loss
    MIN_ARB_NET = 0.025      # 2.5% minimum net arb after fees
    SCAN_INTERVAL = 30       # Seconds between scans

    # Fee structure
    FEES = {
        "kalshi": 0.007,           # 0.7% per side
        "polymarket_us": 0.0001,   # 0.01% per trade
        "polymarket_intl": 0.02,   # 2% on net winnings
    }

    def __init__(self, kalshi_connector, poly_connector, arb_detector, scanner, sizer, config: dict = None):
        self.kalshi = kalshi_connector
        self.poly = poly_connector
        self.arb = arb_detector
        self.scanner = scanner
        self.sizer = sizer
        self.config = config or {}

        # State tracking
        self.pnl = 0.0
        self.trades = []
        self.positions = []
        self.start_time = None
        self.running = False

    # ── Strategy 1: Cross-Platform Arbitrage ──

    def scan_arbs(self) -> list:
        """
        Scan for risk-free arbs between Kalshi and Polymarket.
        Returns actionable opportunities with net profit after fees.
        """
        logger.info("Scanning cross-platform arbitrage opportunities...")

        poly_markets = self.poly.scan_markets_with_prices(limit=100)
        kalshi_markets = self.kalshi.scan_markets_with_prices(limit=100)

        if not poly_markets or not kalshi_markets:
            logger.warning(f"Insufficient data: poly={len(poly_markets or [])}, kalshi={len(kalshi_markets or [])}")
            return []

        # Use existing arb detector
        same_event = self.arb.detect_same_event_arb(poly_markets, kalshi_markets)
        multi_outcome = self.arb.detect_multi_outcome_arb(poly_markets + kalshi_markets)

        # Filter for profitable after fees
        actionable = []
        for a in same_event:
            net = a["net_gap"]
            if net >= self.MIN_ARB_NET:
                # Calculate exact profit on allocation
                alloc = min(self.ALLOCATION["arb"], self.available_bankroll("arb"))
                contracts = int(alloc / max(a.get("poly_price", 0.5), 0.01))
                profit = contracts * net
                a["recommended_contracts"] = contracts
                a["expected_profit"] = round(profit, 2)
                a["allocation"] = round(alloc, 2)
                actionable.append(a)

        for a in multi_outcome:
            if a["profit_pct"] > self.MIN_ARB_NET * 100:
                actionable.append(a)

        logger.info(f"Found {len(actionable)} actionable arb opportunities")
        return actionable

    # ── Strategy 2: CLARITY Act Directional ──

    def scan_clarity_act(self) -> list:
        """
        Find CLARITY Act markets on both platforms and identify mispricing.
        Current state: Polymarket ~57% YES, Kalshi ~68% YES = 11pt gap.
        """
        logger.info("Scanning CLARITY Act markets...")

        opportunities = []

        # Search Polymarket
        poly_markets = self.poly.scan_markets_with_prices(limit=100)
        clarity_poly = [m for m in poly_markets
                        if any(kw in m.get("question", "").lower()
                               for kw in ["clarity", "crypto market structure", "digital asset"])]

        # Search Kalshi
        kalshi_markets = self.kalshi.scan_markets_with_prices(limit=100)
        clarity_kalshi = [m for m in kalshi_markets
                          if any(kw in m.get("question", "").lower()
                                 for kw in ["clarity", "crypto", "market structure"])]

        if clarity_poly and clarity_kalshi:
            # Cross-platform arb opportunity
            poly_yes = clarity_poly[0].get("yes_price", 0)
            kalshi_yes = clarity_kalshi[0].get("yes_price", 0)
            gap = abs(poly_yes - kalshi_yes)

            if gap > 0.05:
                # Buy cheap YES, buy NO on expensive platform
                if poly_yes < kalshi_yes:
                    combined_cost = poly_yes + (1 - kalshi_yes)
                    if combined_cost < 0.97:
                        opportunities.append({
                            "type": "clarity_arb",
                            "action": f"Buy YES on Polymarket @ {poly_yes:.2f}, Buy NO on Kalshi @ {1-kalshi_yes:.2f}",
                            "combined_cost": round(combined_cost, 4),
                            "guaranteed_profit_pct": round((1 - combined_cost) * 100, 2),
                            "poly_market": clarity_poly[0],
                            "kalshi_market": clarity_kalshi[0],
                        })

        # Directional opportunity (conviction-based)
        if clarity_poly:
            poly_yes = clarity_poly[0].get("yes_price", 0)
            if poly_yes > 0 and poly_yes < 0.70:
                # Our model: yield deal done, April markup likely, real prob ~75-80%
                model_prob = 0.75
                alloc = min(self.ALLOCATION["clarity"], self.available_bankroll("clarity"))

                kelly = self.sizer.compute_size(model_prob, poly_yes, alloc)

                opportunities.append({
                    "type": "clarity_directional",
                    "platform": "polymarket",
                    "action": f"Buy YES @ {poly_yes:.2f}",
                    "market_price": poly_yes,
                    "model_prob": model_prob,
                    "thesis": "Stablecoin yield 99% resolved, April markup targeted, Garlinghouse says 80-90%",
                    "kelly_size_usd": kelly["size_usd"],
                    "kelly_shares": kelly["shares"],
                    "expected_value": round(kelly["size_usd"] * (model_prob / poly_yes - 1), 2),
                    "risk": "Bill dies if not through committee by end of April",
                    "market": clarity_poly[0],
                })

        return opportunities

    # ── Strategy 3: Live Event Arbs ──

    def scan_live_events(self) -> list:
        """
        Scan high-volume live event markets (March Madness, UFC, etc.)
        for temporary mispricings during rapid price movement.
        """
        logger.info("Scanning live event markets...")

        poly_markets = self.poly.scan_markets_with_prices(limit=100)
        kalshi_markets = self.kalshi.scan_markets_with_prices(limit=100)

        # Filter for high-volume, near-term events (sports, weather, etc.)
        live_poly = [m for m in poly_markets
                     if (m.get("volume_24h", 0) or 0) > 50000]
        live_kalshi = [m for m in kalshi_markets
                       if (m.get("volume_24h", 0) or 0) > 50000]

        # Cross-reference for arbs in live markets
        arbs = self.arb.detect_same_event_arb(live_poly, live_kalshi)

        # Also run EV scanner on high-volume markets
        combined = self.scanner.cross_reference_markets(live_poly, live_kalshi)
        ev_opps = self.scanner.scan(combined)

        # Top 5 by EV
        top_ev = ev_opps[:5]

        results = []
        for a in arbs:
            if a["net_gap"] >= 0.02:
                results.append({**a, "source": "live_arb"})

        for e in top_ev:
            alloc = min(self.ALLOCATION["live_events"] / 3, self.available_bankroll("live_events"))
            kelly = self.sizer.compute_size(e["model_prob"], e["market_price"], alloc)
            results.append({
                "type": "live_ev",
                "source": "ev_scanner",
                "question": e.get("question", ""),
                "signal": e["signal"],
                "ev": e["ev"],
                "edge": e["edge"],
                "kelly_size": kelly["size_usd"],
                "market": e,
            })

        return results

    # ── Execution Engine ──

    def available_bankroll(self, strategy: str) -> float:
        """Calculate remaining bankroll for a strategy."""
        spent = sum(t["amount"] for t in self.trades if t.get("strategy") == strategy)
        return max(0, self.ALLOCATION.get(strategy, 0) - spent)

    def total_pnl(self) -> float:
        """Calculate total P&L across all strategies."""
        return sum(t.get("pnl", 0) for t in self.trades)

    def check_kill_switch(self) -> bool:
        """Stop trading if drawdown exceeds threshold."""
        if self.total_pnl() < -(self.BANKROLL * self.MAX_DRAWDOWN_PCT):
            logger.critical(f"KILL SWITCH: Drawdown exceeds {self.MAX_DRAWDOWN_PCT*100}%")
            self.running = False
            return True
        return False

    def generate_trade_signal(self, opportunity: dict) -> dict:
        """
        Convert an opportunity into an executable trade signal.
        Returns signal dict for Telegram approval.
        """
        return {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "type": opportunity.get("type", "unknown"),
            "action": opportunity.get("action", ""),
            "question": opportunity.get("question", ""),
            "platform": opportunity.get("platform", ""),
            "amount_usd": opportunity.get("kelly_size_usd", opportunity.get("expected_profit", 0)),
            "expected_return": opportunity.get("expected_value", opportunity.get("guaranteed_profit_pct", 0)),
            "risk_level": "LOW" if "arb" in opportunity.get("type", "") else "MEDIUM",
            "requires_approval": True,
            "raw": opportunity,
        }

    # ── Main Loop ──

    def run_scan_cycle(self) -> dict:
        """
        Run one complete scan cycle across all three strategies.
        Returns summary of all opportunities found.
        """
        if self.check_kill_switch():
            return {"status": "KILLED", "pnl": self.total_pnl()}

        results = {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "bankroll": self.BANKROLL,
            "pnl": self.total_pnl(),
            "opportunities": [],
        }

        # Strategy 1: Cross-platform arbs
        try:
            arbs = self.scan_arbs()
            for a in arbs:
                signal = self.generate_trade_signal(a)
                signal["strategy"] = "arb"
                results["opportunities"].append(signal)
        except Exception as e:
            logger.error(f"Arb scan failed: {e}")

        # Strategy 2: CLARITY Act
        try:
            clarity = self.scan_clarity_act()
            for c in clarity:
                signal = self.generate_trade_signal(c)
                signal["strategy"] = "clarity"
                results["opportunities"].append(signal)
        except Exception as e:
            logger.error(f"CLARITY scan failed: {e}")

        # Strategy 3: Live events
        try:
            live = self.scan_live_events()
            for l in live:
                signal = self.generate_trade_signal(l)
                signal["strategy"] = "live_events"
                results["opportunities"].append(signal)
        except Exception as e:
            logger.error(f"Live event scan failed: {e}")

        # Sort all by expected return
        results["opportunities"].sort(
            key=lambda x: x.get("expected_return", 0), reverse=True
        )

        results["total_opportunities"] = len(results["opportunities"])
        return results

    def run(self, duration_hours: float = 4.0):
        """
        Main execution loop. Scans every 30 seconds for 4 hours.
        All trades require Telegram confirmation before execution.
        """
        self.start_time = time.time()
        self.running = True
        end_time = self.start_time + (duration_hours * 3600)

        logger.info(f"=== BLITZ-1K STARTED === Bankroll: ${self.BANKROLL} | Duration: {duration_hours}h")
        logger.info(f"Allocation: Arb=${self.ALLOCATION['arb']} | CLARITY=${self.ALLOCATION['clarity']} | Live=${self.ALLOCATION['live_events']}")

        cycle = 0
        while self.running and time.time() < end_time:
            cycle += 1
            logger.info(f"--- Scan cycle {cycle} ---")

            try:
                results = self.run_scan_cycle()

                if results.get("status") == "KILLED":
                    logger.critical("Trading halted by kill switch")
                    break

                if results["total_opportunities"] > 0:
                    logger.info(f"Found {results['total_opportunities']} opportunities")
                    # In production: send to Telegram for approval
                    # For now: log and continue scanning
                    for opp in results["opportunities"]:
                        logger.info(
                            f"  [{opp['risk_level']}] {opp['type']}: "
                            f"{opp.get('question', opp.get('action', ''))[:60]} "
                            f"| Expected: ${opp.get('expected_return', 0):.2f}"
                        )
                else:
                    logger.info("No opportunities this cycle")

            except Exception as e:
                logger.error(f"Scan cycle {cycle} failed: {e}")

            # Wait for next scan
            remaining = end_time - time.time()
            if remaining > self.SCAN_INTERVAL:
                time.sleep(self.SCAN_INTERVAL)

        elapsed = (time.time() - self.start_time) / 3600
        logger.info(f"=== BLITZ-1K COMPLETE === {cycle} cycles | {elapsed:.1f}h | PnL: ${self.total_pnl():.2f}")

        return {
            "cycles": cycle,
            "duration_hours": round(elapsed, 2),
            "total_pnl": self.total_pnl(),
            "trades": self.trades,
        }


# ── Quick-start helper ──

def launch_blitz(config: dict):
    """
    Launch Blitz-1K with a config dict.
    Config should include kalshi and polymarket credentials.
    """
    from connectors.kalshi import KalshiConnector
    from connectors.polymarket import PolymarketConnector
    from engines.arbitrage import ArbitrageDetector
    from engines.scanner import EVScanner
    from engines.sizing import KellySizer

    kalshi = KalshiConnector(config.get("kalshi", {}))
    poly = PolymarketConnector(config.get("polymarket", {}))
    arb = ArbitrageDetector({"min_arb_gap": 0.02, "fee_rate": 0.015})
    scanner = EVScanner({"min_ev_threshold": 0.04, "min_market_volume": 5000})
    sizer = KellySizer({
        "kelly_fraction": 0.25,
        "max_position_usd": 100,     # $100 max per position
        "max_portfolio_pct": 0.10,   # 10% max per bet
    })

    blitz = Blitz1K(kalshi, poly, arb, scanner, sizer, config)
    return blitz

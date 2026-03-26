"""
Safety Guard System â€” Production-Grade Protection
===================================================
Upgrades from in-memory risk manager to persistent, multi-layer safety:

1. Per-order hard caps (never exceed regardless of Kelly)
2. Per-market investment caps
3. Emergency stop (keyboard/Telegram/file-based)
4. Persistent state across restarts
5. Rate limiting on order submission
6. Daily/hourly drawdown limits
7. Position concentration limits

Reference: 4coinsbot safety_guard.py
"""

import json
import time
import logging
import threading
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Optional

logger = logging.getLogger(__name__)

EMERGENCY_STOP_FILE = "EMERGENCY_STOP"


class SafetyGuard:
    """
    Multi-layer safety system that persists across restarts.

    Features:
    - Per-order caps (hard limit, never exceeded)
    - Per-market cumulative caps
    - Hourly and daily drawdown circuit breakers
    - Rate limiting (max orders per minute)
    - Emergency stop file (touch EMERGENCY_STOP to halt)
    - Persistent state in JSON
    - Thread-safe
    """

    def __init__(self, config: dict = None, state_file: str = "logs/safety_state.json"):
        config = config or {}
        self._lock = threading.RLock()  # Re-entrant: status() calls validate_order()

        # â”€â”€ Hard Limits â”€â”€
        self.max_order_usd = config.get("max_order_usd", 50.0)
        self.max_market_investment = config.get("max_market_investment", 200.0)
        self.max_daily_loss = config.get("max_daily_loss_usd", 100.0)
        self.max_hourly_loss = config.get("max_hourly_loss_usd", 50.0)
        self.max_open_positions = config.get("max_open_positions", 5)
        self.max_orders_per_minute = config.get("max_orders_per_minute", 10)
        self.max_portfolio_pct = config.get("max_portfolio_pct", 0.10)
        self.cooldown_min = config.get("cooldown_after_stop_min", 60)
        self.bankroll = config.get("bankroll_usd", 1000.0)

        # â”€â”€ State (persistent) â”€â”€
        self.state_file = Path(state_file)
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self._state = self._load_state()

        # â”€â”€ Rate limiter â”€â”€
        self._order_timestamps = []  # List of recent order timestamps

        # â”€â”€ Emergency stop â”€â”€
        self._emergency_stopped = False
        self._check_emergency_stop_file()

    def _load_state(self) -> dict:
        """Load persistent safety state."""
        if self.state_file.exists():
            try:
                with open(self.state_file) as f:
                    state = json.load(f)
                    # Reset daily counters if new day
                    if state.get("date") != datetime.now(timezone.utc).strftime("%Y-%m-%d"):
                        state["daily_pnl"] = 0.0
                        state["daily_orders"] = 0
                        state["hourly_pnl"] = 0.0
                        state["hourly_orders"] = 0
                        state["date"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                    logger.info(f"Safety state loaded: {state.get('total_orders', 0)} lifetime orders")
                    return state
            except Exception as e:
                logger.warning(f"Safety state corrupt, starting fresh: {e}")

        return {
            "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "hour": datetime.now(timezone.utc).hour,
            "daily_pnl": 0.0,
            "hourly_pnl": 0.0,
            "daily_orders": 0,
            "hourly_orders": 0,
            "total_orders": 0,
            "total_pnl": 0.0,
            "open_positions": 0,
            "market_investments": {},  # market_id â†’ cumulative USD
            "consecutive_losses": 0,
            "halted": False,
            "halt_reason": "",
            "halt_until": None,
            "last_order_time": None,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        }

    def _save_state(self):
       """Persist safety state to disk."""
        self._state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            with open(self.state_file, "w") as f:
                json.dump(self._state, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save safety state: {e}")

    def _reset_hourly(self):
        """Reset hourly counters."""
        current_hour = datetime.now(timezone.utc).hour
        if current_hour != self._state.get("hour"):
            self._state["hourly_pnl"] = 0.0
            self._state["hourly_orders"] = 0
            self._state["hour"] = current_hour
        
    def _reset_daily(self):
        """Reset daily counters."""
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        if today != self._state.get("date"):
            logger.info(f"New day â€” resetting daily safety counters (was P&L: {self._state['daily_pnl']:.2f})")
            self._state["daily_pnl"] = 0.0
            self._state["daily_orders"] = 0
            self._state["date"] = today
            # Clear market investments for new day
            self._state["market_investments"] = {}

    def _check_emergency_stop_file(self):
        """Check for EMERGENCY_STOP file."""
        if Path(EMERGENCY_STOP_FILE).exists():
            self._emergency_stopped = True
            logger.critical("EMERGENCY STOP FILE DETECTED â€” all trading halted")

    # â”€â”€ Pre-Trade Validation â”€â”€

    def validate_order(self, market_id: str, size_usd: float) -> tuple:
        """
        Full pre-trade validation. Returns (allowed, reason).

        Checks (in order):
        1. Emergency stop
        2. Circuit breaker halt
        3. Per-order cap
        4. Portfolio percentage cap
        5. Per-market cumulative cap
        6. Daily loss limit
        7. Hourly loss limit
        8. Max open positions
        9. Rate limit
        """
        with self._lock:
            self._reset_daily()
            self._reset_hourly()
            self._check_emergency_stop_file()

            # 1. Emergency stop
            if self._emergency_stopped:
                return False, "EMERGENCY STOP active"

            # 2. Circuit breaker
            if self._state.get("halted"):
                halt_until = self._state.get("halt_until")
                if halt_until:
                    try:
                        until = datetime.fromisoformat(halt_until)
                        if datetime.now(timezone.utc) < until:
                            remaining = (until - datetime.now(timezone.utc)).seconds // 60
                            return False, f"Halted: {self._state.get('halt_reason')} ({remaining}m left)"
                        else:
                            self._state["halted"] = False
                            self._state["halt_reason"] = ""
                            self._state["halt_until"] = None
                    except Exception:
                        pass
                else:
                    return False, f"Halted: {self._state.get('halt_reason')}"

            # 3. Per-order cap
            if size_usd > self.max_order_usd:
                return False, f"Order ${size_usd:.2f} exceeds max ${self.max_order_usd:.2f}"

            # 4. Portfolio percentage
            if self.bankroll > 0 and size_usd / self.bankroll > self.max_portfolio_pct:
                return False, f"Order ${size_usd:.2f} exceeds {self.max_portfolio_pct*100:.0f}% of bankroll"

            # 5. Per-market cumulative cap
            market_invested = self._state["market_investments"].get(market_id, 0)
            if market_invested + size_usd > self.max_market_investment:
                return False, f"Market investment cap: {[market_invested:.2f} + ${size_usd:.2f} > ${self.max_market_investment:.2f}"

            # 6. Daily loss limit
            if self._state["daily_pnl"] <= -self.max_daily_loss:
                self._halt(f"Daily loss limit (${self.max_daily_loss})")
                return False, self._state["halt_reason"]

            # 7. Hourly loss limit
            if self._state["hourly_pnl"] <= -self.max_hourly_loss:
                self._halt(f"Hourly loss limit (${self.max_hourly_loss})", cooldown_min=15)
                return False, self._state["halt_reason"]

            # 8. Max open positions
            if self._state["open_positions"] >= self.max_open_positions:
                return False, f"Max positions ({self.max_open_positions}) reached"

            # 9. Rate limit
            now = time.time()
            self._order_timestamps = [t for t in self._order_timestamps if now - t < 60]
            if len(self._order_timestamps) >= self.max_orders_per_minute:
                return False, f"Rate limit: {self.max_orders_per_minute} orders/min exceeded"

            return True, "OK"

    def record_order(self, market_id: str, size_usd: float):
        """Record a successful order placement."""
        with self._lock:
            self._state["total_orders"] += 1
            self._state["daily_orders"] += 1
            self._state["hourly_orders"] += 1
            self._state["open_positions"] += 1
            self._state["last_order_time"] = time.strftime("%Y-%m-%dT%H:%M:%SZ")

            # Track per-market investment
            prev = self._state["market_investments"].get(market_id, 0)
            self._state["market_investments"][market_id] = prev + size_usd

            self._order_timestamps.append(time.time())
            self._save_state()

    def record_result(self, pnl: float):
       """Record a trade result (win or loss)."""
        with self._lock:
            self._state["daily_pnl"] += pnl
            self._state["hourly_pnl"] += pnl
            self._state["total_pnl"] += pnl
            self._state["open_positions"] = max(
0, self._state["open_positions"] - 1)

            if pnl < 0:
                self._state["consecutive_losses"] += 1
                if self._state["consecutive_losses"] >= 5:
                    self._halt("5 consecutive losses")
            else:
                self._state["consecutive_losses"] = 0

            self._save_state()

    def _halt(self, reason: str, cooldown_min: int = None):
       """Activate circuit breaker."""
        cd = cooldown_min or self.cooldown_min
        until = datetime.now(timezone.utc) + timedelta(minutes=cd)
        self._state["halted"] = True
        self._state["halt_reason"] = reason
        self._state["halt_until"] = until.isoformat()
        self._save_state()
        logger.critical(f"SAFETY HALT: {reason} â”€â”€â”€â”€â”€øÁ…ÕÍ•™½Èí‘õ´ˆ¤((€€€‘•˜•µ•É•¹å}ÍÑ½À¡Í•±˜¤è(€€€€€€€ˆˆ‰Ñ¥Ù…Ñ”•µ•É•¹äÍÑ½À¸ˆˆˆ(€€€€€€€Í•±˜¹}•µ•É•¹å}ÍÑ½ÁÁ•€ôQÉÕ”(€€€€€€€€ŒÉ•…Ñ”™¥±”Í¼¥ĞÁ•ÉÍ¥ÍÑÌ…É½ÍÌÉ•ÍÑ…ÉÑÌ(€€€€€€€A…Ñ ¡5I9e}MQ=A}%1¤¹Ñ½Õ  ¤(€€€€€€€Í•±˜¹}ÍÑ…Ñ•l‰¡…±Ñ•‰t€ôQÉÕ”(€€€€€€€Í•±˜¹}ÍÑ…Ñ•l‰¡…±Ñ}É•…Í½¸‰t€ô€‰5I9dMQ=@ˆ(€€€€€€€Í•±˜¹}Í…Ù•}ÍÑ…Ñ” ¤(€€€€€€€±½•È¹É¥Ñ¥…° ‰5I9dMQ=@Q%YQˆ¤((€€€‘•˜±•…É}•µ•É•¹å}ÍÑ½À¡Í•±˜¤è(€€€€€€€€ˆˆ‰±•…È•µ•É•¹äÍÑ½À¸ˆˆˆ(€€€€€€€Í•±˜¹}•µ•É•¹å}ÍÑ½ÁÁ•€ô…±Í”(€€€€€€€ÑÉäè(€€€€€€€€€€€A…Ñ ¡5I9e}MQ=A}%1¤¹Õ¹±¥¹¬¡µ¥ÍÍ¥¹}½¬õQÉÕ”¤(€€€€€€€•á•ÁĞá•ÁÑ¥½¸è(€€€€€€€€€€€Á…ÍÌ(€€€€€€€Í•±˜¹}ÍÑ…Ñ•l‰¡…±Ñ•‰t€ô…±Í”(€€€€€€€Í•±˜¹}ÍÑ…Ñ•l‰¡…±Ñ}É•…Í½¸‰t€ô€ˆˆ(€€€€€€€Í•±˜¹}ÍÑ…Ñ•l‰¡…±Ñ}Õ¹Ñ¥°‰t€ô9½¹”(€€€€€€€Í•±˜¹}Í…Ù•}ÍÑ…Ñ” ¤(€€€€€€€±½•È¹¥¹™¼ ‰µ•É•¹äÍÑ½À±•…É•ˆ¤((€€€‘•˜µ…¹Õ…±}É•ÍÕµ”¡Í•±˜¤è(€€€€€€€ˆˆ‰I•ÍÕµ”…™Ñ•È¡…±Ğ¸ˆˆˆ(€€€€€€€İ¥Ñ Í•±˜¹}±½¬è(€€€€€€€€€€€Í•±˜¹}ÍÑ…Ñ•l‰¡…±Ñ•‰t€ô…±Í”(€€€€€€€€€€€Í•±˜¹}ÍÑ…Ñ•l‰¡…±Ñ}É•…Í½¸‰t€ô€ˆˆ(€€€€€€€€€€€Í•±˜¹}ÍÑ…Ñ•l‰¡…±Ñ}Õ¹Ñ¥°‰t€ô9½¹”(€€€€€€€€€€€Í•±˜¹}ÍÑ…Ñ•l‰½¹Í•ÕÑ¥Ù•}±½ÍÍ•Ì‰t€ô€À(€€€€€€€€€€€Í•±˜¹}Í…Ù•}ÍÑ…Ñ” ¤(€€€€€€€±½•È¹¥¹™¼ ‰M…™•ÑäÕ…ÉèÑÉ…‘¥¹œÉ•ÍÕµ•µ…¹Õ…±±äˆ¤((€€€‘•˜ÍÑ…ÑÕÌ¡Í•±˜¤€´ø‘¥Ğè(€€€€€€€€ˆˆ‰Õ±°Í…™•ÑäÍÑ…ÑÕÌ¸ˆˆˆ(€€€€€€€İ¥Ñ Í•±˜¹}±½¬è(€€€€€€€€€€€…¹}ÑÉ…‘”°É•…Í½¸€ôÍ•±˜¹Ù…±¥‘…Ñ•}½É‘•È ‰}}¡•­}|ˆ°€Ä¸À¤(€€€€€€€€€€€É•ÑÕÉ¸ì(€€€€€€€€€€€€€€€€‰…¹}ÑÉ…‘”ˆè…¹}ÑÉ…‘”°(€€€€€€€€€€€€€€€€‰É•…Í½¸ˆèÉ•…Í½¸°(€€€€€€€€€€€€€€€€‰‘…¥±å}Á¹°ˆèÉ½Õ¹¡Í•±˜¹}ÍÑ…Ñ•l‰‘…¥±å}Á¹°‰t°€È¤°(€€€€€€€€€€€€€€€€‰¡½ÕÉ±å}Á¹°ˆèÉ½Õ¹¡Í•±˜¹}ÍÑ…Ñ•l‰¡½ÕÉ±å}Á¹°‰t°€È¤°(€€€€€€€€€€€€€€€€‰Ñ½Ñ…±}Á¹°ˆèÉ½Õ¹¡Í•±˜¹}ÍÑ…Ñ•l‰Ñ½Ñ…±}Á¹°‰t°€È¤°(€€€€€€€€€€€€€€€€‰‘…¥±å}½É‘•ÉÌˆèÍ•±˜¹}ÍÑ…Ñ•l‰‘…¥±å}½É‘•ÉÌ‰t°(€€€€€€€€€€€€€€€€‰Ñ½Ñ…±}½É‘•ÉÌˆèÍ•±˜¹}ÍÑ…Ñ•l‰Ñ½Ñ…±}½É‘•ÉÌ‰t°(€€€€€€€€€€€€€€€€‰½Á•¹}Á½Í¥Ñ¥½¹ÌˆèÍ•±˜¹}ÍÑ…Ñ•l‰½Á•¹}Á½Í¥Ñ¥½¹Ì‰t°(€€€€€€€€€€€€€€€€‰½¹Í•ÕÑ¥Ù•}±½ÍÍ•ÌˆèÍ•±˜¹}ÍÑ…Ñ•l‰½¹Í•ÕÑ¥Ù•}±½ÍÍ•Ì‰t°(€€€€€€€€€€€€€€€€‰¡…±Ñ•ˆèÍ•±˜¹}ÍÑ…Ñ”¹•Ğ ‰¡…±Ñ•ˆ°…±Í”¤°(€€€€€€€€€€€€€€€€‰¡…±Ñ}É•…Í½¸ˆèÍ•±˜¹}ÍÑ…Ñ”¹•Ğ ‰¡…±Ñ}É•…Í½¸ˆ°€ˆˆ¤°(€€€€€€€€€€€€€€€€‰•µ•É•¹å}ÍÑ½ÁÁ•ˆèÍ•±˜¹}•µ•É•¹å}ÍÑ½ÁÁ•°(€€€€€€€€€€€€€€€€‰µ…á}½É‘•É}ÕÍˆèÍ•±˜¹µ…á}½É‘•É}ÕÍ°(€€€€€€€€€€€€€€€€‰µ…á}‘…¥±å}±½ÍÌˆèÍ•±˜¹µ…á}‘…¥±å}±½ÍÌ°(€€€€€€€€€€€ô
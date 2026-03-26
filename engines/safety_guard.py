"""
Safety Guard System -- Production-Grade Protection
===================================================
Upgrades from in-memory risk manager to persistent, multi-layer safety:

1. Per-order hard caps (never exceed regardless of Kelly)
2. Per-market investment caps
3. Emergency stop (keyboard/Telegram/file-based)
4. Persistent state across restarts
5. Rate limiting on order submission
6. Daily/hourly drawdown limits
7. Position concentration limits

Reference: 4coinsbot safety_guard.py"""

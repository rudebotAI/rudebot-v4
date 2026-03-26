"""
Backtesting Framework -- CSV Logging + Strategy Replay
======================================================
Two components:
1. DataLogger: Logs every scan cycle to CSV for replay
2. Backtester: Replays historical data through strategies

CSV format follows polyrec pattern: timestamp, prices, indicators,
orderbook data, and signals -- everything needed to reconstruct
the decision environment.

Usage:
    # Live: log data
    logger = DataLogger("logs/backtest/")
    logger.log_tick(markets, opporunities, indicators)

    # Offline: replay
    bt = Backtester("logs/backtest/2026-03-25.csv")
    results = bt.run(strategy_fn)

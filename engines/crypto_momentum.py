"""
Crypto Momentum Engine — Institutional-Grade Short-Term BTC Price Tracking
============================================================================
Connects Coinbase real-time price data to Kalshi's hourly/15-min BTC prediction
markets. Uses technical indicators (RSI, Bollinger Bands, EMA crossovers, VWAP,
ATR) to estimate directional probabilities for "BTC above $X" contracts.

Institutional Metrics:
- RSI (Relative Strength Index) — overbought/oversold signals
- Bollinger Band %B — mean-reversion detection
- EMA 9/21 crossover — trend confirmation
- VWAP deviation — institutional fair value
- ATR-normalized moves — volatility-adjusted signals
- Composite score → probability estimate for Kalshi crypto contracts

Architecture:
    CoinbaseConnector → candles → CryptoMomentumEngine → probability →
    EVScanner → KellySizer → OrderRouter

Designed as a reusable sub-engine: any future bot can import this module.
"""
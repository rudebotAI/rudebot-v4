"""
Bot Skeleton Framework -- Reusable Base Classes for Future Bot Projects
=======================================================================
Provides the foundational architecture for building any trading or
monitoring bot. All bots in this system inherit from these base classes.

Architecture pattern:
    BaseBot (lifecycle, config, logging)
        └── BaseSubBot (threading, start/stop, health checks)
             ├── PriceTracker
             └── NewsSentinel
             └── [your future sub-bot]

    BaseEngine (stateless compute, indicators)
        ├── CryptoMomentumEngine
        ├── EVScanner
        └── [your future engine]

    BaseConnector (API client, auth, rate limiting)
        ├── KalshiConnector
        ├── CoinbaseConnector
        └── [your future connector]

Usage:
    from subbots.base import BaseBot, BaseSubBot, BaseEngine, BaseConnector

    class MyNewBot(BaseBot):
        def _tick(self):
            # Your scan logic here
            pass

    class MyDataFeed(BaseSubBot):
        def _poll_once(self):
            # Your data collection here
            pass
"""
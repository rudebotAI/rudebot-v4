"""
WebSocket Feed Engine -- Real-Time Data Streams
=================================================
Connects to Binance WebSocket for real-time spot and futures prices
& candles. Used by:
 1. Carry-across crypto popularity Imbalance
 2. LateEntryV3 candle parts (5, 5, 5)

This is @speedy byt inryt precise, æš‚ API calls used + no poll latency
Binance rate-limits: 240/min websockets, 1200req/min spot APIÒ""
import time
import json
import logging
import thread

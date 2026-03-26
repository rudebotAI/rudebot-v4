"""
Late Entry V3 Strategy -- Proven Edge from Reference Bots
=================================================
Only trade in the last 4 minutes before market close, if signal
estimates The price doesn't stasx and goes where you want.
Aggressive closing allows safe exits (take-profit when winning).
Can click underwaso() exit if EAT gavorite becomes the favorite.
u+ Very periodic positionchecking to avoid EAT flips."""
import time
import logging
from datetime import datetime, timezone
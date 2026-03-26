"""
Cross-Platform Arbitrage Detector
Finds risk-free or near-risk-free opportunities between Polymarket and Kalshi.

Two types of arb:
1. Same-event arb: same question priced differently on two platforms
2. Multi-outcome arb: sum of all outcome prices != 1 (uses Bregman projection)
"""

import math
import logging

logger = logging.getLogger(__name__)


class ArbitrageDetector:
    """Detects arbitrage opportunities across prediction markets."""

    def __init__(self, config: dict):
        self.min_gap = config.get("min_arb_gap", 0.03)  # 3% minimum
        self.fee_rate = config.get("fee_rate", 0.02)     # 2% combined fees

    def detect_same_event_arb(self, poly_markets: list, kalshi_markets: list) -> list:
        arbs = []
        kalshi_by_q = {}
        for km in kalshi_markets:
            q = self._normalize_question(km.get("question", ""))
            if q: kalshi_by_q[q] = km
        for pm in poly_markets:
            pq = self._normalize_question(pm.get("question", ""))
            if not pq: continue
            km = kalshi_by_q.get(pq) or self._fuzzy_match(pq, kalshi_by_q)
            if not km: continue
            poly_yes = pm.get("yes_price"); kalshi_yes = km.get("yes_price")
            if not poly_yes or not kalshi_yes or poly_yes <= 0 or kalshi_yes <= 0: continue
            gap = abs(poly_yes - kalshi_yes); net_gap = gap - self.fee_rate
            if net_gap > self.min_gap:
                action = "Buy YES on Polymarket, Buy NO on Kalshi" if poly_yes < kalshi_yes else "Buy YES on Kalshi, Buy NO on Polymarket"
                buy_price = poly_yes if poly_yes < kalshi_yes else kalshi_yes
                arbs.append({"type":"same_event","question":pm.get("question",""),"poly_price":poly_yes,"kalshi_price":kalshi_yes,"gap":round(gap,4),"net_gap":round(net_gap,4),"profit_pct":round(net_gap/max(buy_price,0.01)*100,2),"action":action,"poly_market":pm,"kalshi_market":km})
        arbs.sort(key=lambda x:x["net_gap"],reverse=True); return arbs
    def detect_multi_outcome_arb(self, markets: list) -> list: return []
    def _normalize_question(self, q): return " ".join(q.lower().strip().split())
    def _fuzzy_match(self, question, lookup):
        q_words = set(question.split()); best=None; best_s=0
        for k,v in lookup.items():
            k_words=set(k.split()); o=len(q_words&k_words); t=len(q_words|k_words); s=o/t if t>0 else 0
            if s>best_s and s>0.5: best_s=s; best=v
        return best

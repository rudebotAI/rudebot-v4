import { useState, useRef, useCallback } from "react";
import { RULES } from "./config/rules";
import { ALL_STOCKS } from "./config/stocks";
import { C, stratColor, stratBg, SECTOR_COLORS } from "./config/theme";
import { fmt, fmtPct, fmtK } from "./utils/format";
import { generateStockData } from "./utils/stockData";
import { Spark, EquityCurve } from "./components/Charts";

/* ═══════════════════════════════════════════════════════════════════════════
   RUDEBOT v4 — STOCK TRADING ENGINE
   Multi-strategy equity bot: Momentum · Dividend · Mean Reversion · Sector Rotation
   ═══════════════════════════════════════════════════════════════════════════ */

export default function App() {
  const [inputCapital, setInputCapital] = useState("100000");
  const [portfolio, setPortfolio] = useState(0);
  const [cash, setCash] = useState(0);
  const [positions, setPositions] = useState([]);
  const [trades, setTrades] = useState([]);
  const [logs, setLogs] = useState([]);
  const [stockData, setStockData] = useState({});
  const [isRunning, setIsRunning] = useState(false);
  const [regime, setRegime] = useState("BULL");
  const [activeTab, setActiveTab] = useState("command");
  const [lastScan, setLastScan] = useState(null);
  const [analysis, setAnalysis] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [allTimeHigh, setAllTimeHigh] = useState(0);
  const [started, setStarted] = useState(false);
  const [equityCurve, setEquityCurve] = useState([]);
  const [scanCount, setScanCount] = useState(0);
  const [sectorBreakdown, setSectorBreakdown] = useState({});
  const scanRef = useRef(null);
  const stateRef = useRef({ cash: 0, positions: [], portfolio: 0 });

  const addLog = useCallback((msg, type = "info") => {
    setLogs((p) => [{ msg, type, time: new Date().toLocaleTimeString() }, ...p].slice(0, 500));
  }, []);

  // ── CORE ENGINE ──
  const runEngine = useCallback((cashIn, posIn, pvIn) => {
    setLastScan(new Date());
    setScanCount((c) => c + 1);
    const c = cashIn !== undefined ? cashIn : stateRef.current.cash;
    const pos = posIn !== undefined ? posIn : stateRef.current.positions;
    const pv = pvIn !== undefined ? pvIn : stateRef.current.portfolio;

    const newData = {};
    ALL_STOCKS.forEach((s) => { newData[s.symbol] = generateStockData(s); });

    // Regime detection
    const scores = Object.values(newData).map((d) => d.score);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const bullCount = scores.filter((s) => s > 55).length;
    const bearCount = scores.filter((s) => s < 45).length;
    const newRegime =
      avgScore > 60 && bullCount > ALL_STOCKS.length * 0.55 ? "BULL"
      : avgScore < 45 && bearCount > ALL_STOCKS.length * 0.55 ? "BEAR"
      : "SIDEWAYS";
    setRegime(newRegime);
    setStockData(newData);

    let newCash = c;
    let newPos = [...pos];
    const newTrades = [];

    // ── EXIT ENGINE ──
    newPos = newPos.filter((p) => {
      const d = newData[p.symbol];
      if (!d) return true;
      const cur = d.current;
      const entry = p.entryPrice;
      const pnlPct = (cur - entry) / entry;
      const sl = entry * (1 - RULES.STOP_LOSS_PCT);
      const tp = entry * (1 + RULES.TAKE_PROFIT_PCT);
      p.highWater = Math.max(p.highWater || entry, cur);
      const trail = Math.max(sl, p.highWater * (1 - RULES.TRAILING_STOP_PCT));
      let reason = null;

      if (cur <= trail && pnlPct < 0) reason = "Stop loss";
      else if (cur <= trail && pnlPct >= 0) reason = "Trail stop";
      else if (cur >= tp) reason = "Take profit";
      else if (d.score < 30 && pnlPct > 0) reason = "Signal exit";
      else if (d.sellSignals.length >= 3 && pnlPct > 0.02) reason = "Multi-signal exit";
      else if (d.rsi > 80 && pnlPct > 0.05) reason = "RSI overbought exit";

      // Sector overweight check
      const secVal = newPos
        .filter((pp) => pp.sector === p.sector && pp.symbol !== p.symbol)
        .reduce((a, pp) => a + pp.qty * (newData[pp.symbol]?.current || pp.entryPrice), 0) + cur * p.qty;
      if (secVal / pv > RULES.MAX_SECTOR_PCT + 0.1 && d.score < 50) reason = "Sector rebalance";

      if (reason) {
        const pnl = (cur - entry) * p.qty;
        newCash += cur * p.qty;
        newTrades.push({
          symbol: p.symbol, action: "SELL", qty: p.qty, price: cur, pnl, reason,
          strategy: p.strategy, time: new Date().toLocaleTimeString(), timestamp: Date.now(),
        });
        addLog(`SELL ${p.qty}x ${p.symbol} @ $${fmt(cur)} | ${pnl >= 0 ? "+" : ""}$${fmt(pnl)} | ${reason}`, pnl >= 0 ? "profit" : "loss");
        return false;
      }
      return true;
    });

    // ── ENTRY ENGINE ──
    if (newCash / pv > RULES.MIN_CASH_RESERVE_PCT + 0.03 && newPos.length < RULES.MAX_POSITIONS) {
      const held = new Set(newPos.map((p) => p.symbol));
      const minScore = newRegime === "BEAR" ? RULES.MIN_SCORE_BEAR : newRegime === "SIDEWAYS" ? RULES.MIN_SCORE_SIDEWAYS : RULES.MIN_SCORE_BULL;
      const candidates = Object.values(newData)
        .filter((d) => !held.has(d.symbol) && d.score >= minScore && d.buySignals.length >= 2 && d.rsi < 72 && d.rsi > 15)
        .sort((a, b) => b.score - a.score)
        .slice(0, newRegime === "BEAR" ? 2 : 4);

      for (const d of candidates) {
        if (newPos.length >= RULES.MAX_POSITIONS) break;
        const secVal = newPos.filter((p) => p.sector === d.sector).reduce((a, p) => a + p.qty * (newData[p.symbol]?.current || p.entryPrice), 0);
        if (secVal / pv > RULES.MAX_SECTOR_PCT) continue;
        const sameSecCount = newPos.filter((p) => p.sector === d.sector).length;
        if (sameSecCount >= RULES.MAX_CORRELATED && !d.isETF) continue;

        let sizePct = RULES.MAX_POSITION_PCT;
        if (d.atrPct > 3) sizePct *= 0.7;
        if (d.score > 80) sizePct *= 1.15;
        if (newRegime === "BEAR") sizePct *= 0.6;
        const qty = Math.floor(pv * sizePct / d.current);
        if (qty < 1 || qty * d.current > newCash * 0.9) continue;

        newCash -= qty * d.current;
        newPos.push({
          symbol: d.symbol, name: d.name, sector: d.sector, strategy: d.strategy,
          qty, entryPrice: d.current, highWater: d.current, time: new Date().toLocaleTimeString(),
        });
        newTrades.push({
          symbol: d.symbol, action: "BUY", qty, price: d.current, strategy: d.strategy,
          reason: d.buySignals.slice(0, 3).join(", "), time: new Date().toLocaleTimeString(), timestamp: Date.now(),
        });
        addLog(`BUY ${qty}x ${d.symbol} @ $${fmt(d.current)} | Score:${d.score} | ${d.buySignals.join(",")}`, "buy");
      }
    }

    const posVal = newPos.reduce((a, p) => {
      const d = newData[p.symbol];
      return a + (d ? d.current * p.qty : p.entryPrice * p.qty);
    }, 0);
    const newPV = newCash + posVal;
    stateRef.current = { cash: newCash, positions: newPos, portfolio: newPV };
    setCash(newCash);
    setPositions(newPos);
    setPortfolio(newPV);
    setAllTimeHigh((h) => Math.max(h, newPV));
    setEquityCurve((prev) => [...prev, newPV].slice(-120));
    if (newTrades.length > 0) setTrades((p) => [...newTrades, ...p].slice(0, 300));

    const sectors = {};
    newPos.forEach((p) => {
      const d = newData[p.symbol];
      const v = d ? d.current * p.qty : p.entryPrice * p.qty;
      sectors[p.sector] = (sectors[p.sector] || 0) + v;
    });
    setSectorBreakdown(sectors);
    addLog(`SCAN #${scanCount + 1} ${newRegime} | $${fmtK(newPV)} | Cash:${(newCash / newPV * 100).toFixed(0)}% | ${newPos.length} pos`, "info");
  }, [addLog, scanCount]);

  const startBot = () => {
    const capital = parseFloat(inputCapital.replace(/,/g, "")) || 100000;
    setCash(capital); setPortfolio(capital); setAllTimeHigh(capital); setStarted(true);
    setPositions([]); setTrades([]); setLogs([]); setEquityCurve([capital]); setScanCount(0);
    stateRef.current = { cash: capital, positions: [], portfolio: capital };
    setIsRunning(true);
    addLog(`RUDEBOT v4 DEPLOYED — $${capital.toLocaleString()} capital armed`, "buy");
    addLog(`Strategies: MOMENTUM / DIVIDEND / MEAN_REV / SECTOR_ROTATION`, "info");
    addLog(`Universe: ${ALL_STOCKS.length} instruments across ${[...new Set(ALL_STOCKS.map((s) => s.sector))].length} sectors`, "info");
    addLog(`Risk: SL ${RULES.STOP_LOSS_PCT * 100}% | TP ${RULES.TAKE_PROFIT_PCT * 100}% | Trail ${RULES.TRAILING_STOP_PCT * 100}% | Max Pos ${RULES.MAX_POSITIONS} | Sector Cap ${RULES.MAX_SECTOR_PCT * 100}%`, "info");
    setTimeout(() => {
      runEngine(capital, [], capital);
      scanRef.current = setInterval(() => runEngine(), RULES.SCAN_INTERVAL);
    }, 200);
  };

  const stopBot = () => {
    setIsRunning(false);
    if (scanRef.current) { clearInterval(scanRef.current); scanRef.current = null; }
    addLog("RudeBot HALTED — positions held open", "warn");
  };

  // ── AI ANALYSIS (via serverless function) ──
  const getAIAnalysis = async () => {
    setIsAnalyzing(true);
    setActiveTab("ai");
    const sc = parseFloat(inputCapital.replace(/,/g, "") || 100000);
    const pnl = portfolio - sc;
    const winT = trades.filter((t) => t.pnl > 0).length;
    const closedT = trades.filter((t) => t.pnl !== undefined).length;
    const holdings = positions.slice(0, 8).map((p) => {
      const d = stockData[p.symbol]; const cur = d?.current || p.entryPrice;
      return `${p.symbol}(${p.strategy},${p.sector}): ${p.qty}sh @ $${fmt(p.entryPrice)} now $${fmt(cur)} P&L:${((cur - p.entryPrice) * p.qty >= 0 ? "+" : "")}$${fmt((cur - p.entryPrice) * p.qty)}`;
    }).join("\n");
    const candidates = Object.values(stockData).sort((a, b) => b.score - a.score).slice(0, 6).map((d) =>
      `${d.symbol}(${d.strategy}): Score ${d.score}, RSI ${d.rsi}, BB ${d.bbPos}%, ${d.buySignals.join("|")}`
    ).join("\n");
    const sectorStr = Object.entries(sectorBreakdown).sort((a, b) => b[1] - a[1]).map(([s, v]) =>
      `${s}: $${fmtK(v)} (${(v / portfolio * 100).toFixed(0)}%)`
    ).join(", ");

    const prompt = `RUDEBOT v4 STOCK INTEL BRIEF:\n\nPortfolio: $${fmt(portfolio)} | Start: $${fmt(sc)} | P&L: ${pnl >= 0 ? "+" : ""}$${fmt(pnl)} (${fmtPct((pnl / sc) * 100)})\nRegime: ${regime} | Win: ${closedT > 0 ? ((winT / closedT) * 100).toFixed(0) : "--"}% (${winT}/${closedT})\nATH: $${fmt(allTimeHigh)} | DD: ${(((allTimeHigh - portfolio) / allTimeHigh) * 100).toFixed(1)}%\nSector Alloc: ${sectorStr || "None"}\n\nPositions:\n${holdings || "None"}\n\nTop Candidates:\n${candidates}\n\n1) Performance vs 3-5% monthly target\n2) Cut/hold each position — no mercy\n3) Top 3 highest-conviction entries NOW with size\n4) Sector rotation plays\n5) Biggest risk to this book`;

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      setAnalysis(data.text || data.error || "Unavailable.");
    } catch (e) {
      setAnalysis(`Error: ${e.message}. Make sure ANTHROPIC_API_KEY is set in your Vercel environment variables.`);
    }
    setIsAnalyzing(false);
  };

  // ── DERIVED VALUES ──
  const startCapital = parseFloat(inputCapital.replace(/,/g, "") || 100000);
  const totalPnL = portfolio - startCapital;
  const totalPnLPct = started ? (totalPnL / startCapital) * 100 : 0;
  const posValue = positions.reduce((a, p) => { const d = stockData[p.symbol]; return a + (d ? d.current * p.qty : p.entryPrice * p.qty); }, 0);
  const unrealPnL = positions.reduce((a, p) => { const d = stockData[p.symbol]; const cur = d?.current || p.entryPrice; return a + (cur - p.entryPrice) * p.qty; }, 0);
  const realPnL = trades.filter((t) => t.pnl !== undefined).reduce((a, t) => a + t.pnl, 0);
  const winTrades = trades.filter((t) => t.pnl !== undefined && t.pnl > 0).length;
  const closedTrades = trades.filter((t) => t.pnl !== undefined).length;
  const winRate = closedTrades > 0 ? ((winTrades / closedTrades) * 100).toFixed(0) : "--";
  const drawdown = allTimeHigh > 0 ? (((allTimeHigh - portfolio) / allTimeHigh) * 100).toFixed(1) : "0.0";
  const mCount = positions.filter((p) => p.strategy === "MOMENTUM").length;
  const dCount = positions.filter((p) => p.strategy === "DIVIDEND").length;
  const rCount = positions.filter((p) => p.strategy === "MEAN_REV").length;
  const sCount = positions.filter((p) => p.strategy === "ROTATION").length;
  const uniqueSectors = [...new Set(positions.map((p) => p.sector))].length;
  const tabs = ["command", "positions", "watchlist", "trades", "ai"];

  return (
    <div style={{ fontFamily: "'DM Sans',sans-serif", background: C.bg, color: C.text, minHeight: "100vh", fontSize: 13 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=DM+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:${C.bg}}::-webkit-scrollbar-thumb{background:${C.border};border-radius:4px}
        .rb-btn{border:none;cursor:pointer;font-family:'DM Sans',sans-serif;font-weight:600;letter-spacing:.02em;transition:all .15s ease;border-radius:6px}
        .rb-btn:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(0,0,0,.3)}.rb-btn:active{transform:translateY(0)}.rb-btn:disabled{opacity:.35;cursor:not-allowed;transform:none;box-shadow:none}
        .rb-tab{background:none;border:none;cursor:pointer;padding:11px 20px;font-family:'DM Sans',sans-serif;font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;transition:all .15s;border-bottom:2px solid transparent;color:${C.textMute}}
        .rb-tab.on{color:${C.red};border-bottom-color:${C.red};font-weight:600}.rb-tab:hover{color:${C.textMid}}
        @keyframes rb-pulse{0%,100%{opacity:1}50%{opacity:.3}}.rb-pulse{animation:rb-pulse 1.8s ease-in-out infinite}
        @keyframes rb-fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}.rb-fade{animation:rb-fade .25s ease}
        @keyframes rb-glow{0%,100%{box-shadow:0 0 8px rgba(239,68,68,.15)}50%{box-shadow:0 0 20px rgba(239,68,68,.3)}}.rb-glow{animation:rb-glow 2s ease-in-out infinite}
        .rb-row:hover{background:${C.surfaceAlt}}
        input:focus{outline:none;border-color:${C.red}!important;box-shadow:0 0 0 3px rgba(239,68,68,.12)}
        .rb-card{background:${C.surface};border:1px solid ${C.border};border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,.2)}
      `}</style>

      {/* HEADER */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "0 28px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "16px 0" }}>
          <div style={{ position: "relative" }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: isRunning ? C.red : C.textFaint }} className={isRunning ? "rb-pulse" : ""} />
            {isRunning && <div style={{ position: "absolute", inset: -3, borderRadius: "50%", border: `2px solid ${C.red}30` }} className="rb-pulse" />}
          </div>
          <span style={{ fontFamily: "'Instrument Serif',serif", fontSize: 28, fontWeight: 400, color: C.text, fontStyle: "italic" }}>RudeBot</span>
          <span style={{ color: C.textMute, fontSize: 10, letterSpacing: ".14em", fontWeight: 500, textTransform: "uppercase", marginTop: 4 }}>v4.0 · stocks</span>
          {started && <span style={{ padding: "4px 12px", fontSize: 10, fontWeight: 600, letterSpacing: ".06em", borderRadius: 20,
            background: regime === "BULL" ? C.greenBg : regime === "BEAR" ? C.redBg : C.amberBg,
            color: regime === "BULL" ? C.green : regime === "BEAR" ? C.red : C.amber,
            border: `1px solid ${regime === "BULL" ? C.greenBorder : regime === "BEAR" ? C.redBorder : C.amberBorder}`,
          }}>{regime}</span>}
          {started && <span style={{ color: C.textFaint, fontSize: 10, fontFamily: "'DM Mono',monospace" }}>#{scanCount}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 0" }}>
          {!isRunning ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden", background: C.surfaceAlt }}>
                <span style={{ padding: "10px 12px", color: C.textMute, fontSize: 14, fontFamily: "'DM Mono',monospace" }}>$</span>
                <input value={inputCapital} onChange={(e) => setInputCapital(e.target.value)} style={{ background: "transparent", border: "none", borderLeft: `1px solid ${C.border}`, color: C.text, padding: "10px 14px", fontFamily: "'DM Mono',monospace", fontSize: 14, width: 130 }} placeholder="100,000" />
              </div>
              <button className="rb-btn" style={{ background: C.red, color: "#fff", padding: "11px 28px", fontSize: 12 }} onClick={startBot}>Deploy</button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {lastScan && <span style={{ color: C.textMute, fontSize: 11, fontFamily: "'DM Mono',monospace" }}>{lastScan.toLocaleTimeString()}</span>}
              <button className="rb-btn" style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, color: C.textMid, padding: "9px 16px", fontSize: 11 }} onClick={() => runEngine()}>Scan</button>
              <button className="rb-btn" style={{ background: C.redBg, border: `1px solid ${C.redBorder}`, color: C.red, padding: "9px 20px", fontSize: 11 }} onClick={stopBot}>Halt</button>
            </div>
          )}
        </div>
      </div>

      {/* TABS */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "0 28px", display: "flex", gap: 2 }}>
        {tabs.map((t) => <button key={t} className={`rb-tab ${activeTab === t ? "on" : ""}`} onClick={() => setActiveTab(t)}>{t === "ai" ? "AI Intel" : t}</button>)}
      </div>

      <div style={{ padding: "24px 28px", maxWidth: 1440, margin: "0 auto" }}>

        {/* ══════ COMMAND CENTER ══════ */}
        {activeTab === "command" && <div className="rb-fade">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div className="rb-card" style={{ padding: "28px 32px", borderColor: started && totalPnL !== 0 ? (totalPnL >= 0 ? C.greenBorder : C.redBorder) : C.border }}>
              <div style={{ color: C.textMute, fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 600, marginBottom: 8 }}>Total P&L</div>
              <div style={{ fontFamily: "'Instrument Serif',serif", fontSize: 48, color: !started ? C.textFaint : totalPnL >= 0 ? C.green : C.red, lineHeight: 1, fontStyle: "italic" }}>
                {!started ? "Ready" : `${totalPnL >= 0 ? "+" : ""}$${fmt(totalPnL)}`}
              </div>
              {started && <div style={{ display: "flex", gap: 16, marginTop: 12, alignItems: "center" }}>
                <span style={{ color: totalPnL >= 0 ? C.green : C.red, fontSize: 16, fontWeight: 600, fontFamily: "'DM Mono',monospace" }}>{fmtPct(totalPnLPct)}</span>
                <span style={{ color: C.textFaint, fontSize: 11 }}>·</span>
                <span style={{ color: C.textMute, fontSize: 11, fontFamily: "'DM Mono',monospace" }}>ATH ${fmt(allTimeHigh)}</span>
                <span style={{ color: C.red, fontSize: 11, fontWeight: 600, fontFamily: "'DM Mono',monospace" }}>-{drawdown}% DD</span>
              </div>}
            </div>
            <div className="rb-card" style={{ padding: "20px 24px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ color: C.textMute, fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 600 }}>Equity Curve</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: C.text, fontFamily: "'DM Mono',monospace" }}>${fmtK(started ? portfolio : startCapital)}</div>
              </div>
              {equityCurve.length > 1
                ? <EquityCurve data={equityCurve} w={340} h={70} />
                : <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: C.textFaint, fontSize: 11 }}>Deploy to track equity</div>
              }
            </div>
          </div>

          {/* Metrics Grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))", gap: 10, marginBottom: 12 }}>
            {[
              { l: "Cash", v: `$${fmtK(cash)}`, s: `${started && portfolio > 0 ? ((cash / portfolio) * 100).toFixed(0) : 100}% free`, c: !started || cash / portfolio > 0.2 ? C.green : C.amber },
              { l: "Positions", v: `${positions.length}/${RULES.MAX_POSITIONS}`, s: `${uniqueSectors} sectors`, c: C.blue },
              { l: "Unrealized", v: `${unrealPnL >= 0 ? "+" : ""}$${fmt(unrealPnL)}`, s: "open P&L", c: unrealPnL >= 0 ? C.green : C.red },
              { l: "Realized", v: `${realPnL >= 0 ? "+" : ""}$${fmt(realPnL)}`, s: `${closedTrades} closed`, c: realPnL >= 0 ? C.green : C.red },
              { l: "Win Rate", v: `${winRate}%`, s: `${winTrades}W/${closedTrades - winTrades}L`, c: parseFloat(winRate) > 55 ? C.green : C.red },
              { l: "Strategies", v: `${mCount}M ${dCount}D ${rCount}R ${sCount}S`, s: "mom/div/rev/rot", c: C.violet },
            ].map((m, i) => (
              <div key={i} className="rb-card" style={{ padding: "14px 16px" }}>
                <div style={{ color: C.textMute, fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", fontWeight: 600, marginBottom: 6 }}>{m.l}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: m.c, fontFamily: "'DM Mono',monospace" }}>{m.v}</div>
                <div style={{ color: C.textMute, fontSize: 10, marginTop: 3 }}>{m.s}</div>
              </div>
            ))}
          </div>

          {/* Sector Allocation Bar */}
          {started && Object.keys(sectorBreakdown).length > 0 && <div className="rb-card" style={{ padding: "14px 18px", marginBottom: 12 }}>
            <div style={{ color: C.textMute, fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 600, marginBottom: 10 }}>Sector Allocation</div>
            <div style={{ display: "flex", height: 6, borderRadius: 4, overflow: "hidden", background: C.surfaceAlt, gap: 1 }}>
              {Object.entries(sectorBreakdown).sort((a, b) => b[1] - a[1]).map(([sec, val], i) => {
                const pct = posValue > 0 ? (val / posValue * 100) : 0;
                return <div key={sec} style={{ width: `${pct}%`, background: SECTOR_COLORS[i % SECTOR_COLORS.length], borderRadius: 2, minWidth: pct > 0 ? 3 : 0 }} title={`${sec}: ${pct.toFixed(0)}%`} />;
              })}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 8 }}>
              {Object.entries(sectorBreakdown).sort((a, b) => b[1] - a[1]).map(([sec, val], i) => {
                const pct = posValue > 0 ? (val / posValue * 100) : 0;
                return <span key={sec} style={{ fontSize: 10, color: C.textMid, display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 2, background: SECTOR_COLORS[i % SECTOR_COLORS.length] }} />
                  {sec} <span style={{ fontFamily: "'DM Mono',monospace", color: C.textMute }}>{pct.toFixed(0)}%</span>
                </span>;
              })}
            </div>
          </div>}

          {/* Rules */}
          <div className="rb-card" style={{ padding: "14px 18px", marginBottom: 12 }}>
            <div style={{ color: C.textMute, fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 600, marginBottom: 10 }}>Active Rules — 4 Strategy Layers · {ALL_STOCKS.length} Instruments</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {[
                ["4.5% Position", "red"], ["4% Stop Loss", "red"], ["15% Take Profit", "red"],
                ["3% Trail", "red"], ["10% Cash Floor", "red"], ["30% Sector Cap", "red"],
                ["12 Max Pos", "red"], ["ATR Sizing", "red"],
                ["MOMENTUM", "rose"], ["DIVIDEND", "teal"], ["MEAN REV", "blue"], ["ROTATION", "amber"],
                ["Score 58+ Bull", "amber"], ["Score 72+ Bear", "amber"], ["Score 65+ Side", "amber"],
                ["10s Scan", "slate"], ["Vol Confirm", "slate"], ["RSI + BB", "slate"], ["Multi-Exit", "slate"],
              ].map(([r, t]) => {
                const colors = { red: [C.red, C.redBg], rose: [C.rose, "#1c0f14"], teal: [C.teal, C.tealBg], blue: [C.blue, C.blueBg], amber: [C.amber, C.amberBg], slate: [C.slate, "#14171c"] };
                const [fg, bg] = colors[t];
                return <span key={r} style={{ padding: "3px 9px", background: bg, borderRadius: 20, fontSize: 9, color: fg, fontWeight: 600 }}>{r}</span>;
              })}
            </div>
          </div>

          {/* Activity Log */}
          <div className="rb-card" style={{ padding: "14px 18px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <span style={{ color: C.textMute, fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 600 }}>Activity Log</span>
              <span style={{ color: C.textFaint, fontSize: 10, fontFamily: "'DM Mono',monospace" }}>{logs.length}</span>
            </div>
            <div style={{ maxHeight: 240, overflowY: "auto" }}>
              {logs.length === 0
                ? <div style={{ color: C.textFaint, textAlign: "center", padding: "36px 0", fontSize: 11 }}>Deploy capital to begin</div>
                : logs.map((l, i) => (
                  <div key={i} style={{ padding: "5px 0", borderBottom: `1px solid ${C.borderLt}`, display: "flex", gap: 12, alignItems: "baseline" }}>
                    <span style={{ color: C.textFaint, minWidth: 68, fontSize: 10, fontFamily: "'DM Mono',monospace" }}>{l.time}</span>
                    <span style={{ fontSize: 11, fontWeight: l.type === "buy" || l.type === "profit" || l.type === "loss" ? 600 : 400,
                      color: l.type === "buy" ? C.red : l.type === "profit" ? C.green : l.type === "loss" ? C.red : l.type === "warn" ? C.amber : C.textMid,
                    }}>{l.msg}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>}

        {/* ══════ POSITIONS ══════ */}
        {activeTab === "positions" && <div className="rb-fade">
          <div className="rb-card">
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.borderLt}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                <span style={{ color: C.textMute, fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 600 }}>Open Positions ({positions.length})</span>
                <span style={{ color: unrealPnL >= 0 ? C.green : C.red, fontSize: 11, fontWeight: 700, fontFamily: "'DM Mono',monospace" }}>{unrealPnL >= 0 ? "+" : ""}${fmt(unrealPnL)}</span>
              </div>
              <span style={{ color: C.red, fontSize: 12, fontWeight: 600, fontFamily: "'DM Mono',monospace" }}>${fmtK(posValue)}</span>
            </div>
            {positions.length === 0
              ? <div style={{ color: C.textFaint, textAlign: "center", padding: "60px", fontSize: 11 }}>No open positions</div>
              : <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>{["Symbol", "Sector", "Strategy", "Qty", "Entry", "Current", "P&L", "P&L %", "Value", "Chart"].map((h) => <th key={h} style={{ padding: "10px 14px", textAlign: "left", borderBottom: `1px solid ${C.borderLt}`, color: C.textMute, fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase", fontWeight: 600 }}>{h}</th>)}</tr></thead>
                  <tbody>{positions.map((p, i) => {
                    const d = stockData[p.symbol]; const cur = d?.current || p.entryPrice;
                    const pl = (cur - p.entryPrice) * p.qty; const plPct = (cur - p.entryPrice) / p.entryPrice * 100;
                    return (<tr key={i} className="rb-row">
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}`, fontWeight: 700, fontFamily: "'DM Mono',monospace", fontSize: 13 }}>{p.symbol}</td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}`, color: C.textMid, fontSize: 11 }}>{p.sector}</td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}` }}><span style={{ color: stratColor(p.strategy), fontSize: 9, fontWeight: 700, padding: "3px 8px", background: stratBg(p.strategy), borderRadius: 20 }}>{p.strategy}</span></td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}`, color: C.textMid, fontFamily: "'DM Mono',monospace" }}>{p.qty}</td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}`, color: C.textMid, fontFamily: "'DM Mono',monospace" }}>${fmt(p.entryPrice)}</td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}`, fontFamily: "'DM Mono',monospace", fontWeight: 500 }}>${fmt(cur)}</td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}`, color: pl >= 0 ? C.green : C.red, fontWeight: 700, fontFamily: "'DM Mono',monospace" }}>{pl >= 0 ? "+" : ""}${fmt(pl)}</td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}`, color: plPct >= 0 ? C.green : C.red, fontFamily: "'DM Mono',monospace" }}>{fmtPct(plPct)}</td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}`, color: C.textMid, fontFamily: "'DM Mono',monospace" }}>${fmtK(cur * p.qty)}</td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}` }}><Spark prices={d?.prices?.slice(-20)} color={pl >= 0 ? C.green : C.red} /></td>
                    </tr>);
                  })}</tbody>
                </table></div>
            }
          </div>
        </div>}

        {/* ══════ WATCHLIST ══════ */}
        {activeTab === "watchlist" && <div className="rb-fade">
          <div style={{ display: "flex", gap: 16, marginBottom: 14, fontSize: 10, color: C.textMid, fontWeight: 500, flexWrap: "wrap" }}>
            {[
              ["Momentum", C.red, 10], ["Dividend", C.teal, 8], ["Mean Rev", C.blue, 7], ["Rotation", C.orange, 5],
            ].map(([label, color, count]) => (
              <span key={label}><span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: color, marginRight: 5, verticalAlign: "middle" }} /> {label} ({count})</span>
            ))}
            <span style={{ color: C.textFaint, marginLeft: "auto", fontFamily: "'DM Mono',monospace" }}>{ALL_STOCKS.length} total</span>
          </div>
          {Object.keys(stockData).length === 0
            ? <div className="rb-card" style={{ textAlign: "center", padding: "80px", color: C.textFaint, fontSize: 11 }}>Deploy bot to load data</div>
            : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 10 }}>
                {Object.values(stockData).sort((a, b) => b.score - a.score).map((d) => {
                  const held = positions.find((p) => p.symbol === d.symbol);
                  const sc = stratColor(d.strategy);
                  const bg = stratBg(d.strategy);
                  return (<div key={d.symbol} className="rb-card" style={{ padding: "14px 16px", borderColor: held ? sc + "44" : C.border }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                          <span style={{ fontWeight: 700, fontSize: 14, fontFamily: "'DM Mono',monospace" }}>{d.symbol}</span>
                          <span style={{ color: sc, fontSize: 8, fontWeight: 700, letterSpacing: ".08em", padding: "2px 7px", background: bg, borderRadius: 20 }}>{d.strategy}</span>
                          {held && <span style={{ fontSize: 8, color: "#fff", padding: "2px 6px", background: C.red, borderRadius: 20, fontWeight: 600 }}>HELD</span>}
                        </div>
                        <div style={{ color: C.textMute, fontSize: 10 }}>{d.name} <span style={{ color: C.textFaint }}>· {d.sector}</span></div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "'DM Mono',monospace" }}>${fmt(d.current)}</div>
                        <div style={{ color: d.change >= 0 ? C.green : C.red, fontSize: 10, fontWeight: 600, fontFamily: "'DM Mono',monospace" }}>{d.change >= 0 ? "+" : ""}{d.change}%</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <div style={{ flex: 1, height: 3, background: C.surfaceAlt, borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ width: `${d.score}%`, height: "100%", borderRadius: 3, background: d.score > 65 ? sc : d.score < 45 ? C.red : C.amber }} />
                      </div>
                      <span style={{ color: d.score > 65 ? sc : d.score < 45 ? C.red : C.amber, fontWeight: 700, fontSize: 12, minWidth: 22, textAlign: "right", fontFamily: "'DM Mono',monospace" }}>{d.score}</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 4, padding: "8px 0", borderTop: `1px solid ${C.borderLt}`, borderBottom: `1px solid ${C.borderLt}`, marginBottom: 8 }}>
                      {[
                        { l: "RSI", v: d.rsi, c: d.rsi < 35 ? C.green : d.rsi > 70 ? C.red : C.textMid },
                        { l: "MACD", v: d.macd > 0 ? "+" : "-", c: d.macd > 0 ? C.green : C.red },
                        { l: "BB", v: `${d.bbPos}%`, c: d.bbPos < 20 ? C.green : d.bbPos > 80 ? C.red : C.textMid },
                        { l: "VOL", v: `${d.volRatio}x`, c: d.volRatio > 1.5 ? C.orange : C.textMid },
                        { l: d.growth ? "GRW" : "DIV", v: d.growth ? `${d.growth}%` : `${d.divYield || 0}%`, c: sc },
                      ].map((m) => <div key={m.l} style={{ textAlign: "center" }}><div style={{ color: C.textFaint, fontSize: 8, marginBottom: 2, fontWeight: 600, letterSpacing: ".06em" }}>{m.l}</div><div style={{ color: m.c, fontWeight: 700, fontSize: 11, fontFamily: "'DM Mono',monospace" }}>{m.v}</div></div>)}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
                      <div style={{ flex: 1 }}>
                        {d.buySignals.slice(0, 3).map((s) => <span key={s} style={{ display: "inline-block", padding: "2px 6px", background: C.surfaceAlt, border: `1px solid ${C.borderLt}`, borderRadius: 20, fontSize: 8, color: sc, marginRight: 3, fontWeight: 600 }}>{s}</span>)}
                        {d.sellSignals.slice(0, 1).map((s) => <span key={s} style={{ display: "inline-block", padding: "2px 6px", background: C.redBg, border: `1px solid ${C.redBorder}`, borderRadius: 20, fontSize: 8, color: C.red, marginRight: 3, fontWeight: 600 }}>! {s}</span>)}
                      </div>
                      <Spark prices={d.prices?.slice(-25)} color={d.change >= 0 ? C.green : C.red} />
                    </div>
                  </div>);
                })}
              </div>
          }
        </div>}

        {/* ══════ TRADES ══════ */}
        {activeTab === "trades" && <div className="rb-fade">
          <div className="rb-card">
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.borderLt}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                <span style={{ color: C.textMute, fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 600 }}>Trade History ({trades.length})</span>
                <span style={{ padding: "3px 10px", background: parseFloat(winRate) > 55 ? C.greenBg : C.redBg, color: parseFloat(winRate) > 55 ? C.green : C.red, borderRadius: 20, fontSize: 10, fontWeight: 700, fontFamily: "'DM Mono',monospace" }}>{winRate}% win</span>
                <span style={{ color: realPnL >= 0 ? C.green : C.red, fontSize: 11, fontWeight: 600, fontFamily: "'DM Mono',monospace" }}>{realPnL >= 0 ? "+" : ""}${fmt(realPnL)} realized</span>
              </div>
              <button className="rb-btn" style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, color: C.textMute, padding: "5px 14px", fontSize: 9 }} onClick={() => { if (window.confirm("Clear history?")) setTrades([]); }}>Clear</button>
            </div>
            {trades.length === 0
              ? <div style={{ color: C.textFaint, textAlign: "center", padding: "60px", fontSize: 11 }}>No trades yet</div>
              : <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>{["Time", "Action", "Strategy", "Symbol", "Qty", "Price", "P&L", "Reason"].map((h) => <th key={h} style={{ padding: "10px 14px", textAlign: "left", borderBottom: `1px solid ${C.borderLt}`, color: C.textMute, fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase", fontWeight: 600 }}>{h}</th>)}</tr></thead>
                  <tbody>{trades.map((t, i) => (
                    <tr key={i} className="rb-row">
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}`, color: C.textMute, fontSize: 10, fontFamily: "'DM Mono',monospace" }}>{t.time}</td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}` }}><span style={{ padding: "3px 9px", fontSize: 9, fontWeight: 700, borderRadius: 20, color: t.action === "BUY" ? C.red : C.green, background: t.action === "BUY" ? C.redBg : C.greenBg }}>{t.action}</span></td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}` }}><span style={{ color: stratColor(t.strategy), fontSize: 9, fontWeight: 700, padding: "3px 7px", background: stratBg(t.strategy), borderRadius: 20 }}>{t.strategy}</span></td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}`, fontWeight: 700, fontFamily: "'DM Mono',monospace", fontSize: 12 }}>{t.symbol}</td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}`, color: C.textMid, fontFamily: "'DM Mono',monospace" }}>{t.qty}</td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}`, color: C.textMid, fontFamily: "'DM Mono',monospace" }}>${fmt(t.price)}</td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}`, fontWeight: t.pnl !== undefined ? 700 : 400, fontFamily: "'DM Mono',monospace", color: t.pnl === undefined ? C.textMute : t.pnl >= 0 ? C.green : C.red }}>{t.pnl !== undefined ? `${t.pnl >= 0 ? "+" : ""}$${fmt(t.pnl)}` : "—"}</td>
                      <td style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderLt}`, color: C.textMid, fontSize: 11 }}>{t.reason}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
            }
          </div>
        </div>}

        {/* ══════ AI INTEL ══════ */}
        {activeTab === "ai" && <div className="rb-fade">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14, alignItems: "center" }}>
            <span style={{ color: C.textMute, fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 600 }}>AI Stock Intelligence — Claude Sonnet</span>
            <button className="rb-btn" style={{ background: C.red, color: "#fff", padding: "10px 24px", fontSize: 11 }} onClick={getAIAnalysis} disabled={isAnalyzing || !started}>
              {isAnalyzing ? "Analyzing..." : "Run Intel"}
            </button>
          </div>
          <div className="rb-card" style={{ minHeight: 400, padding: 24 }}>
            {isAnalyzing
              ? <div style={{ color: C.red, textAlign: "center", padding: "140px 0", fontSize: 12, fontWeight: 500 }} className="rb-pulse">Analyzing stock positions & market regime...</div>
              : analysis
                ? <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.85, color: C.textMid, fontSize: 13 }}>{analysis}</div>
                : <div style={{ color: C.textFaint, textAlign: "center", padding: "140px 0", fontSize: 11 }}>Deploy bot, then run intel for AI stock strategy briefing</div>
            }
          </div>
        </div>}

      </div>
    </div>
  );
}

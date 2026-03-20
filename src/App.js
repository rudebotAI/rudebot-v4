/* eslint-disable */
import { useState, useRef, useCallback, useEffect } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   DOWDY FINANCIAL STOCK BOT — STOCK TRADING ENGINE
   Multi-strategy equity bot: Momentum · Dividend · Mean Reversion · Sector Rotation
   ═══════════════════════════════════════════════════════════════════════════ */

const RULES = {
  MAX_POSITION_PCT: 0.045,
  STOP_LOSS_PCT: 0.04,
  TAKE_PROFIT_PCT: 0.15,
  TRAILING_STOP_PCT: 0.03,
  MIN_CASH_RESERVE_PCT: 0.10,
  MAX_SECTOR_PCT: 0.30,
  MAX_SINGLE_STOCK_PCT: 0.08,
  MIN_SCORE_BULL: 58,
  MIN_SCORE_BEAR: 72,
  MIN_SCORE_SIDEWAYS: 65,
  MOMENTUM_BOOST: 1.3,
  EARNINGS_PENALTY: 0.85,
  SCAN_INTERVAL: 10000,
  MAX_POSITIONS: 12,
  MAX_CORRELATED: 3,
  REBALANCE_THRESHOLD: 0.15,
};

const MOMENTUM_STOCKS = [
  { symbol:"NVDA", name:"NVIDIA",           sector:"Semiconductors", pe:35, beta:1.8, growth:120, mktCap:"3.4T" },
  { symbol:"META", name:"Meta Platforms",    sector:"Tech",          pe:22, beta:1.4, growth:25,  mktCap:"1.5T" },
  { symbol:"AMZN", name:"Amazon",            sector:"Tech",          pe:40, beta:1.3, growth:18,  mktCap:"2.1T" },
  { symbol:"MSFT", name:"Microsoft",         sector:"Tech",          pe:32, beta:1.1, growth:16,  mktCap:"3.1T" },
  { symbol:"GOOGL",name:"Alphabet",          sector:"Tech",          pe:24, beta:1.2, growth:15,  mktCap:"2.2T" },
  { symbol:"AAPL", name:"Apple",             sector:"Tech",          pe:29, beta:1.0, growth:8,   mktCap:"3.5T" },
  { symbol:"TSM",  name:"TSMC",              sector:"Semiconductors", pe:20, beta:1.3, growth:30,  mktCap:"900B" },
  { symbol:"AVGO", name:"Broadcom",          sector:"Semiconductors", pe:28, beta:1.2, growth:22,  mktCap:"800B" },
  { symbol:"PLTR", name:"Palantir",          sector:"Tech",          pe:60, beta:2.1, growth:35,  mktCap:"220B" },
  { symbol:"CRM",  name:"Salesforce",        sector:"Tech",          pe:26, beta:1.3, growth:12,  mktCap:"280B" },
];

const DIVIDEND_STOCKS = [
  { symbol:"JPM",  name:"JPMorgan",          sector:"Financials",    divYield:2.5, divGrowth:8,  pe:12, mktCap:"680B" },
  { symbol:"JNJ",  name:"Johnson & Johnson", sector:"Healthcare",    divYield:3.0, divGrowth:6,  pe:15, mktCap:"390B" },
  { symbol:"KO",   name:"Coca-Cola",         sector:"Consumer",      divYield:3.1, divGrowth:4,  pe:22, mktCap:"310B" },
  { symbol:"XOM",  name:"ExxonMobil",        sector:"Energy",        divYield:3.5, divGrowth:3,  pe:14, mktCap:"520B" },
  { symbol:"PG",   name:"Procter & Gamble",  sector:"Consumer",      divYield:2.4, divGrowth:5,  pe:24, mktCap:"400B" },
  { symbol:"ABBV", name:"AbbVie",            sector:"Healthcare",    divYield:3.8, divGrowth:7,  pe:13, mktCap:"310B" },
  { symbol:"HD",   name:"Home Depot",        sector:"Retail",        divYield:2.5, divGrowth:10, pe:22, mktCap:"380B" },
  { symbol:"UNH",  name:"UnitedHealth",      sector:"Healthcare",    divYield:1.5, divGrowth:14, pe:18, mktCap:"520B" },
];

const MEAN_REVERSION = [
  { symbol:"PYPL", name:"PayPal",            sector:"Fintech",       pe:14, beta:1.5, mktCap:"85B" },
  { symbol:"INTC", name:"Intel",             sector:"Semiconductors", pe:12, beta:1.2, mktCap:"110B" },
  { symbol:"PFE",  name:"Pfizer",            sector:"Healthcare",    pe:11, beta:0.7, mktCap:"160B" },
  { symbol:"BA",   name:"Boeing",            sector:"Industrials",   pe:25, beta:1.4, mktCap:"130B" },
  { symbol:"DIS",  name:"Disney",            sector:"Media",         pe:20, beta:1.1, mktCap:"200B" },
  { symbol:"NKE",  name:"Nike",              sector:"Consumer",      pe:22, beta:1.0, mktCap:"115B" },
  { symbol:"SBUX", name:"Starbucks",         sector:"Consumer",      pe:24, beta:0.9, mktCap:"105B" },
];

const SECTOR_ROTATION = [
  { symbol:"XLF",  name:"Financials Select", sector:"Financials",    pe:14, beta:1.1, isETF:true, mktCap:"45B" },
  { symbol:"XLE",  name:"Energy Select",     sector:"Energy",        pe:12, beta:1.3, isETF:true, mktCap:"38B" },
  { symbol:"XLK",  name:"Technology Select",  sector:"Tech",          pe:28, beta:1.2, isETF:true, mktCap:"65B" },
  { symbol:"XLV",  name:"Healthcare Select",  sector:"Healthcare",    pe:17, beta:0.8, isETF:true, mktCap:"42B" },
  { symbol:"XLI",  name:"Industrials Select", sector:"Industrials",   pe:20, beta:1.1, isETF:true, mktCap:"18B" },
];

const ALL_STOCKS = [...MOMENTUM_STOCKS, ...DIVIDEND_STOCKS, ...MEAN_REVERSION, ...SECTOR_ROTATION];

function getStrategy(stock) {
  if (MOMENTUM_STOCKS.find(s=>s.symbol===stock.symbol)) return "MOMENTUM";
  if (DIVIDEND_STOCKS.find(s=>s.symbol===stock.symbol)) return "DIVIDEND";
  if (SECTOR_ROTATION.find(s=>s.symbol===stock.symbol)) return "ROTATION";
  return "MEAN_REV";
}

// ── ALPACA LIVE DATA FETCHER ──
async function fetchAlpacaData(symbols) {
  const res = await fetch(`/api/stocks?symbols=${symbols.join(",")}`);
  if (!res.ok) throw new Error(`Alpaca API ${res.status}`);
  return res.json(); // { NVDA: { current, change, rsi, macd, ... }, ... }
}

// ── SIMULATED DATA (fallback when market is closed or API unavailable) ──
function generateSimulatedPrices() {
  const base = 50 + Math.random() * 400;
  const prices = [];
  let p = base;
  for (let i = 80; i >= 0; i--) {
    p = p * (1 + (Math.random() - 0.47) * 0.025);
    prices.push(parseFloat(p.toFixed(2)));
  }
  return prices;
}

function computeIndicators(prices, volRatio) {
  const current = prices[prices.length - 1];
  const prev = prices[prices.length - 2];
  const change = parseFloat(((current - prev) / prev * 100).toFixed(2));
  let gains = 0, losses = 0;
  if (prices.length >= 15) {
    for (let i = 1; i <= 14; i++) {
      const d = prices[prices.length - i] - prices[prices.length - i - 1];
      if (d > 0) gains += d; else losses += Math.abs(d);
    }
  }
  const rsi = parseFloat((100 - 100 / (1 + (gains/14) / (losses/14 || 0.001))).toFixed(1));
  const ema12 = prices.slice(-12).reduce((a,b)=>a+b,0)/12;
  const ema26 = prices.slice(-26).reduce((a,b)=>a+b,0)/26;
  const macd = parseFloat((ema12 - ema26).toFixed(2));
  const sma20 = parseFloat((prices.slice(-20).reduce((a,b)=>a+b,0)/20).toFixed(2));
  const sma50 = parseFloat((prices.slice(-50).reduce((a,b)=>a+b,0)/50).toFixed(2));
  const sma20arr = prices.slice(-20);
  const stdDev = Math.sqrt(sma20arr.reduce((a,v)=>a+Math.pow(v-sma20,2),0)/20);
  const bbUpper = sma20 + 2*stdDev;
  const bbLower = sma20 - 2*stdDev;
  const bbPos = parseFloat(((current - bbLower) / (bbUpper - bbLower || 1) * 100).toFixed(0));
  let atrSum = 0;
  if (prices.length >= 15) {
    for (let i = 1; i <= 14; i++) atrSum += Math.abs(prices[prices.length-i] - prices[prices.length-i-1]);
  }
  const atr = parseFloat((atrSum / 14).toFixed(2));
  const atrPct = parseFloat((atr / current * 100).toFixed(2));
  const ret5d = prices.length >= 6 ? parseFloat(((current / prices[prices.length-6] - 1) * 100).toFixed(2)) : 0;
  const ret20d = prices.length >= 21 ? parseFloat(((current / prices[prices.length-21] - 1) * 100).toFixed(2)) : 0;
  return { current, change, rsi, macd, sma20, sma50, bbPos, volRatio: volRatio ?? parseFloat((0.5 + Math.random() * 2).toFixed(2)), atr, atrPct, ret5d, ret20d, prices };
}

// ── SCORING & SIGNALS (works with both real and simulated data) ──
function scoreStock(stock, ind) {
  const { current, change, rsi, macd, sma20, sma50, volRatio, bbPos, atrPct, ret5d } = ind;
  let score = 50;
  if (rsi < 32) score += 20; else if (rsi < 42) score += 12; else if (rsi < 50) score += 5;
  if (rsi > 75) score -= 18; else if (rsi > 68) score -= 8;
  if (macd > 0) score += 12; else score -= 5;
  if (current > sma20) score += 8; else score -= 5;
  if (sma20 > sma50) score += 8; else score -= 5;
  if (volRatio > 1.5) score += 8; else if (volRatio > 1.2) score += 4;
  if (bbPos < 20) score += 10;
  if (bbPos > 85) score -= 8;
  if (ret5d > 2 && ret5d < 8) score += 6;
  if (ret5d < -5) score -= 8;
  if (stock.growth > 20) score += 10; else if (stock.growth > 10) score += 5;
  if (stock.divYield > 3) score += 6;
  if (stock.pe && stock.pe < 15) score += 8; else if (stock.pe > 50) score -= 5;
  if (change > 1.5) score += 5; else if (change < -3) score -= 12;
  if (atrPct < 1.5) score += 3;
  const strategy = getStrategy(stock);
  if (strategy === "MOMENTUM") score = Math.round(score * RULES.MOMENTUM_BOOST);
  if (strategy === "ROTATION") score += 5;
  score = Math.min(100, Math.max(0, score));

  const buySignals = [];
  if (rsi < 40) buySignals.push("RSI_OS");
  if (macd > 0) buySignals.push("MACD+");
  if (current > sma20 && sma20 > sma50) buySignals.push("UPTREND");
  if (volRatio > 1.5) buySignals.push("HI_VOL");
  if (stock.growth > 20) buySignals.push("GROWTH");
  if (stock.divYield > 3) buySignals.push("DIV+");
  if (bbPos < 20) buySignals.push("BB_LOW");
  if (ret5d > 2) buySignals.push("MOM_5D");
  if (stock.isETF) buySignals.push("SECTOR");

  const sellSignals = [];
  if (rsi > 72) sellSignals.push("RSI_OB");
  if (macd < 0) sellSignals.push("MACD-");
  if (current < sma20) sellSignals.push("BLW_SMA");
  if (bbPos > 90) sellSignals.push("BB_HI");
  if (ret5d < -4) sellSignals.push("WEAK_5D");

  return { ...stock, ...ind, score, buySignals, sellSignals, strategy };
}

// ── BUILD STOCK DATA (live or fallback) ──
async function buildStockData(addLog) {
  const symbols = ALL_STOCKS.map(s => s.symbol);
  let alpaca = null;
  let isLive = false;
  try {
    alpaca = await fetchAlpacaData(symbols);
    isLive = true;
  } catch (e) {
    if (addLog) addLog(`⚠ Alpaca unavailable (${e.message}) — using simulated data`, "warn");
  }
  const newData = {};
  ALL_STOCKS.forEach(s => {
    const raw = alpaca && alpaca[s.symbol];
    if (raw && raw.current > 0) {
      // Live Alpaca data — indicators already computed server-side
      newData[s.symbol] = scoreStock(s, raw);
    } else {
      // Fallback: simulated
      const prices = generateSimulatedPrices();
      const ind = computeIndicators(prices);
      newData[s.symbol] = scoreStock(s, ind);
    }
  });
  return { newData, isLive };
}

function fmt(n) { return (n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtPct(n) { return `${n>=0?"+":""}${(n||0).toFixed(2)}%`; }
function fmtK(n) { return n >= 1e6 ? `$${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n/1e3).toFixed(0)}K` : `$${fmt(n)}`; }

function Spark({ prices, color, w=100, h=36 }) {
  if (!prices || prices.length < 2) return null;
  const min=Math.min(...prices), max=Math.max(...prices), range=max-min||1;
  const pts = prices.map((p,i)=>`${(i/(prices.length-1))*w},${h-((p-min)/range)*h}`).join(" ");
  return <svg width={w} height={h}><polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/></svg>;
}

function EquityCurve({ data, color, w=320, h=80 }) {
  if (!data || data.length < 2) return null;
  const min=Math.min(...data), max=Math.max(...data), range=max-min||1;
  const pts = data.map((p,i)=>`${(i/(data.length-1))*w},${h-4-((p-min)/range)*(h-8)}`).join(" ");
  const fillPts = `0,${h} ${pts} ${w},${h}`;
  const lastY = h-4-((data[data.length-1]-min)/range)*(h-8);
  const isUp = data[data.length-1] >= data[0];
  const c = isUp ? color || "#16a34a" : "#dc2626";
  return (
    <svg width={w} height={h} style={{display:"block"}}>
      <defs>
        <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c} stopOpacity="0.12"/>
          <stop offset="100%" stopColor={c} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <polygon points={fillPts} fill="url(#eqFill)"/>
      <polyline points={pts} fill="none" stroke={c} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
      <circle cx={w} cy={lastY} r="3" fill={c}/>
    </svg>
  );
}

const C = {
  bg:"#0d0d0f", surface:"#141417", surfaceAlt:"#1a1a1f", surfaceEl:"#202027",
  border:"#28282f", borderLt:"#1e1e25", borderHi:"#35353f",
  text:"#e8e6e3", textMid:"#8a8690", textMute:"#5a5660", textFaint:"#36343a",
  red:"#ef4444", redBg:"#1c1012", redBorder:"#3a1a1a",
  green:"#22c55e", greenBg:"#0f1c14", greenBorder:"#1a3a20",
  blue:"#3b82f6", blueBg:"#0f1420", blueBorder:"#1a2a45",
  amber:"#f59e0b", amberBg:"#1c1808", amberBorder:"#3a3010",
  violet:"#8b5cf6", violetBg:"#140f20",
  rose:"#f43f5e",
  teal:"#14b8a6", tealBg:"#0f1c1a",
  orange:"#f97316",
  slate:"#64748b",
  cyan:"#06b6d4",
};

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
  const [dataSource, setDataSource] = useState("SIM");
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
  const stateRef = useRef({ cash:0, positions:[], portfolio:0 });

  const addLog = useCallback((msg, type="info") => {
    setLogs(p=>[{msg,type,time:new Date().toLocaleTimeString()},...p].slice(0,500));
  },[]);

  const runEngine = useCallback(async (cashIn, posIn, pvIn) => {
    setLastScan(new Date());
    setScanCount(c=>c+1);
    const c = cashIn !== undefined ? cashIn : stateRef.current.cash;
    const pos = posIn !== undefined ? posIn : stateRef.current.positions;
    const pv = pvIn !== undefined ? pvIn : stateRef.current.portfolio;
    const { newData, isLive } = await buildStockData(addLog);
    if (isLive) setDataSource("LIVE");
    else setDataSource("SIM");
    // Regime detection
    const scores = Object.values(newData).map(d=>d.score);
    const avgScore = scores.reduce((a,b)=>a+b,0)/scores.length;
    const bullCount = scores.filter(s=>s>55).length;
    const bearCount = scores.filter(s=>s<45).length;
    const newRegime = avgScore > 60 && bullCount > ALL_STOCKS.length*0.55 ? "BULL"
      : avgScore < 45 && bearCount > ALL_STOCKS.length*0.55 ? "BEAR" : "SIDEWAYS";
    setRegime(newRegime); setStockData(newData);

    let newCash = c; let newPos = [...pos]; const newTrades = [];

    // ── EXIT ENGINE ──
    newPos = newPos.filter(p => {
      const d = newData[p.symbol]; if(!d) return true;
      const cur = d.current, entry = p.entryPrice, pnlPct = (cur - entry) / entry;
      const sl = entry * (1 - RULES.STOP_LOSS_PCT), tp = entry * (1 + RULES.TAKE_PROFIT_PCT);
      p.highWater = Math.max(p.highWater||entry, cur);
      const trail = Math.max(sl, p.highWater * (1 - RULES.TRAILING_STOP_PCT));
      let reason = null;
      if (cur <= trail && pnlPct < 0) reason = "Stop loss";
      else if (cur <= trail && pnlPct >= 0) reason = "Trail stop";
      else if (cur >= tp) reason = "Take profit ✓";
      else if (d.score < 30 && pnlPct > 0) reason = "Signal exit";
      else if (d.sellSignals.length >= 3 && pnlPct > 0.02) reason = "Multi-signal exit";
      else if (d.rsi > 80 && pnlPct > 0.05) reason = "RSI overbought exit";
      // Sector overweight check
      const secVal = newPos.filter(pp=>pp.sector===p.sector&&pp.symbol!==p.symbol).reduce((a,pp)=>a+pp.qty*(newData[pp.symbol]?.current||pp.entryPrice),0) + cur*p.qty;
      if (secVal/pv > RULES.MAX_SECTOR_PCT + 0.1 && d.score < 50) reason = "Sector rebalance";
      if (reason) {
        const pnl = (cur - entry) * p.qty; newCash += cur * p.qty;
        newTrades.push({symbol:p.symbol,action:"SELL",qty:p.qty,price:cur,pnl,reason,strategy:p.strategy,time:new Date().toLocaleTimeString(),timestamp:Date.now()});
        addLog(`SELL ${p.qty}× ${p.symbol} @ $${fmt(cur)} | ${pnl>=0?"+":""}$${fmt(pnl)} | ${reason}`, pnl>=0?"profit":"loss");
        return false;
      }
      return true;
    });

    // ── ENTRY ENGINE ──
    if (newCash / pv > RULES.MIN_CASH_RESERVE_PCT + 0.03 && newPos.length < RULES.MAX_POSITIONS) {
      const held = new Set(newPos.map(p=>p.symbol));
      const minScore = newRegime==="BEAR" ? RULES.MIN_SCORE_BEAR : newRegime==="SIDEWAYS" ? RULES.MIN_SCORE_SIDEWAYS : RULES.MIN_SCORE_BULL;
      const candidates = Object.values(newData)
        .filter(d=>!held.has(d.symbol) && d.score>=minScore && d.buySignals.length>=2 && d.rsi<72 && d.rsi>15)
        .sort((a,b)=>b.score-a.score)
        .slice(0, newRegime==="BEAR" ? 2 : 4);

      for (const d of candidates) {
        if (newPos.length >= RULES.MAX_POSITIONS) break;
        // Sector cap check
        const secVal = newPos.filter(p=>p.sector===d.sector).reduce((a,p)=>a+p.qty*(newData[p.symbol]?.current||p.entryPrice),0);
        if (secVal/pv > RULES.MAX_SECTOR_PCT) continue;
        // Correlated position check (same sector count)
        const sameSecCount = newPos.filter(p=>p.sector===d.sector).length;
        if (sameSecCount >= RULES.MAX_CORRELATED && !d.isETF) continue;
        // Position sizing with ATR-based adjustment
        let sizePct = RULES.MAX_POSITION_PCT;
        if (d.atrPct > 3) sizePct *= 0.7; // reduce size for volatile
        if (d.score > 80) sizePct *= 1.15; // increase for high-conviction
        if (newRegime === "BEAR") sizePct *= 0.6;
        const qty = Math.floor(pv * sizePct / d.current);
        if (qty < 1 || qty * d.current > newCash * 0.9) continue;
        newCash -= qty * d.current;
        newPos.push({symbol:d.symbol,name:d.name,sector:d.sector,strategy:d.strategy,qty,entryPrice:d.current,highWater:d.current,time:new Date().toLocaleTimeString()});
        newTrades.push({symbol:d.symbol,action:"BUY",qty,price:d.current,strategy:d.strategy,reason:d.buySignals.slice(0,3).join(", "),time:new Date().toLocaleTimeString(),timestamp:Date.now()});
        addLog(`BUY ${qty}× ${d.symbol} @ $${fmt(d.current)} | Score:${d.score} | ${d.buySignals.join(",")}`, "buy");
      }
    }

    const posVal = newPos.reduce((a,p)=>{const d=newData[p.symbol];return a+(d?d.current*p.qty:p.entryPrice*p.qty);},0);
    const newPV = newCash + posVal;
    stateRef.current = {cash:newCash, positions:newPos, portfolio:newPV};
    setCash(newCash); setPositions(newPos); setPortfolio(newPV);
    setAllTimeHigh(h=>Math.max(h,newPV));
    setEquityCurve(prev=>[...prev, newPV].slice(-120));
    if (newTrades.length>0) setTrades(p=>[...newTrades,...p].slice(0,300));

    // Sector breakdown
    const sectors = {};
    newPos.forEach(p=>{
      const d=newData[p.symbol]; const v = d ? d.current*p.qty : p.entryPrice*p.qty;
      sectors[p.sector] = (sectors[p.sector]||0) + v;
    });
    setSectorBreakdown(sectors);

    addLog(`SCAN #${scanCount+1} ${newRegime} | $${fmtK(newPV)} | Cash:${(newCash/newPV*100).toFixed(0)}% | ${newPos.length} pos`, "info");
  },[addLog, scanCount]);

  const startBot = () => {
    const capital = parseFloat(inputCapital.replace(/,/g,""))||100000;
    setCash(capital); setPortfolio(capital); setAllTimeHigh(capital); setStarted(true);
    setPositions([]); setTrades([]); setLogs([]); setEquityCurve([capital]); setScanCount(0);
    stateRef.current = {cash:capital, positions:[], portfolio:capital};
    setIsRunning(true);
    addLog(`DOWDY FINANCIAL STOCK BOT DEPLOYED — $${capital.toLocaleString()} capital armed`, "buy");
    addLog(`Strategies: MOMENTUM · DIVIDEND · MEAN_REV · SECTOR_ROTATION`, "info");
    addLog(`Universe: ${ALL_STOCKS.length} instruments across ${[...new Set(ALL_STOCKS.map(s=>s.sector))].length} sectors`, "info");
    addLog(`Risk: SL 4% | TP 15% | Trail 3% | Max Pos ${RULES.MAX_POSITIONS} | Sector Cap ${RULES.MAX_SECTOR_PCT*100}%`, "info");
    setTimeout(async ()=>{ await runEngine(capital,[],capital); scanRef.current=setInterval(()=>runEngine(),RULES.SCAN_INTERVAL); },200);
  };

  const stopBot = () => {
    setIsRunning(false);
    if(scanRef.current){clearInterval(scanRef.current);scanRef.current=null;}
    addLog("Dowdy Financial Stock Bot HALTED — positions held open","warn");
  };

  const getAIAnalysis = async () => {
    setIsAnalyzing(true); setActiveTab("ai");
    const sc = parseFloat(inputCapital.replace(/,/g,"")||100000);
    const pnl = portfolio - sc;
    const winT = trades.filter(t=>t.pnl>0).length;
    const closedT = trades.filter(t=>t.pnl!==undefined).length;
    const holdings = positions.slice(0,8).map(p=>{
      const d=stockData[p.symbol],cur=d?.current||p.entryPrice;
      return `${p.symbol}(${p.strategy},${p.sector}): ${p.qty}sh @ $${fmt(p.entryPrice)} now $${fmt(cur)} P&L:${((cur-p.entryPrice)*p.qty>=0?"+":"")}$${fmt((cur-p.entryPrice)*p.qty)}`;
    }).join("\n");
    const candidates = Object.values(stockData).sort((a,b)=>b.score-a.score).slice(0,6).map(d=>`${d.symbol}(${d.strategy}): Score ${d.score}, RSI ${d.rsi}, BB ${d.bbPos}%, ${d.buySignals.join("|")}`).join("\n");
    const sectorStr = Object.entries(sectorBreakdown).sort((a,b)=>b[1]-a[1]).map(([s,v])=>`${s}: $${fmtK(v)} (${(v/portfolio*100).toFixed(0)}%)`).join(", ");
    try {
      const res = await fetch("/api/analyze",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          prompt:`DOWDY FINANCIAL STOCK BOT INTEL BRIEF (${dataSource === "LIVE" ? "LIVE MARKET DATA" : "SIMULATED DATA"}):\n\nPortfolio: $${fmt(portfolio)} | Start: $${fmt(sc)} | P&L: ${pnl>=0?"+":""}$${fmt(pnl)} (${fmtPct((pnl/sc)*100)})\nRegime: ${regime} | Win: ${closedT>0?((winT/closedT)*100).toFixed(0):"--"}% (${winT}/${closedT})\nATH: $${fmt(allTimeHigh)} | DD: ${(((allTimeHigh-portfolio)/allTimeHigh)*100).toFixed(1)}%\nSector Alloc: ${sectorStr||"None"}\n\nPositions:\n${holdings||"None"}\n\nTop Candidates:\n${candidates}\n\n1) Performance vs 3-5% monthly target\n2) Cut/hold each position — no mercy\n3) Top 3 highest-conviction entries NOW with size\n4) Sector rotation plays\n5) Biggest risk to this book`
        })
      });
      const data = await res.json();
      setAnalysis(data.text||"Unavailable.");
    } catch(e){setAnalysis(`Error: ${e.message}`);}
    setIsAnalyzing(false);
  };

  const startCapital = parseFloat(inputCapital.replace(/,/g,"")||100000);
  const totalPnL = portfolio - startCapital;
  const totalPnLPct = started ? (totalPnL/startCapital)*100 : 0;
  const posValue = positions.reduce((a,p)=>{const d=stockData[p.symbol];return a+(d?d.current*p.qty:p.entryPrice*p.qty);},0);
  const unrealPnL = positions.reduce((a,p)=>{const d=stockData[p.symbol],cur=d?.current||p.entryPrice;return a+(cur-p.entryPrice)*p.qty;},0);
  const realPnL = trades.filter(t=>t.pnl!==undefined).reduce((a,t)=>a+t.pnl,0);
  const winTrades = trades.filter(t=>t.pnl!==undefined&&t.pnl>0).length;
  const closedTrades = trades.filter(t=>t.pnl!==undefined).length;
  const winRate = closedTrades>0?((winTrades/closedTrades)*100).toFixed(0):"--";
  const drawdown = allTimeHigh>0?(((allTimeHigh-portfolio)/allTimeHigh)*100).toFixed(1):"0.0";
  const mCount=positions.filter(p=>p.strategy==="MOMENTUM").length;
  const dCount=positions.filter(p=>p.strategy==="DIVIDEND").length;
  const rCount=positions.filter(p=>p.strategy==="MEAN_REV").length;
  const sCount=positions.filter(p=>p.strategy==="ROTATION").length;
  const tabs=["command","positions","watchlist","trades","ai"];
  const stratColor = (s) => s==="MOMENTUM"?C.red:s==="DIVIDEND"?C.teal:s==="ROTATION"?C.orange:C.blue;
  const stratBg = (s) => s==="MOMENTUM"?C.redBg:s==="DIVIDEND"?C.tealBg:s==="ROTATION"?"#1c1608":C.blueBg;
  const uniqueSectors = [...new Set(positions.map(p=>p.sector))].length;

  return (
    <div style={{fontFamily:"'DM Sans',sans-serif",background:C.bg,color:C.text,minHeight:"100vh",fontSize:13}}>
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
      <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,padding:"0 28px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
        <div style={{display:"flex",alignItems:"center",gap:14,padding:"16px 0"}}>
          <div style={{position:"relative"}}>
            <div style={{width:10,height:10,borderRadius:"50%",background:isRunning?C.red:C.textFaint}} className={isRunning?"rb-pulse":""}/>
            {isRunning && <div style={{position:"absolute",inset:-3,borderRadius:"50%",border:`2px solid ${C.red}30`}} className="rb-pulse"/>}
          </div>
          <span style={{fontFamily:"'Instrument Serif',serif",fontSize:22,fontWeight:400,color:C.text,fontStyle:"italic"}}>Dowdy Financial</span>
          <span style={{color:C.textMute,fontSize:10,letterSpacing:".14em",fontWeight:500,textTransform:"uppercase",marginTop:4}}>stock bot</span>
          {started && <span style={{padding:"3px 8px",fontSize:9,fontWeight:700,letterSpacing:".08em",borderRadius:10,
            background:dataSource==="LIVE"?"#0a2e1a":"#2a1a0a",
            color:dataSource==="LIVE"?C.green:C.amber,
            border:`1px solid ${dataSource==="LIVE"?"#1a4a2a":"#4a3a1a"}`
          }}>{dataSource==="LIVE"?"● LIVE":"◌ SIM"}</span>}
          {started && <span style={{padding:"4px 12px",fontSize:10,fontWeight:600,letterSpacing:".06em",borderRadius:20,
            background:regime==="BULL"?C.greenBg:regime==="BEAR"?C.redBg:C.amberBg,
            color:regime==="BULL"?C.green:regime==="BEAR"?C.red:C.amber,
            border:`1px solid ${regime==="BULL"?C.greenBorder:regime==="BEAR"?C.redBorder:C.amberBorder}`
          }}>{regime}</span>}
          {started && <span style={{color:C.textFaint,fontSize:10,fontFamily:"'DM Mono',monospace"}}>#{scanCount}</span>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"16px 0"}}>
          {!isRunning ? (
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{display:"flex",alignItems:"center",border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden",background:C.surfaceAlt}}>
                <span style={{padding:"10px 12px",color:C.textMute,fontSize:14,fontFamily:"'DM Mono',monospace"}}>$</span>
                <input value={inputCapital} onChange={e=>setInputCapital(e.target.value)} style={{background:"transparent",border:"none",borderLeft:`1px solid ${C.border}`,color:C.text,padding:"10px 14px",fontFamily:"'DM Mono',monospace",fontSize:14,width:130}} placeholder="100,000"/>
              </div>
              <button className="rb-btn" style={{background:C.red,color:"#fff",padding:"11px 28px",fontSize:12}} onClick={startBot}>Deploy</button>
            </div>
          ) : (
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              {lastScan && <span style={{color:C.textMute,fontSize:11,fontFamily:"'DM Mono',monospace"}}>{lastScan.toLocaleTimeString()}</span>}
              <button className="rb-btn" style={{background:C.surfaceAlt,border:`1px solid ${C.border}`,color:C.textMid,padding:"9px 16px",fontSize:11}} onClick={()=>runEngine()}>Scan</button>
              <button className="rb-btn" style={{background:C.redBg,border:`1px solid ${C.redBorder}`,color:C.red,padding:"9px 20px",fontSize:11}} onClick={stopBot}>Halt</button>
            </div>
          )}
        </div>
      </div>

      {/* TABS */}
      <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,padding:"0 28px",display:"flex",gap:2}}>
        {tabs.map(t=><button key={t} className={`rb-tab ${activeTab===t?"on":""}`} onClick={()=>setActiveTab(t)}>{t==="ai"?"AI Intel":t}</button>)}
      </div>

      <div style={{padding:"24px 28px",maxWidth:1440,margin:"0 auto"}}>

        {/* ══════ COMMAND CENTER ══════ */}
        {activeTab==="command" && <div className="rb-fade">
          {/* P&L Hero + Equity Curve */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
            <div className="rb-card" style={{padding:"28px 32px",borderColor:started&&totalPnL!==0?(totalPnL>=0?C.greenBorder:C.redBorder):C.border}}>
              <div style={{color:C.textMute,fontSize:10,letterSpacing:".12em",textTransform:"uppercase",fontWeight:600,marginBottom:8}}>Total P&L</div>
              <div style={{fontFamily:"'Instrument Serif',serif",fontSize:48,color:!started?C.textFaint:totalPnL>=0?C.green:C.red,lineHeight:1,fontStyle:"italic"}}>
                {!started?"Ready":`${totalPnL>=0?"+":""}$${fmt(totalPnL)}`}
              </div>
              {started && <div style={{display:"flex",gap:16,marginTop:12,alignItems:"center"}}>
                <span style={{color:totalPnL>=0?C.green:C.red,fontSize:16,fontWeight:600,fontFamily:"'DM Mono',monospace"}}>{fmtPct(totalPnLPct)}</span>
                <span style={{color:C.textFaint,fontSize:11}}>•</span>
                <span style={{color:C.textMute,fontSize:11,fontFamily:"'DM Mono',monospace"}}>ATH ${fmt(allTimeHigh)}</span>
                <span style={{color:C.red,fontSize:11,fontWeight:600,fontFamily:"'DM Mono',monospace"}}>-{drawdown}% DD</span>
              </div>}
            </div>
            <div className="rb-card" style={{padding:"20px 24px",display:"flex",flexDirection:"column",justifyContent:"space-between"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{color:C.textMute,fontSize:10,letterSpacing:".12em",textTransform:"uppercase",fontWeight:600}}>Equity Curve</div>
                <div style={{fontSize:22,fontWeight:600,color:C.text,fontFamily:"'DM Mono',monospace"}}>${fmtK(started?portfolio:startCapital)}</div>
              </div>
              {equityCurve.length > 1
                ? <EquityCurve data={equityCurve} w={340} h={70}/>
                : <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",color:C.textFaint,fontSize:11}}>Deploy to track equity</div>
              }
            </div>
          </div>

          {/* Metrics Grid */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(145px,1fr))",gap:10,marginBottom:12}}>
            {[
              {l:"Cash",v:`$${fmtK(cash)}`,s:`${started&&portfolio>0?((cash/portfolio)*100).toFixed(0):100}% free`,c:!started||cash/portfolio>0.2?C.green:C.amber},
              {l:"Positions",v:`${positions.length}/${RULES.MAX_POSITIONS}`,s:`${uniqueSectors} sectors`,c:C.blue},
              {l:"Unrealized",v:`${unrealPnL>=0?"+":""}$${fmt(unrealPnL)}`,s:"open P&L",c:unrealPnL>=0?C.green:C.red},
              {l:"Realized",v:`${realPnL>=0?"+":""}$${fmt(realPnL)}`,s:`${closedTrades} closed`,c:realPnL>=0?C.green:C.red},
              {l:"Win Rate",v:`${winRate}%`,s:`${winTrades}W/${closedTrades-winTrades}L`,c:parseFloat(winRate)>55?C.green:C.red},
              {l:"Strategies",v:`${mCount}M ${dCount}D ${rCount}R ${sCount}S`,s:"mom/div/rev/rot",c:C.violet},
            ].map((m,i)=>(
              <div key={i} className="rb-card" style={{padding:"14px 16px"}}>
                <div style={{color:C.textMute,fontSize:9,letterSpacing:".1em",textTransform:"uppercase",fontWeight:600,marginBottom:6}}>{m.l}</div>
                <div style={{fontSize:18,fontWeight:700,color:m.c,fontFamily:"'DM Mono',monospace"}}>{m.v}</div>
                <div style={{color:C.textMute,fontSize:10,marginTop:3}}>{m.s}</div>
              </div>
            ))}
          </div>

          {/* Sector Allocation Bar */}
          {started && Object.keys(sectorBreakdown).length > 0 && <div className="rb-card" style={{padding:"14px 18px",marginBottom:12}}>
            <div style={{color:C.textMute,fontSize:9,letterSpacing:".12em",textTransform:"uppercase",fontWeight:600,marginBottom:10}}>Sector Allocation</div>
            <div style={{display:"flex",height:6,borderRadius:4,overflow:"hidden",background:C.surfaceAlt,gap:1}}>
              {Object.entries(sectorBreakdown).sort((a,b)=>b[1]-a[1]).map(([sec,val],i)=>{
                const pct = posValue > 0 ? (val/posValue*100) : 0;
                const colors = ["#ef4444","#3b82f6","#14b8a6","#f59e0b","#8b5cf6","#f97316","#06b6d4","#ec4899","#22c55e"];
                return <div key={sec} style={{width:`${pct}%`,background:colors[i%colors.length],borderRadius:2,minWidth:pct>0?3:0}} title={`${sec}: ${pct.toFixed(0)}%`}/>;
              })}
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:10,marginTop:8}}>
              {Object.entries(sectorBreakdown).sort((a,b)=>b[1]-a[1]).map(([sec,val],i)=>{
                const pct = posValue > 0 ? (val/posValue*100) : 0;
                const colors = ["#ef4444","#3b82f6","#14b8a6","#f59e0b","#8b5cf6","#f97316","#06b6d4","#ec4899","#22c55e"];
                return <span key={sec} style={{fontSize:10,color:C.textMid,display:"flex",alignItems:"center",gap:4}}>
                  <span style={{width:6,height:6,borderRadius:2,background:colors[i%colors.length]}}/>
                  {sec} <span style={{fontFamily:"'DM Mono',monospace",color:C.textMute}}>{pct.toFixed(0)}%</span>
                </span>;
              })}
            </div>
          </div>}

          {/* Rules */}
          <div className="rb-card" style={{padding:"14px 18px",marginBottom:12}}>
            <div style={{color:C.textMute,fontSize:9,letterSpacing:".12em",textTransform:"uppercase",fontWeight:600,marginBottom:10}}>Active Rules — 4 Strategy Layers · {ALL_STOCKS.length} Instruments</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
              {[
                ["4.5% Position","red"],["4% Stop Loss","red"],["15% Take Profit","red"],
                ["3% Trail","red"],["10% Cash Floor","red"],["30% Sector Cap","red"],
                ["12 Max Pos","red"],["ATR Sizing","red"],
                ["MOMENTUM","rose"],["DIVIDEND","teal"],["MEAN REV","blue"],["ROTATION","amber"],
                ["Score 58+ Bull","amber"],["Score 72+ Bear","amber"],["Score 65+ Side","amber"],
                ["10s Scan","slate"],["Vol Confirm","slate"],["RSI + BB","slate"],["Multi-Exit","slate"],
              ].map(([r,t])=>{
                const colors = {red:[C.red,C.redBg],rose:[C.rose,"#1c0f14"],teal:[C.teal,C.tealBg],blue:[C.blue,C.blueBg],amber:[C.amber,C.amberBg],slate:[C.slate,"#14171c"]};
                const [fg,bg] = colors[t];
                return <span key={r} style={{padding:"3px 9px",background:bg,borderRadius:20,fontSize:9,color:fg,fontWeight:600}}>{r}</span>;
              })}
            </div>
          </div>

          {/* Activity Log */}
          <div className="rb-card" style={{padding:"14px 18px"}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
              <span style={{color:C.textMute,fontSize:9,letterSpacing:".12em",textTransform:"uppercase",fontWeight:600}}>Activity Log</span>
              <span style={{color:C.textFaint,fontSize:10,fontFamily:"'DM Mono',monospace"}}>{logs.length}</span>
            </div>
            <div style={{maxHeight:240,overflowY:"auto"}}>
              {logs.length===0
                ? <div style={{color:C.textFaint,textAlign:"center",padding:"36px 0",fontSize:11}}>Deploy capital to begin</div>
                : logs.map((l,i)=>(
                  <div key={i} style={{padding:"5px 0",borderBottom:`1px solid ${C.borderLt}`,display:"flex",gap:12,alignItems:"baseline"}}>
                    <span style={{color:C.textFaint,minWidth:68,fontSize:10,fontFamily:"'DM Mono',monospace"}}>{l.time}</span>
                    <span style={{fontSize:11,fontWeight:l.type==="buy"||l.type==="profit"||l.type==="loss"?600:400,
                      color:l.type==="buy"?C.red:l.type==="profit"?C.green:l.type==="loss"?C.red:l.type==="warn"?C.amber:C.textMid
                    }}>{l.msg}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>}

        {/* ══════ POSITIONS ══════ */}
        {activeTab==="positions" && <div className="rb-fade">
          <div className="rb-card">
            <div style={{padding:"14px 18px",borderBottom:`1px solid ${C.borderLt}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{display:"flex",gap:14,alignItems:"center"}}>
                <span style={{color:C.textMute,fontSize:10,letterSpacing:".12em",textTransform:"uppercase",fontWeight:600}}>Open Positions ({positions.length})</span>
                <span style={{color:unrealPnL>=0?C.green:C.red,fontSize:11,fontWeight:700,fontFamily:"'DM Mono',monospace"}}>{unrealPnL>=0?"+":""}${fmt(unrealPnL)}</span>
              </div>
              <span style={{color:C.red,fontSize:12,fontWeight:600,fontFamily:"'DM Mono',monospace"}}>${fmtK(posValue)}</span>
            </div>
            {positions.length===0
              ? <div style={{color:C.textFaint,textAlign:"center",padding:"60px",fontSize:11}}>No open positions</div>
              : <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr>{["Symbol","Sector","Strategy","Qty","Entry","Current","P&L","P&L %","Value","Chart"].map(h=><th key={h} style={{padding:"10px 14px",textAlign:"left",borderBottom:`1px solid ${C.borderLt}`,color:C.textMute,fontSize:9,letterSpacing:".08em",textTransform:"uppercase",fontWeight:600}}>{h}</th>)}</tr></thead>
                  <tbody>{positions.map((p,i)=>{
                    const d=stockData[p.symbol],cur=d?.current||p.entryPrice;
                    const pl=(cur-p.entryPrice)*p.qty, plPct=(cur-p.entryPrice)/p.entryPrice*100;
                    return(<tr key={i} className="rb-row">
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`,fontWeight:700,fontFamily:"'DM Mono',monospace",fontSize:13}}>{p.symbol}</td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`,color:C.textMid,fontSize:11}}>{p.sector}</td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`}}><span style={{color:stratColor(p.strategy),fontSize:9,fontWeight:700,padding:"3px 8px",background:stratBg(p.strategy),borderRadius:20}}>{p.strategy}</span></td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`,color:C.textMid,fontFamily:"'DM Mono',monospace"}}>{p.qty}</td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`,color:C.textMid,fontFamily:"'DM Mono',monospace"}}>${fmt(p.entryPrice)}</td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`,fontFamily:"'DM Mono',monospace",fontWeight:500}}>${fmt(cur)}</td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`,color:pl>=0?C.green:C.red,fontWeight:700,fontFamily:"'DM Mono',monospace"}}>{pl>=0?"+":""}${fmt(pl)}</td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`,color:plPct>=0?C.green:C.red,fontFamily:"'DM Mono',monospace"}}>{fmtPct(plPct)}</td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`,color:C.textMid,fontFamily:"'DM Mono',monospace"}}>${fmtK(cur*p.qty)}</td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`}}><Spark prices={d?.prices?.slice(-20)} color={pl>=0?C.green:C.red}/></td>
                    </tr>);
                  })}</tbody>
                </table></div>
            }
          </div>
        </div>}

        {/* ══════ WATCHLIST ══════ */}
        {activeTab==="watchlist" && <div className="rb-fade">
          <div style={{display:"flex",gap:16,marginBottom:14,fontSize:10,color:C.textMid,fontWeight:500,flexWrap:"wrap"}}>
            <span><span style={{display:"inline-block",width:7,height:7,borderRadius:"50%",background:C.red,marginRight:5,verticalAlign:"middle"}}/> Momentum ({MOMENTUM_STOCKS.length})</span>
            <span><span style={{display:"inline-block",width:7,height:7,borderRadius:"50%",background:C.teal,marginRight:5,verticalAlign:"middle"}}/> Dividend ({DIVIDEND_STOCKS.length})</span>
            <span><span style={{display:"inline-block",width:7,height:7,borderRadius:"50%",background:C.blue,marginRight:5,verticalAlign:"middle"}}/> Mean Rev ({MEAN_REVERSION.length})</span>
            <span><span style={{display:"inline-block",width:7,height:7,borderRadius:"50%",background:C.orange,marginRight:5,verticalAlign:"middle"}}/> Rotation ({SECTOR_ROTATION.length})</span>
            <span style={{color:C.textFaint,marginLeft:"auto",fontFamily:"'DM Mono',monospace"}}>{ALL_STOCKS.length} total</span>
          </div>
          {Object.keys(stockData).length===0
            ? <div className="rb-card" style={{textAlign:"center",padding:"80px",color:C.textFaint,fontSize:11}}>Deploy bot to load data</div>
            : <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:10}}>
                {Object.values(stockData).sort((a,b)=>b.score-a.score).map(d=>{
                  const held=positions.find(p=>p.symbol===d.symbol);
                  const sc=stratColor(d.strategy); const bg=stratBg(d.strategy);
                  return(<div key={d.symbol} className="rb-card" style={{padding:"14px 16px",borderColor:held?sc+"44":C.border}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                      <div>
                        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                          <span style={{fontWeight:700,fontSize:14,fontFamily:"'DM Mono',monospace"}}>{d.symbol}</span>
                          <span style={{color:sc,fontSize:8,fontWeight:700,letterSpacing:".08em",padding:"2px 7px",background:bg,borderRadius:20}}>{d.strategy}</span>
                          {held&&<span style={{fontSize:8,color:"#fff",padding:"2px 6px",background:C.red,borderRadius:20,fontWeight:600}}>HELD</span>}
                        </div>
                        <div style={{color:C.textMute,fontSize:10}}>{d.name} <span style={{color:C.textFaint}}>· {d.sector}</span></div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:15,fontWeight:700,fontFamily:"'DM Mono',monospace"}}>${fmt(d.current)}</div>
                        <div style={{color:d.change>=0?C.green:C.red,fontSize:10,fontWeight:600,fontFamily:"'DM Mono',monospace"}}>{d.change>=0?"+":""}{d.change}%</div>
                      </div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                      <div style={{flex:1,height:3,background:C.surfaceAlt,borderRadius:3,overflow:"hidden"}}>
                        <div style={{width:`${d.score}%`,height:"100%",borderRadius:3,background:d.score>65?sc:d.score<45?C.red:C.amber}}/>
                      </div>
                      <span style={{color:d.score>65?sc:d.score<45?C.red:C.amber,fontWeight:700,fontSize:12,minWidth:22,textAlign:"right",fontFamily:"'DM Mono',monospace"}}>{d.score}</span>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:4,padding:"8px 0",borderTop:`1px solid ${C.borderLt}`,borderBottom:`1px solid ${C.borderLt}`,marginBottom:8}}>
                      {[
                        {l:"RSI",v:d.rsi,c:d.rsi<35?C.green:d.rsi>70?C.red:C.textMid},
                        {l:"MACD",v:d.macd>0?"▲":"▼",c:d.macd>0?C.green:C.red},
                        {l:"BB",v:`${d.bbPos}%`,c:d.bbPos<20?C.green:d.bbPos>80?C.red:C.textMid},
                        {l:"VOL",v:`${d.volRatio}x`,c:d.volRatio>1.5?C.orange:C.textMid},
                        {l:d.growth?"GRW":"DIV",v:d.growth?`${d.growth}%`:`${d.divYield||0}%`,c:sc},
                      ].map(m=><div key={m.l} style={{textAlign:"center"}}><div style={{color:C.textFaint,fontSize:8,marginBottom:2,fontWeight:600,letterSpacing:".06em"}}>{m.l}</div><div style={{color:m.c,fontWeight:700,fontSize:11,fontFamily:"'DM Mono',monospace"}}>{m.v}</div></div>)}
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end"}}>
                      <div style={{flex:1}}>{d.buySignals.slice(0,3).map(s=><span key={s} style={{display:"inline-block",padding:"2px 6px",background:C.surfaceAlt,border:`1px solid ${C.borderLt}`,borderRadius:20,fontSize:8,color:sc,marginRight:3,fontWeight:600}}>{s}</span>)}{d.sellSignals.slice(0,1).map(s=><span key={s} style={{display:"inline-block",padding:"2px 6px",background:C.redBg,border:`1px solid ${C.redBorder}`,borderRadius:20,fontSize:8,color:C.red,marginRight:3,fontWeight:600}}>⚠ {s}</span>)}</div>
                      <Spark prices={d.prices?.slice(-25)} color={d.change>=0?C.green:C.red}/>
                    </div>
                  </div>);
                })}
              </div>
          }
        </div>}

        {/* ══════ TRADES ══════ */}
        {activeTab==="trades" && <div className="rb-fade">
          <div className="rb-card">
            <div style={{padding:"14px 18px",borderBottom:`1px solid ${C.borderLt}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{display:"flex",gap:14,alignItems:"center"}}>
                <span style={{color:C.textMute,fontSize:10,letterSpacing:".12em",textTransform:"uppercase",fontWeight:600}}>Trade History ({trades.length})</span>
                <span style={{padding:"3px 10px",background:parseFloat(winRate)>55?C.greenBg:C.redBg,color:parseFloat(winRate)>55?C.green:C.red,borderRadius:20,fontSize:10,fontWeight:700,fontFamily:"'DM Mono',monospace"}}>{winRate}% win</span>
                <span style={{color:realPnL>=0?C.green:C.red,fontSize:11,fontWeight:600,fontFamily:"'DM Mono',monospace"}}>{realPnL>=0?"+":""}${fmt(realPnL)} realized</span>
              </div>
              <button className="rb-btn" style={{background:C.surfaceAlt,border:`1px solid ${C.border}`,color:C.textMute,padding:"5px 14px",fontSize:9}} onClick={()=>{if(window.confirm("Clear history?"))setTrades([])}}>Clear</button>
            </div>
            {trades.length===0
              ? <div style={{color:C.textFaint,textAlign:"center",padding:"60px",fontSize:11}}>No trades yet</div>
              : <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr>{["Time","Action","Strategy","Symbol","Qty","Price","P&L","Reason"].map(h=><th key={h} style={{padding:"10px 14px",textAlign:"left",borderBottom:`1px solid ${C.borderLt}`,color:C.textMute,fontSize:9,letterSpacing:".08em",textTransform:"uppercase",fontWeight:600}}>{h}</th>)}</tr></thead>
                  <tbody>{trades.map((t,i)=>{
                    return(<tr key={i} className="rb-row">
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`,color:C.textMute,fontSize:10,fontFamily:"'DM Mono',monospace"}}>{t.time}</td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`}}><span style={{padding:"3px 9px",fontSize:9,fontWeight:700,borderRadius:20,color:t.action==="BUY"?C.red:C.green,background:t.action==="BUY"?C.redBg:C.greenBg}}>{t.action}</span></td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`}}><span style={{color:stratColor(t.strategy),fontSize:9,fontWeight:700,padding:"3px 7px",background:stratBg(t.strategy),borderRadius:20}}>{t.strategy}</span></td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`,fontWeight:700,fontFamily:"'DM Mono',monospace",fontSize:12}}>{t.symbol}</td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`,color:C.textMid,fontFamily:"'DM Mono',monospace"}}>{t.qty}</td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`,color:C.textMid,fontFamily:"'DM Mono',monospace"}}>${fmt(t.price)}</td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`,fontWeight:t.pnl!==undefined?700:400,fontFamily:"'DM Mono',monospace",color:t.pnl===undefined?C.textMute:t.pnl>=0?C.green:C.red}}>{t.pnl!==undefined?`${t.pnl>=0?"+":""}$${fmt(t.pnl)}`:"—"}</td>
                      <td style={{padding:"10px 14px",borderBottom:`1px solid ${C.borderLt}`,color:C.textMid,fontSize:11}}>{t.reason}</td>
                    </tr>);
                  })}</tbody>
                </table></div>
            }
          </div>
        </div>}

        {/* ══════ AI INTEL ══════ */}
        {activeTab==="ai" && <div className="rb-fade">
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:14,alignItems:"center"}}>
            <span style={{color:C.textMute,fontSize:10,letterSpacing:".12em",textTransform:"uppercase",fontWeight:600}}>AI Stock Intelligence — Claude Sonnet</span>
            <button className="rb-btn" style={{background:C.red,color:"#fff",padding:"10px 24px",fontSize:11}} onClick={getAIAnalysis} disabled={isAnalyzing||!started}>
              {isAnalyzing?"Analyzing...":"Run Intel"}
            </button>
          </div>
          <div className="rb-card" style={{minHeight:400,padding:24}}>
            {isAnalyzing
              ? <div style={{color:C.red,textAlign:"center",padding:"140px 0",fontSize:12,fontWeight:500}} className="rb-pulse">Analyzing stock positions & market regime...</div>
              : analysis
                ? <div style={{whiteSpace:"pre-wrap",lineHeight:1.85,color:C.textMid,fontSize:13}}>{analysis}</div>
                : <div style={{color:C.textFaint,textAlign:"center",padding:"140px 0",fontSize:11}}>Deploy bot, then run intel for AI stock strategy briefing</div>
            }
          </div>
        </div>}

      </div>
    </div>
  );
}

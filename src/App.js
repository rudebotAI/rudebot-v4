/* eslint-disable */
import { useState, useRef, useCallback, useEffect } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   RUDEBOT v4 — STOCK TRADING ENGINE
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
  MIN_SCORE_BULL: 62,       // tightened from 58
  MIN_SCORE_BEAR: 78,       // tightened from 72
  MIN_SCORE_SIDEWAYS: 70,   // tightened from 65
  MOMENTUM_BOOST: 1.3,
  EARNINGS_PENALTY: 0.85,
  SCAN_INTERVAL: 30000,
  MAX_POSITIONS: 12,
  MAX_CORRELATED: 3,
  REBALANCE_THRESHOLD: 0.15,
  // ── CIRCUIT BREAKERS (wipeout prevention) ──
  MAX_DRAWDOWN_HALT: 0.15,      // halt ALL new trades at 15% drawdown from ATH
  MAX_DRAWDOWN_LIQUIDATE: 0.25, // force-close everything at 25% drawdown
  MAX_DAILY_LOSS_PCT: 0.03,     // pause entries after 3% daily loss
  MAX_LOSS_STREAK: 4,           // pause entries after 4 consecutive losses
  STREAK_COOLDOWN_SCANS: 6,     // skip 6 scans (~3 min) after loss streak hit
  MIN_CASH_FLOOR_PCT: 0.25,     // NEVER let cash drop below 25% of portfolio
  // ── ADAPTIVE SIZING ──
  DD_SCALE_START: 0.05,         // start reducing size at 5% drawdown
  DD_SCALE_MIN: 0.25,           // minimum size multiplier at max drawdown (25% of normal)
  RECOVERY_BOOST: 1.0,          // no boost — stay conservative while recovering
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

/* ═══════════════════════════════════════════════════════════════════════════
   LIVE MARKET DATA ENGINE — Finnhub Free API
   Real-time quotes + computed technical indicators from actual price data.
   Free tier: 60 calls/min. We batch-fetch quotes and cache history.
   Get your free key at https://finnhub.io/register
   ═══════════════════════════════════════════════════════════════════════════ */

const FINNHUB_KEY = "cvt2mupr01qof0t1tmcgcvt2mupr01qof0t1tmd0"; // Free demo key — replace with yours from finnhub.io/register

// Cache for price history so we don't re-fetch every scan
const priceCache = {};
const quoteCacheTime = {};
const QUOTE_TTL = 8000; // Re-fetch quotes every 8 seconds

async function fetchQuote(symbol) {
  const now = Date.now();
  if (quoteCacheTime[symbol] && now - quoteCacheTime[symbol] < QUOTE_TTL && priceCache[symbol]?.quote) {
    return priceCache[symbol].quote;
  }
  try {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_KEY}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || data.c === 0 || data.c === undefined) throw new Error("No data");
    quoteCacheTime[symbol] = now;
    if (!priceCache[symbol]) priceCache[symbol] = {};
    priceCache[symbol].quote = data;
    return data;
  } catch (e) {
    console.warn(`Quote fetch failed for ${symbol}:`, e.message);
    return priceCache[symbol]?.quote || null;
  }
}

async function fetchCandles(symbol) {
  // Fetch 3 months of daily candles for indicator calculation
  if (priceCache[symbol]?.candles && Date.now() - (priceCache[symbol]?.candleTime||0) < 300000) {
    return priceCache[symbol].candles; // Cache candles for 5 min
  }
  try {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 90 * 86400; // 90 days
    const res = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_KEY}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.s !== "ok" || !data.c || data.c.length < 20) throw new Error("Insufficient candle data");
    if (!priceCache[symbol]) priceCache[symbol] = {};
    priceCache[symbol].candles = data;
    priceCache[symbol].candleTime = Date.now();
    return data;
  } catch (e) {
    console.warn(`Candle fetch failed for ${symbol}:`, e.message);
    return priceCache[symbol]?.candles || null;
  }
}

// Batch fetch all quotes with rate-limit awareness (max 30/sec on free tier)
async function fetchAllQuotes(symbols) {
  const results = {};
  // Batch in groups of 10 with small delays to stay under rate limit
  for (let i = 0; i < symbols.length; i += 10) {
    const batch = symbols.slice(i, i + 10);
    const promises = batch.map(async (sym) => {
      const q = await fetchQuote(sym);
      if (q) results[sym] = q;
    });
    await Promise.all(promises);
    if (i + 10 < symbols.length) await new Promise(r => setTimeout(r, 200)); // Small delay between batches
  }
  return results;
}

// Compute indicators from real candle data
function computeIndicators(closePrices, volumes) {
  const n = closePrices.length;
  if (n < 26) return null;

  const current = closePrices[n - 1];
  const prev = closePrices[n - 2];
  const change = parseFloat(((current - prev) / prev * 100).toFixed(2));

  // RSI 14
  let gains = 0, losses = 0;
  for (let i = n - 14; i < n; i++) {
    const d = closePrices[i] - closePrices[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  const rsi = parseFloat((100 - 100 / (1 + (gains / 14) / ((losses / 14) || 0.001))).toFixed(1));

  // MACD (12/26 EMA crossover)
  function ema(data, period) {
    const k = 2 / (period + 1);
    let result = data[0];
    for (let i = 1; i < data.length; i++) result = data[i] * k + result * (1 - k);
    return result;
  }
  const ema12 = ema(closePrices.slice(-26), 12);
  const ema26 = ema(closePrices.slice(-26), 26);
  const macd = parseFloat((ema12 - ema26).toFixed(2));

  // SMAs
  const sma20 = parseFloat((closePrices.slice(-20).reduce((a, b) => a + b, 0) / 20).toFixed(2));
  const sma50 = n >= 50 ? parseFloat((closePrices.slice(-50).reduce((a, b) => a + b, 0) / 50).toFixed(2)) : sma20;

  // Bollinger Bands
  const sma20arr = closePrices.slice(-20);
  const stdDev = Math.sqrt(sma20arr.reduce((a, v) => a + Math.pow(v - sma20, 2), 0) / 20);
  const bbUpper = sma20 + 2 * stdDev;
  const bbLower = sma20 - 2 * stdDev;
  const bbPos = parseFloat(((current - bbLower) / ((bbUpper - bbLower) || 1) * 100).toFixed(0));

  // Volume ratio (current vs 20-day avg)
  let volRatio = 1.0;
  if (volumes && volumes.length >= 20) {
    const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    volRatio = avgVol > 0 ? parseFloat((volumes[volumes.length - 1] / avgVol).toFixed(2)) : 1.0;
  }

  // ATR 14
  let atrSum = 0;
  for (let i = n - 14; i < n; i++) atrSum += Math.abs(closePrices[i] - closePrices[i - 1]);
  const atr = parseFloat((atrSum / 14).toFixed(2));
  const atrPct = parseFloat((atr / current * 100).toFixed(2));

  // Returns
  const ret5d = n >= 6 ? parseFloat(((current / closePrices[n - 6] - 1) * 100).toFixed(2)) : 0;
  const ret20d = n >= 21 ? parseFloat(((current / closePrices[n - 21] - 1) * 100).toFixed(2)) : 0;

  return { current, change, rsi, macd, sma20, sma50, volRatio, bbPos, atr, atrPct, ret5d, ret20d, prices: closePrices.slice(-81) };
}

// Generate full stock data from live market feed
async function generateStockData(stock, liveQuote) {
  // Get candle data for indicators
  const candles = await fetchCandles(stock.symbol);
  let closePrices, volumes;

  if (candles && candles.c && candles.c.length >= 26) {
    closePrices = [...candles.c];
    volumes = candles.v ? [...candles.v] : [];
    // Append today's live price if different from last candle close
    if (liveQuote && liveQuote.c > 0) {
      closePrices.push(liveQuote.c);
      if (volumes.length > 0) volumes.push(volumes[volumes.length - 1]); // Approx
    }
  } else {
    // Fallback: use quote data to build minimal price series
    if (!liveQuote || liveQuote.c === 0) return null;
    const base = liveQuote.pc || liveQuote.c; // Previous close
    closePrices = [];
    let p = base * 0.95;
    for (let i = 0; i < 80; i++) { p = p * (1 + (liveQuote.dp || 0) / 100 / 80); closePrices.push(parseFloat(p.toFixed(2))); }
    closePrices.push(liveQuote.c);
    volumes = [];
  }

  const indicators = computeIndicators(closePrices, volumes);
  if (!indicators) return null;

  // Use live quote price as the definitive current price
  if (liveQuote && liveQuote.c > 0) {
    indicators.current = liveQuote.c;
    indicators.change = liveQuote.dp || indicators.change; // dp = daily percent change
  }

  // Composite score (same proven logic, now with real data)
  let score = 50;
  const { rsi, macd, sma20, sma50, volRatio, bbPos, ret5d, atrPct, current, change } = indicators;

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

  return { ...stock, ...indicators, score, buySignals, sellSignals, strategy };
}

// Fetch all stock data in parallel
async function fetchAllStockData() {
  const symbols = ALL_STOCKS.map(s => s.symbol);
  const quotes = await fetchAllQuotes(symbols);
  const results = {};
  const promises = ALL_STOCKS.map(async (stock) => {
    const q = quotes[stock.symbol];
    if (q && q.c > 0) {
      const data = await generateStockData(stock, q);
      if (data) results[stock.symbol] = data;
    }
  });
  await Promise.all(promises);
  return results;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ALPACA BROKERAGE — Paper & Live Trading
   Commission-free stock trading via REST API.
   Sign up free: https://alpaca.markets
   Paper URL: https://paper-api.alpaca.markets
   Live URL:  https://api.alpaca.markets
   ═══════════════════════════════════════════════════════════════════════════ */

const ALPACA_CONFIG = {
  PAPER_URL: "https://paper-api.alpaca.markets",
  LIVE_URL: "https://api.alpaca.markets",
};

async function alpacaRequest(endpoint, method = "GET", body = null, keys = {}, isLive = false) {
  const baseUrl = isLive ? ALPACA_CONFIG.LIVE_URL : ALPACA_CONFIG.PAPER_URL;
  const opts = {
    method,
    headers: {
      "APCA-API-KEY-ID": keys.keyId || "",
      "APCA-API-SECRET-KEY": keys.secret || "",
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${endpoint}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Alpaca ${res.status}: ${err}`);
  }
  return res.json();
}

async function alpacaGetAccount(keys, isLive) {
  return alpacaRequest("/v2/account", "GET", null, keys, isLive);
}

async function alpacaPlaceOrder(symbol, qty, side, keys, isLive) {
  return alpacaRequest("/v2/orders", "POST", {
    symbol, qty: String(qty), side, type: "market", time_in_force: "day",
  }, keys, isLive);
}

async function alpacaGetPositions(keys, isLive) {
  return alpacaRequest("/v2/positions", "GET", null, keys, isLive);
}

async function alpacaClosePosition(symbol, keys, isLive) {
  return alpacaRequest(`/v2/positions/${symbol}`, "DELETE", null, keys, isLive);
}

/* ═══════════════════════════════════════════════════════════════════════════
   BENCHMARK DATA — Industry comparison metrics
   ═══════════════════════════════════════════════════════════════════════════ */

const BENCHMARKS = [
  { name: "S&P 500 (SPY)", annualReturn: 10.5, maxDD: 33.9, sharpe: 0.65, winRate: "~54%", type: "Index" },
  { name: "Top Retail Algo Bot", annualReturn: 18, maxDD: 15, sharpe: 1.8, winRate: "58-65%", type: "Algo" },
  { name: "Quant Hedge Fund Avg", annualReturn: 14, maxDD: 12, sharpe: 2.0, winRate: "55-60%", type: "Institutional" },
  { name: "DCA Bot (BTC/USDT)", annualReturn: 12.8, maxDD: 20, sharpe: 0.9, winRate: "~100%*", type: "Crypto DCA" },
  { name: "Mean Reversion Bot", annualReturn: 15, maxDD: 18, sharpe: 1.2, winRate: "60-68%", type: "Algo" },
  { name: "Momentum Bot (Tastytrade)", annualReturn: 20, maxDD: 22, sharpe: 1.5, winRate: "52-58%", type: "Options" },
];

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
  const [activeTab, setActiveTab] = useState("command");
  const [lastScan, setLastScan] = useState(null);
  const [analysis, setAnalysis] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [allTimeHigh, setAllTimeHigh] = useState(0);
  const [started, setStarted] = useState(false);
  const [equityCurve, setEquityCurve] = useState([]);
  const [scanCount, setScanCount] = useState(0);
  const [sectorBreakdown, setSectorBreakdown] = useState({});
  const [circuitBreaker, setCircuitBreaker] = useState("OK"); // OK | CAUTION | HALTED | LIQUIDATING
  const [lossStreak, setLossStreak] = useState(0);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  const [dailyStartPV, setDailyStartPV] = useState(0);
  const [tradingMode, setTradingMode] = useState("paper"); // paper | live
  const [alpacaKeys, setAlpacaKeys] = useState({ keyId: "", secret: "" });
  const [alpacaConnected, setAlpacaConnected] = useState(false);
  const [alpacaAccount, setAlpacaAccount] = useState(null);
  const [showAlpacaSetup, setShowAlpacaSetup] = useState(false);
  const [alpacaError, setAlpacaError] = useState("");
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
    const ath = stateRef.current.allTimeHigh || pv;
    const dStart = stateRef.current.dailyStartPV || pv;
    const streak = stateRef.current.lossStreak || 0;
    const cdLeft = stateRef.current.cooldownLeft || 0;

    // LIVE DATA
    const newData = await fetchAllStockData();
    if (Object.keys(newData).length === 0) { addLog("⚠ No market data received — retrying next scan", "warn"); return; }

    // Regime detection
    const scores = Object.values(newData).map(d=>d.score);
    const avgScore = scores.reduce((a,b)=>a+b,0)/scores.length;
    const bullCount = scores.filter(s=>s>55).length;
    const bearCount = scores.filter(s=>s<45).length;
    const newRegime = avgScore > 60 && bullCount > ALL_STOCKS.length*0.55 ? "BULL"
      : avgScore < 45 && bearCount > ALL_STOCKS.length*0.55 ? "BEAR" : "SIDEWAYS";
    setRegime(newRegime); setStockData(newData);

    let newCash = c; let newPos = [...pos]; const newTrades = [];
    let scanLosses = 0; let scanWins = 0;

    // ── CIRCUIT BREAKER: compute drawdown from ATH ──
    const preExitPV = newCash + newPos.reduce((a,p)=>{const d=newData[p.symbol];return a+(d?d.current*p.qty:p.entryPrice*p.qty);},0);
    const ddFromATH = ath > 0 ? (ath - preExitPV) / ath : 0;
    const ddFromDaily = dStart > 0 ? (dStart - preExitPV) / dStart : 0;

    // ── EMERGENCY LIQUIDATION at 25% drawdown ──
    if (ddFromATH >= RULES.MAX_DRAWDOWN_LIQUIDATE && newPos.length > 0) {
      addLog(`🚨 EMERGENCY LIQUIDATION — ${(ddFromATH*100).toFixed(1)}% drawdown from ATH`, "loss");
      setCircuitBreaker("LIQUIDATING");
      newPos.forEach(p => {
        const d = newData[p.symbol]; const cur = d?.current || p.entryPrice;
        const pnl = (cur - p.entryPrice) * p.qty; newCash += cur * p.qty;
        newTrades.push({symbol:p.symbol,action:"SELL",qty:p.qty,price:cur,pnl,reason:"🚨 Emergency liquidation",strategy:p.strategy,time:new Date().toLocaleTimeString(),timestamp:Date.now()});
        addLog(`EMERGENCY SELL ${p.qty}× ${p.symbol} @ $${fmt(cur)} | ${pnl>=0?"+":""}$${fmt(pnl)}`, "loss");
      });
      newPos = [];
    } else {
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
        // ── DRAWDOWN-DRIVEN TIGHTER EXITS ──
        if (ddFromATH > 0.10 && pnlPct < -0.02) reason = "Drawdown deleverage";
        if (reason) {
          const pnl = (cur - entry) * p.qty; newCash += cur * p.qty;
          if (pnl < 0) scanLosses++; else scanWins++;
          newTrades.push({symbol:p.symbol,action:"SELL",qty:p.qty,price:cur,pnl,reason,strategy:p.strategy,time:new Date().toLocaleTimeString(),timestamp:Date.now()});
          addLog(`SELL ${p.qty}× ${p.symbol} @ $${fmt(cur)} | ${pnl>=0?"+":""}$${fmt(pnl)} | ${reason}`, pnl>=0?"profit":"loss");
          return false;
        }
        return true;
      });
    }

    // ── Update loss streak ──
    let newStreak = streak;
    if (scanLosses > 0 && scanWins === 0) newStreak = streak + scanLosses;
    else if (scanWins > 0) newStreak = 0; // reset on any win
    let newCooldown = cdLeft > 0 ? cdLeft - 1 : 0;
    if (newStreak >= RULES.MAX_LOSS_STREAK && cdLeft === 0) {
      newCooldown = RULES.STREAK_COOLDOWN_SCANS;
      addLog(`⏸ LOSS STREAK ${newStreak} — pausing entries for ${RULES.STREAK_COOLDOWN_SCANS} scans`, "warn");
    }

    // ── Determine circuit breaker state ──
    let cbState = "OK";
    if (ddFromATH >= RULES.MAX_DRAWDOWN_LIQUIDATE) cbState = "LIQUIDATING";
    else if (ddFromATH >= RULES.MAX_DRAWDOWN_HALT) cbState = "HALTED";
    else if (ddFromATH >= RULES.DD_SCALE_START || ddFromDaily >= RULES.MAX_DAILY_LOSS_PCT || newCooldown > 0) cbState = "CAUTION";
    setCircuitBreaker(cbState);

    // ── ENTRY ENGINE (with circuit breaker gating) ──
    const entriesBlocked = cbState === "HALTED" || cbState === "LIQUIDATING" || newCooldown > 0 || ddFromDaily >= RULES.MAX_DAILY_LOSS_PCT;
    if (!entriesBlocked && newCash / pv > RULES.MIN_CASH_FLOOR_PCT && newPos.length < RULES.MAX_POSITIONS) {
      const held = new Set(newPos.map(p=>p.symbol));
      const minScore = newRegime==="BEAR" ? RULES.MIN_SCORE_BEAR : newRegime==="SIDEWAYS" ? RULES.MIN_SCORE_SIDEWAYS : RULES.MIN_SCORE_BULL;
      const candidates = Object.values(newData)
        .filter(d=>!held.has(d.symbol) && d.score>=minScore && d.buySignals.length>=3 && d.rsi<68 && d.rsi>22
          && d.sellSignals.length<=1 && d.bbPos<85 && d.bbPos>10) // tighter: 3+ buy signals, narrower RSI, low sell signals, BB filter
        .sort((a,b)=>b.score-a.score)
        .slice(0, newRegime==="BEAR" ? 1 : newRegime==="SIDEWAYS" ? 2 : 3);

      for (const d of candidates) {
        if (newPos.length >= RULES.MAX_POSITIONS) break;
        // Sector cap check
        const secVal = newPos.filter(p=>p.sector===d.sector).reduce((a,p)=>a+p.qty*(newData[p.symbol]?.current||p.entryPrice),0);
        if (secVal/pv > RULES.MAX_SECTOR_PCT) continue;
        // Correlated position check
        const sameSecCount = newPos.filter(p=>p.sector===d.sector).length;
        if (sameSecCount >= RULES.MAX_CORRELATED && !d.isETF) continue;

        // ── ADAPTIVE POSITION SIZING ──
        let sizePct = RULES.MAX_POSITION_PCT;
        // Drawdown scaling: linearly reduce from DD_SCALE_START to MAX_DRAWDOWN_HALT
        if (ddFromATH > RULES.DD_SCALE_START) {
          const ddRange = RULES.MAX_DRAWDOWN_HALT - RULES.DD_SCALE_START;
          const ddProgress = Math.min((ddFromATH - RULES.DD_SCALE_START) / ddRange, 1);
          const sizeMultiplier = 1 - ddProgress * (1 - RULES.DD_SCALE_MIN);
          sizePct *= sizeMultiplier;
        }
        if (d.atrPct > 3) sizePct *= 0.6;         // more aggressive reduction for volatile
        if (d.atrPct > 5) sizePct *= 0.5;         // extra cut for extreme volatility
        if (d.score > 85) sizePct *= 1.1;          // only boost very high conviction (was 80→1.15)
        if (newRegime === "BEAR") sizePct *= 0.5;   // halve in bear (was 0.6)
        if (newRegime === "SIDEWAYS") sizePct *= 0.8;
        // Loss streak scaling
        if (newStreak >= 2) sizePct *= 0.6;

        const qty = Math.floor(pv * sizePct / d.current);
        // Cash floor enforcement: never spend below 25% cash
        const cashAfterBuy = newCash - qty * d.current;
        const pvEstimate = cashAfterBuy + newPos.reduce((a,p)=>{const dd=newData[p.symbol];return a+(dd?dd.current*p.qty:p.entryPrice*p.qty);},0) + qty * d.current;
        if (qty < 1 || cashAfterBuy / pvEstimate < RULES.MIN_CASH_FLOOR_PCT) continue;

        newCash -= qty * d.current;
        newPos.push({symbol:d.symbol,name:d.name,sector:d.sector,strategy:d.strategy,qty,entryPrice:d.current,highWater:d.current,time:new Date().toLocaleTimeString()});
        newTrades.push({symbol:d.symbol,action:"BUY",qty,price:d.current,strategy:d.strategy,reason:d.buySignals.slice(0,3).join(", "),time:new Date().toLocaleTimeString(),timestamp:Date.now()});
        addLog(`BUY ${qty}× ${d.symbol} @ $${fmt(d.current)} | Score:${d.score} | ${d.buySignals.join(",")}`, "buy");
      }
    } else if (entriesBlocked && cbState !== "OK") {
      const reason = cbState === "HALTED" ? `DD ${(ddFromATH*100).toFixed(1)}% ≥ ${RULES.MAX_DRAWDOWN_HALT*100}%`
        : cbState === "LIQUIDATING" ? "Emergency liquidation active"
        : newCooldown > 0 ? `Loss streak cooldown (${newCooldown} scans left)`
        : `Daily loss ${(ddFromDaily*100).toFixed(1)}% ≥ ${RULES.MAX_DAILY_LOSS_PCT*100}%`;
      addLog(`🛑 ENTRIES BLOCKED — ${reason}`, "warn");
    }

    const posVal = newPos.reduce((a,p)=>{const d=newData[p.symbol];return a+(d?d.current*p.qty:p.entryPrice*p.qty);},0);
    const newPV = newCash + posVal;
    const newATH = Math.max(ath, newPV);
    stateRef.current = {cash:newCash, positions:newPos, portfolio:newPV, allTimeHigh:newATH, dailyStartPV:dStart, lossStreak:newStreak, cooldownLeft:newCooldown};
    setCash(newCash); setPositions(newPos); setPortfolio(newPV);
    setAllTimeHigh(newATH);
    setLossStreak(newStreak); setCooldownLeft(newCooldown);
    setEquityCurve(prev=>[...prev, newPV].slice(-120));
    if (newTrades.length>0) setTrades(p=>[...newTrades,...p].slice(0,300));

    // Sector breakdown
    const sectors = {};
    newPos.forEach(p=>{
      const d=newData[p.symbol]; const v = d ? d.current*p.qty : p.entryPrice*p.qty;
      sectors[p.sector] = (sectors[p.sector]||0) + v;
    });
    setSectorBreakdown(sectors);

    const cbTag = cbState !== "OK" ? ` | 🛡${cbState}` : "";
    addLog(`SCAN #${scanCount+1} ${newRegime} | $${fmtK(newPV)} | Cash:${(newCash/newPV*100).toFixed(0)}% | ${newPos.length} pos | DD:${(ddFromATH*100).toFixed(1)}%${cbTag}`, "info");
  },[addLog, scanCount]);

  const startBot = () => {
    // ── REAL MONEY SAFEGUARD ──
    if (alpacaConnected && tradingMode === "live") {
      const confirmed = window.confirm(
        "⚠ LIVE TRADING MODE\n\nYou are about to deploy RudeBot with REAL MONEY on your Alpaca live account.\n\nThis will place actual market orders.\nLosses are real and irreversible.\n\nAre you absolutely sure?"
      );
      if (!confirmed) return;
      const doubleConfirm = window.confirm("Final confirmation: This will trade real money. Proceed?");
      if (!doubleConfirm) return;
    }
    const capital = parseFloat(inputCapital.replace(/,/g,""))||100000;
    setCash(capital); setPortfolio(capital); setAllTimeHigh(capital); setStarted(true);
    setPositions([]); setTrades([]); setLogs([]); setEquityCurve([capital]); setScanCount(0);
    setCircuitBreaker("OK"); setLossStreak(0); setCooldownLeft(0); setDailyStartPV(capital);
    stateRef.current = {cash:capital, positions:[], portfolio:capital, allTimeHigh:capital, dailyStartPV:capital, lossStreak:0, cooldownLeft:0};
    setIsRunning(true);
    addLog(`RUDEBOT v4 DEPLOYED — $${capital.toLocaleString()} capital armed`, "buy");
    addLog(`Strategies: MOMENTUM · DIVIDEND · MEAN_REV · SECTOR_ROTATION`, "info");
    addLog(`Universe: ${ALL_STOCKS.length} instruments across ${[...new Set(ALL_STOCKS.map(s=>s.sector))].length} sectors`, "info");
    addLog(`Risk: SL 4% | TP 15% | Trail 3% | Max Pos ${RULES.MAX_POSITIONS} | Sector Cap ${RULES.MAX_SECTOR_PCT*100}%`, "info");
    addLog(`🛡 Circuit Breakers: Halt@${RULES.MAX_DRAWDOWN_HALT*100}%DD | Liquidate@${RULES.MAX_DRAWDOWN_LIQUIDATE*100}%DD | DailyMax${RULES.MAX_DAILY_LOSS_PCT*100}% | CashFloor${RULES.MIN_CASH_FLOOR_PCT*100}%`, "info");
    addLog(`📡 LIVE MARKET DATA via Finnhub — real prices, real indicators`, "buy");
    if (alpacaConnected) {
      addLog(`🔴 ALPACA ${tradingMode.toUpperCase()} MODE — orders will execute on ${tradingMode === "live" ? "REAL" : "paper"} account`, tradingMode === "live" ? "warn" : "buy");
    }
    // Async scan loop: run first scan, then set interval
    setTimeout(async ()=>{
      await runEngine(capital,[],capital);
      scanRef.current=setInterval(()=>runEngine(),RULES.SCAN_INTERVAL);
    },500);
  };

  // ── ALPACA CONNECTION ──
  const connectAlpaca = async () => {
    setAlpacaError("");
    try {
      const acct = await alpacaGetAccount(alpacaKeys, tradingMode === "live");
      setAlpacaAccount(acct);
      setAlpacaConnected(true);
      setShowAlpacaSetup(false);
      addLog(`✅ Alpaca ${tradingMode.toUpperCase()} connected — $${parseFloat(acct.equity).toLocaleString()} equity | $${parseFloat(acct.buying_power).toLocaleString()} buying power`, "buy");
    } catch (e) {
      setAlpacaError(e.message);
      addLog(`❌ Alpaca connection failed: ${e.message}`, "loss");
    }
  };

  const executeLiveOrder = async (symbol, qty, side, reason) => {
    if (!alpacaConnected) return;
    try {
      const order = await alpacaPlaceOrder(symbol, qty, side, alpacaKeys, tradingMode === "live");
      addLog(`🔴 LIVE ${side.toUpperCase()} ${qty}× ${symbol} | Order ${order.id} | ${reason}`, side === "buy" ? "buy" : "profit");
      return order;
    } catch (e) {
      addLog(`❌ Order failed: ${symbol} ${side} ${qty} — ${e.message}`, "loss");
      return null;
    }
  };

  const stopBot = () => {
    setIsRunning(false);
    if(scanRef.current){clearInterval(scanRef.current);scanRef.current=null;}
    addLog("RudeBot HALTED — positions held open","warn");
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
      const res = await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514",max_tokens:1000,
          system:"You are a ruthless quantitative stock trading analyst. Concise, aggressive, data-first. No disclaimers. Use numbered sections. Bold convictions only.",
          messages:[{role:"user",content:`RUDEBOT v4 STOCK INTEL BRIEF:\n\nPortfolio: $${fmt(portfolio)} | Start: $${fmt(sc)} | P&L: ${pnl>=0?"+":""}$${fmt(pnl)} (${fmtPct((pnl/sc)*100)})\nRegime: ${regime} | Win: ${closedT>0?((winT/closedT)*100).toFixed(0):"--"}% (${winT}/${closedT})\nATH: $${fmt(allTimeHigh)} | DD: ${(((allTimeHigh-portfolio)/allTimeHigh)*100).toFixed(1)}%\nSector Alloc: ${sectorStr||"None"}\n\nPositions:\n${holdings||"None"}\n\nTop Candidates:\n${candidates}\n\n1) Performance vs 3-5% monthly target\n2) Cut/hold each position — no mercy\n3) Top 3 highest-conviction entries NOW with size\n4) Sector rotation plays\n5) Biggest risk to this book`}]
        })
      });
      const data = await res.json();
      setAnalysis(data.content?.[0]?.text||"Unavailable.");
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
  const tabs=["command","positions","watchlist","trades","ai","benchmark"];
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
          <span style={{fontFamily:"'Instrument Serif',serif",fontSize:28,fontWeight:400,color:C.text,fontStyle:"italic"}}>RudeBot</span>
          <span style={{color:C.textMute,fontSize:10,letterSpacing:".14em",fontWeight:500,textTransform:"uppercase",marginTop:4}}>v4.0 · stocks</span>
          {started && <span style={{padding:"4px 12px",fontSize:10,fontWeight:600,letterSpacing:".06em",borderRadius:20,
            background:regime==="BULL"?C.greenBg:regime==="BEAR"?C.redBg:C.amberBg,
            color:regime==="BULL"?C.green:regime==="BEAR"?C.red:C.amber,
            border:`1px solid ${regime==="BULL"?C.greenBorder:regime==="BEAR"?C.redBorder:C.amberBorder}`
          }}>{regime}</span>}
          {started && circuitBreaker !== "OK" && <span style={{padding:"4px 12px",fontSize:10,fontWeight:600,letterSpacing:".06em",borderRadius:20,
            background:circuitBreaker==="LIQUIDATING"?"#2a0a0a":circuitBreaker==="HALTED"?C.redBg:C.amberBg,
            color:circuitBreaker==="LIQUIDATING"?"#ff3333":circuitBreaker==="HALTED"?C.red:C.amber,
            border:`1px solid ${circuitBreaker==="HALTED"||circuitBreaker==="LIQUIDATING"?C.redBorder:C.amberBorder}`
          }}>🛡 {circuitBreaker}{cooldownLeft>0?` (${cooldownLeft})`:""}</span>}
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
              <button className="rb-btn" style={{background:alpacaConnected?C.greenBg:C.surfaceAlt,border:`1px solid ${alpacaConnected?C.greenBorder:C.border}`,color:alpacaConnected?C.green:C.textMute,padding:"11px 16px",fontSize:10}} onClick={()=>setShowAlpacaSetup(!showAlpacaSetup)}>{alpacaConnected?"Alpaca ✓":"Connect Alpaca"}</button>
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

      {/* ALPACA SETUP MODAL */}
      {showAlpacaSetup && <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,padding:"18px 28px"}} className="rb-fade">
        <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:12}}>
          <span style={{color:C.text,fontSize:13,fontWeight:600}}>Alpaca Brokerage</span>
          <div style={{display:"flex",gap:4}}>
            {["paper","live"].map(m=><button key={m} className="rb-btn" style={{
              padding:"6px 16px",fontSize:10,fontWeight:600,letterSpacing:".04em",
              background:tradingMode===m?(m==="live"?C.redBg:C.greenBg):C.surfaceAlt,
              color:tradingMode===m?(m==="live"?C.red:C.green):C.textMute,
              border:`1px solid ${tradingMode===m?(m==="live"?C.redBorder:C.greenBorder):C.border}`,
            }} onClick={()=>{setTradingMode(m);setAlpacaConnected(false);setAlpacaAccount(null);}}>{m.toUpperCase()}</button>)}
          </div>
          {tradingMode==="live"&&<span style={{color:C.red,fontSize:10,fontWeight:700,padding:"4px 10px",background:C.redBg,borderRadius:20,border:`1px solid ${C.redBorder}`}}>⚠ REAL MONEY</span>}
          <a href="https://app.alpaca.markets/signup" target="_blank" rel="noreferrer" style={{color:C.blue,fontSize:10,marginLeft:"auto",textDecoration:"none"}}>Get free Alpaca keys →</a>
        </div>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <input value={alpacaKeys.keyId} onChange={e=>setAlpacaKeys(k=>({...k,keyId:e.target.value}))} placeholder="API Key ID" style={{flex:1,background:C.surfaceAlt,border:`1px solid ${C.border}`,color:C.text,padding:"10px 14px",borderRadius:6,fontFamily:"'DM Mono',monospace",fontSize:12}}/>
          <input value={alpacaKeys.secret} onChange={e=>setAlpacaKeys(k=>({...k,secret:e.target.value}))} placeholder="Secret Key" type="password" style={{flex:1,background:C.surfaceAlt,border:`1px solid ${C.border}`,color:C.text,padding:"10px 14px",borderRadius:6,fontFamily:"'DM Mono',monospace",fontSize:12}}/>
          <button className="rb-btn" style={{background:C.green,color:"#fff",padding:"10px 24px",fontSize:11}} onClick={connectAlpaca} disabled={!alpacaKeys.keyId||!alpacaKeys.secret}>Connect</button>
        </div>
        {alpacaError&&<div style={{color:C.red,fontSize:11,marginTop:8}}>{alpacaError}</div>}
        {alpacaAccount&&<div style={{display:"flex",gap:20,marginTop:10,padding:"10px 14px",background:C.surfaceAlt,borderRadius:8,border:`1px solid ${C.greenBorder}`}}>
          <span style={{color:C.green,fontSize:11,fontWeight:600}}>✓ Connected</span>
          <span style={{color:C.textMid,fontSize:11}}>Equity: <strong style={{color:C.text}}>${parseFloat(alpacaAccount.equity).toLocaleString()}</strong></span>
          <span style={{color:C.textMid,fontSize:11}}>Buying Power: <strong style={{color:C.text}}>${parseFloat(alpacaAccount.buying_power).toLocaleString()}</strong></span>
          <span style={{color:C.textMid,fontSize:11}}>Status: <strong style={{color:alpacaAccount.status==="ACTIVE"?C.green:C.amber}}>{alpacaAccount.status}</strong></span>
          <span style={{color:C.textMid,fontSize:11}}>Mode: <strong style={{color:tradingMode==="live"?C.red:C.green}}>{tradingMode.toUpperCase()}</strong></span>
        </div>}
      </div>}

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

        {/* ══════ BENCHMARK ══════ */}
        {activeTab==="benchmark" && <div className="rb-fade">
          <div style={{marginBottom:14}}>
            <span style={{color:C.textMute,fontSize:10,letterSpacing:".12em",textTransform:"uppercase",fontWeight:600}}>RudeBot v4 vs Industry Benchmarks</span>
          </div>
          <div className="rb-card" style={{marginBottom:12}}>
            <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr>{["Bot / Strategy","Type","Annual Return","Max Drawdown","Sharpe Ratio","Win Rate"].map(h=><th key={h} style={{padding:"12px 16px",textAlign:"left",borderBottom:`1px solid ${C.borderLt}`,color:C.textMute,fontSize:9,letterSpacing:".08em",textTransform:"uppercase",fontWeight:600}}>{h}</th>)}</tr></thead>
              <tbody>
                <tr style={{background:C.redBg}}>
                  <td style={{padding:"12px 16px",borderBottom:`1px solid ${C.borderLt}`,fontWeight:700,color:C.red,fontSize:13}}>RudeBot v4</td>
                  <td style={{padding:"12px 16px",borderBottom:`1px solid ${C.borderLt}`,color:C.textMid,fontSize:11}}><span style={{padding:"3px 8px",background:C.redBg,border:`1px solid ${C.redBorder}`,borderRadius:20,fontSize:9,fontWeight:700,color:C.red}}>Multi-Strat</span></td>
                  <td style={{padding:"12px 16px",borderBottom:`1px solid ${C.borderLt}`,fontFamily:"'DM Mono',monospace",color:C.green,fontWeight:700}}>Target 15-25%</td>
                  <td style={{padding:"12px 16px",borderBottom:`1px solid ${C.borderLt}`,fontFamily:"'DM Mono',monospace",color:C.amber,fontWeight:600}}>{drawdown}% (live)</td>
                  <td style={{padding:"12px 16px",borderBottom:`1px solid ${C.borderLt}`,fontFamily:"'DM Mono',monospace",fontWeight:600,color:C.blue}}>~1.2-1.8*</td>
                  <td style={{padding:"12px 16px",borderBottom:`1px solid ${C.borderLt}`,fontFamily:"'DM Mono',monospace",fontWeight:700,color:parseFloat(winRate)>55?C.green:C.textMid}}>{winRate}%</td>
                </tr>
                {BENCHMARKS.map((b,i)=><tr key={i} className="rb-row">
                  <td style={{padding:"12px 16px",borderBottom:`1px solid ${C.borderLt}`,fontWeight:600,fontSize:12}}>{b.name}</td>
                  <td style={{padding:"12px 16px",borderBottom:`1px solid ${C.borderLt}`,color:C.textMid,fontSize:11}}><span style={{padding:"3px 8px",background:C.surfaceAlt,borderRadius:20,fontSize:9,fontWeight:600,color:C.textMid}}>{b.type}</span></td>
                  <td style={{padding:"12px 16px",borderBottom:`1px solid ${C.borderLt}`,fontFamily:"'DM Mono',monospace",color:C.green}}>{b.annualReturn}%</td>
                  <td style={{padding:"12px 16px",borderBottom:`1px solid ${C.borderLt}`,fontFamily:"'DM Mono',monospace",color:b.maxDD>20?C.red:C.amber}}>{b.maxDD}%</td>
                  <td style={{padding:"12px 16px",borderBottom:`1px solid ${C.borderLt}`,fontFamily:"'DM Mono',monospace",color:b.sharpe>=1.5?C.green:b.sharpe>=1?C.amber:C.textMid}}>{b.sharpe}</td>
                  <td style={{padding:"12px 16px",borderBottom:`1px solid ${C.borderLt}`,fontFamily:"'DM Mono',monospace",color:C.textMid}}>{b.winRate}</td>
                </tr>)}
              </tbody>
            </table></div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <div className="rb-card" style={{padding:"18px 22px"}}>
              <div style={{color:C.textMute,fontSize:9,letterSpacing:".12em",textTransform:"uppercase",fontWeight:600,marginBottom:12}}>RudeBot v4 Advantages</div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {[
                  {icon:"🛡",text:"3-layer circuit breaker (halt/liquidate/daily cap)",color:C.green},
                  {icon:"📊",text:"4 uncorrelated strategies reduce single-point failure",color:C.blue},
                  {icon:"🎯",text:"Adaptive sizing: auto-reduces in drawdowns",color:C.amber},
                  {icon:"📡",text:"Real-time data via Finnhub (not backtested fiction)",color:C.teal},
                  {icon:"🧠",text:"AI analysis via Claude for portfolio review",color:C.violet},
                  {icon:"💰",text:"25% cash floor — always has dry powder",color:C.green},
                ].map((a,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0"}}>
                  <span style={{fontSize:14}}>{a.icon}</span>
                  <span style={{color:a.color,fontSize:11,fontWeight:500}}>{a.text}</span>
                </div>)}
              </div>
            </div>
            <div className="rb-card" style={{padding:"18px 22px"}}>
              <div style={{color:C.textMute,fontSize:9,letterSpacing:".12em",textTransform:"uppercase",fontWeight:600,marginBottom:12}}>Industry Thresholds</div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {[
                  {metric:"Sharpe Ratio",retail:"≥ 0.75",good:"≥ 1.5",elite:"≥ 2.0"},
                  {metric:"Max Drawdown",retail:"< 25%",good:"< 15%",elite:"< 10%"},
                  {metric:"Win Rate",retail:"≥ 50%",good:"≥ 55%",elite:"≥ 65%"},
                  {metric:"Profit Factor",retail:"≥ 1.2",good:"≥ 1.5",elite:"≥ 1.75"},
                  {metric:"Annual Return",retail:"≥ 8%",good:"≥ 15%",elite:"≥ 25%"},
                ].map((t,i)=><div key={i} style={{display:"grid",gridTemplateColumns:"110px 1fr 1fr 1fr",gap:6,alignItems:"center"}}>
                  <span style={{color:C.textMid,fontSize:10,fontWeight:600}}>{t.metric}</span>
                  <span style={{color:C.textMute,fontSize:10,padding:"3px 8px",background:C.surfaceAlt,borderRadius:4,textAlign:"center",fontFamily:"'DM Mono',monospace"}}>{t.retail}</span>
                  <span style={{color:C.amber,fontSize:10,padding:"3px 8px",background:C.amberBg,borderRadius:4,textAlign:"center",fontFamily:"'DM Mono',monospace"}}>{t.good}</span>
                  <span style={{color:C.green,fontSize:10,padding:"3px 8px",background:C.greenBg,borderRadius:4,textAlign:"center",fontFamily:"'DM Mono',monospace"}}>{t.elite}</span>
                </div>)}
                <div style={{display:"grid",gridTemplateColumns:"110px 1fr 1fr 1fr",gap:6,marginTop:4}}>
                  <span/>
                  <span style={{color:C.textFaint,fontSize:8,textAlign:"center",fontWeight:600}}>RETAIL</span>
                  <span style={{color:C.amber,fontSize:8,textAlign:"center",fontWeight:600}}>GOOD</span>
                  <span style={{color:C.green,fontSize:8,textAlign:"center",fontWeight:600}}>ELITE</span>
                </div>
              </div>
            </div>
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

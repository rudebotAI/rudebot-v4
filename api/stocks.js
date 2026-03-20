// Upgraded Vercel serverless function for institutional-grade stock analysis
// Fetches data from Alpaca Markets API with advanced technical indicators

const CACHE_DURATION_SECONDS = 30;
let cachedData = null;
let cacheTimestamp = 0;

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Check environment variables
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_API_SECRET) {
    return res.status(500).json({
      error: 'Missing ALPACA_API_KEY or ALPACA_API_SECRET environment variables'
    });
  }

  // Check cache
  const now = Date.now();
  if (cachedData && (now - cacheTimestamp) < CACHE_DURATION_SECONDS * 1000) {
    return res.status(200).json(cachedData);
  }

  try {
    const symbols = req.query.symbols ? req.query.symbols.split(',') : ['SPY', 'QQQ', 'IWM'];

    // Fetch all required data in parallel
    const [snapshots, dailyBars, intradayBars] = await Promise.all([
      fetchSnapshots(symbols),
      fetchDailyBars(symbols),
      fetchIntradayBars(symbols)
    ]);

    // Fetch sector ETFs for strength ranking
    const sectorSymbols = ['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLRE', 'XLU'];
    const [sectorSnapshots, sectorDailyBars] = await Promise.all([
      fetchSnapshots(sectorSymbols),
      fetchDailyBars(sectorSymbols)
    ]);

    // Fetch VIX proxy data (VIXY or VXX)
    const [vixSnapshots, vixBars] = await Promise.all([
      fetchSnapshots(['VIXY']),
      fetchDailyBars(['VIXY'])
    ]);

    // Build market breadth and indicators
    const result = {};
    let aboveCount = 0;
    let totalCount = symbols.length;
    const volumeRatios = [];

    for (const symbol of symbols) {
      const snapshot = snapshots[symbol];
      const daily = dailyBars[symbol] || [];
      const intraday = intradayBars[symbol] || [];

      if (!snapshot || daily.length === 0) continue;

      // Compute technical indicators
      const indicators = computeIndicators(symbol, daily, intraday, snapshot);

      // Check if above 20-day SMA for breadth
      if (indicators.sma20 && snapshot.prevClose > indicators.sma20 * 0.995) {
        aboveCount++;
      }

      // Track volume ratio
      if (indicators.volumeRatio) {
        volumeRatios.push(indicators.volumeRatio);
      }

      result[symbol] = {
        price: snapshot.price,
        priceChange: snapshot.priceChange,
        priceChangePercent: snapshot.priceChangePercent,
        volume: snapshot.volume,
        prevClose: snapshot.prevClose,
        ...indicators
      };
    }

    // Compute SPY-specific metrics
    const spyDaily = dailyBars['SPY'] || [];
    const spySnapshot = snapshots['SPY'];
    const spyTrend = computeSpyTrend(spyDaily, spySnapshot);
    const spyAboveSma50 = computeSpyAboveSma50(spyDaily, spySnapshot);

    // Compute sector strength ranking
    const sectorRank = computeSectorRanking(sectorDailyBars, sectorSnapshots, dailyBars['SPY']);

    // Compute VIX or implied volatility proxy
    const vixValue = computeVixProxy(vixSnapshots, vixBars, dailyBars['SPY'] || []);

    // Compute average volume ratio
    const avgVolRatio = volumeRatios.length > 0
      ? volumeRatios.reduce((a, b) => a + b, 0) / volumeRatios.length
      : 1.0;

    // Add market-level indicators
    result._market = {
      vix: vixValue,
      breadth: totalCount > 0 ? aboveCount / totalCount : 0,
      spyTrend: spyTrend,
      spyAboveSma50: spyAboveSma50,
      avgVolRatio: parseFloat(avgVolRatio.toFixed(2)),
      sectorRank: sectorRank,
      timestamp: new Date().toISOString()
    };

    // Cache the result
    cachedData = result;
    cacheTimestamp = now;

    return res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching stock data:', error);
    return res.status(500).json({
      error: 'Failed to fetch stock data',
      message: error.message
    });
  }
}

async function fetchSnapshots(symbols) {
  const symbolsStr = symbols.join(',');
  const response = await fetch(
    `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${symbolsStr}&feed=iex`,
    {
      headers: {
        'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Snapshots API error: ${response.statusText}`);
  }

  const data = await response.json();
  const result = {};

  for (const symbol in data.snapshots) {
    const snap = data.snapshots[symbol];
    result[symbol] = {
      price: snap.latestTrade?.p || snap.prevClose || 0,
      priceChange: (snap.latestTrade?.p || snap.prevClose || 0) - snap.prevClose,
      priceChangePercent: snap.prevClose
        ? ((snap.latestTrade?.p || snap.prevClose) - snap.prevClose) / snap.prevClose * 100
        : 0,
      volume: snap.latestTrade?.s || 0,
      prevClose: snap.prevClose,
      high: snap.latestTrade?.p || snap.prevClose,
      low: snap.latestTrade?.p || snap.prevClose,
      bid: snap.latestQuote?.bp || 0,
      ask: snap.latestQuote?.ap || 0
    };
  }

  return result;
}

async function fetchDailyBars(symbols) {
  const symbolsStr = symbols.join(',');
  const response = await fetch(
    `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbolsStr}&timeframe=1Day&limit=81&feed=iex`,
    {
      headers: {
        'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Daily bars API error: ${response.statusText}`);
  }

  const data = await response.json();
  const result = {};

  for (const symbol in data.bars) {
    result[symbol] = data.bars[symbol].sort((a, b) => new Date(a.t) - new Date(b.t));
  }

  return result;
}

async function fetchIntradayBars(symbols) {
  const symbolsStr = symbols.join(',');
  const response = await fetch(
    `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbolsStr}&timeframe=5Min&limit=100&feed=iex`,
    {
      headers: {
        'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Intraday bars API error: ${response.statusText}`);
  }

  const data = await response.json();
  const result = {};

  for (const symbol in data.bars) {
    result[symbol] = data.bars[symbol].sort((a, b) => new Date(a.t) - new Date(b.t));
  }

  return result;
}

function computeIndicators(symbol, dailyBars, intradayBars, snapshot) {
  if (dailyBars.length === 0) return {};

  const closes = dailyBars.map(bar => bar.c);
  const highs = dailyBars.map(bar => bar.h);
  const lows = dailyBars.map(bar => bar.l);
  const volumes = dailyBars.map(bar => bar.v);

  const indicators = {};

  // SMA calculations
  indicators.sma20 = computeSMA(closes, 20);
  indicators.sma50 = computeSMA(closes, 50);
  indicators.sma200 = computeSMA(closes, 200);

  // EMA calculations
  indicators.ema12 = computeEMA(closes, 12);
  indicators.ema26 = computeEMA(closes, 26);

  // RSI 14 with proper Wilder smoothing
  indicators.rsi14 = computeRSI(closes, 14);

  // MACD with signal line
  const macdData = computeMACD(closes);
  indicators.macd = macdData.macd;
  indicators.macdSignal = macdData.signal;
  indicators.macdHistogram = macdData.histogram;

  // Bollinger Bands (20-period, 2 std dev)
  const bbData = computeBollingerBands(closes, 20, 2);
  indicators.bb20Upper = bbData.upper;
  indicators.bb20Lower = bbData.lower;
  indicators.bb20Width = bbData.width;
  indicators.bb20Position = bbData.position;

  // ATR (Average True Range)
  indicators.atr = computeATR(highs, lows, closes, 14);

  // Volume-weighted metrics
  indicators.vwap = computeVWAP(dailyBars);
  indicators.volumeRatio = computeVolumeRatio(volumes);

  // Rate of Change
  indicators.roc10 = computeROC(closes, 10);
  indicators.roc20 = computeROC(closes, 20);

  // ADX (Average Directional Index)
  indicators.adx = computeADX(highs, lows, closes, 14);

  // Stochastic RSI
  indicators.stochRsi = computeStochasticRSI(closes, 14, 14, 3, 3);

  // On-Balance Volume trend
  indicators.obvTrend = computeOBVTrend(closes, volumes);

  // 5-minute momentum (if intraday bars available)
  if (intradayBars.length > 0) {
    const intraCloses = intradayBars.map(bar => bar.c);
    indicators.intraday5minMomentum = computeIntradayMomentum(intraCloses);
    indicators.intraday5minRSI = computeRSI(intraCloses.slice(-14), 14);
  }

  return indicators;
}

function computeSMA(closes, period) {
  if (closes.length < period) return null;
  const sum = closes.slice(-period).reduce((a, b) => a + b, 0);
  return sum / period;
}

function computeEMA(closes, period) {
  if (closes.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * multiplier + ema;
  }

  return ema;
}

function computeRSI(closes, period) {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  // Calculate initial average gain and loss
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Wilder's smoothing for remaining closes
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const currentGain = diff > 0 ? diff : 0;
    const currentLoss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
  }

  const rs = avgGain / (avgLoss || 0.0001);
  return 100 - (100 / (1 + rs));
}

function computeMACD(closes) {
  const ema12 = computeEMA(closes, 12);
  const ema26 = computeEMA(closes, 26);
  const macd = (ema12 || 0) - (ema26 || 0);

  // Signal line is 9-period EMA of MACD
  // For simplicity, compute over last 26 closes
  let signal = null;
  if (closes.length >= 35) {
    const macdValues = [];
    for (let i = 26; i < closes.length; i++) {
      const e12 = computeEMA(closes.slice(0, i + 1), 12);
      const e26 = computeEMA(closes.slice(0, i + 1), 26);
      macdValues.push((e12 || 0) - (e26 || 0));
    }
    signal = computeEMA(macdValues, 9);
  }

  return {
    macd: macd,
    signal: signal || macd,
    histogram: macd - (signal || macd)
  };
}

function computeBollingerBands(closes, period, stdDevs) {
  if (closes.length < period) return { upper: null, lower: null, width: null, position: null };

  const sma = computeSMA(closes, period);
  const recentCloses = closes.slice(-period);
  const variance = recentCloses.reduce((sum, c) => sum + Math.pow(c - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = sma + stdDevs * stdDev;
  const lower = sma - stdDevs * stdDev;
  const width = upper - lower;
  const currentPrice = closes[closes.length - 1];
  const position = width > 0 ? (currentPrice - lower) / width : 0.5;

  return { upper, lower, width, position };
}

function computeATR(highs, lows, closes, period) {
  if (closes.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }

  // Wilder's smoothing for ATR
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
}

function computeVWAP(bars) {
  if (bars.length === 0) return null;

  let cumVolPrice = 0;
  let cumVol = 0;

  for (const bar of bars) {
    const typicalPrice = (bar.h + bar.l + bar.c) / 3;
    cumVolPrice += typicalPrice * bar.v;
    cumVol += bar.v;
  }

  return cumVol > 0 ? cumVolPrice / cumVol : null;
}

function computeVolumeRatio(volumes) {
  if (volumes.length < 20) return 1.0;

  const avgVolume20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const currentVolume = volumes[volumes.length - 1];

  return avgVolume20 > 0 ? currentVolume / avgVolume20 : 1.0;
}

function computeROC(closes, period) {
  if (closes.length <= period) return null;

  const currentClose = closes[closes.length - 1];
  const pastClose = closes[closes.length - 1 - period];

  return ((currentClose - pastClose) / pastClose) * 100;
}

function computeADX(highs, lows, closes, period) {
  if (closes.length < period + 1) return null;

  // Calculate Plus DM and Minus DM
  const plusDMs = [];
  const minusDMs = [];

  for (let i = 1; i < closes.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];

    let plusDM = 0;
    let minusDM = 0;

    if (upMove > downMove && upMove > 0) plusDM = upMove;
    if (downMove > upMove && downMove > 0) minusDM = downMove;

    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  // Calculate True Range for normalization
  const trueRanges = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }

  // Calculate DI+ and DI-
  let sumPlusDM = plusDMs.slice(-period).reduce((a, b) => a + b, 0);
  let sumMinusDM = minusDMs.slice(-period).reduce((a, b) => a + b, 0);
  let sumTR = trueRanges.slice(-period).reduce((a, b) => a + b, 0);

  const diPlus = (sumPlusDM / sumTR) * 100;
  const diMinus = (sumMinusDM / sumTR) * 100;

  // Calculate DX
  const dx = (Math.abs(diPlus - diMinus) / (diPlus + diMinus || 0.0001)) * 100;

  // ADX is EMA of DX (simplified to average for quick calculation)
  return dx;
}

function computeStochasticRSI(closes, rsiPeriod, stochPeriod, kPeriod, dPeriod) {
  if (closes.length < rsiPeriod + stochPeriod) return null;

  const rsiValues = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    const rsi = computeRSI(closes.slice(0, i + 1), rsiPeriod);
    rsiValues.push(rsi);
  }

  const recentRSIs = rsiValues.slice(-stochPeriod);
  const minRSI = Math.min(...recentRSIs);
  const maxRSI = Math.max(...recentRSIs);

  const stochRSI = maxRSI - minRSI !== 0
    ? ((rsiValues[rsiValues.length - 1] - minRSI) / (maxRSI - minRSI)) * 100
    : 50;

  return stochRSI;
}

function computeOBVTrend(closes, volumes) {
  if (closes.length < 14) return null;

  let obv = 0;
  const obvValues = [];

  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      obv = volumes[i];
    } else {
      if (closes[i] > closes[i - 1]) obv += volumes[i];
      else if (closes[i] < closes[i - 1]) obv -= volumes[i];
    }
    obvValues.push(obv);
  }

  const recentOBV = obvValues.slice(-14);
  const smaOBV = recentOBV.reduce((a, b) => a + b, 0) / 14;
  const currentOBV = obvValues[obvValues.length - 1];

  return currentOBV > smaOBV ? 'UP' : 'DOWN';
}

function computeIntradayMomentum(closes) {
  if (closes.length < 2) return 0;

  const currentPrice = closes[closes.length - 1];
  const openPrice = closes[0];
  const highPrice = Math.max(...closes);
  const lowPrice = Math.min(...closes);

  const momentum = ((currentPrice - openPrice) / openPrice) * 100;
  const range = highPrice - lowPrice;

  return {
    momentum: parseFloat(momentum.toFixed(2)),
    range: parseFloat(range.toFixed(2)),
    direction: momentum > 0 ? 'UP' : 'DOWN'
  };
}

function computeSpyTrend(spyDaily, spySnapshot) {
  if (spyDaily.length < 50) return 'NEUTRAL';

  const sma50 = computeSMA(spyDaily.map(b => b.c), 50);
  const currentPrice = spySnapshot.price;

  if (!sma50) return 'NEUTRAL';

  return currentPrice > sma50 ? 'UP' : 'DOWN';
}

function computeSpyAboveSma50(spyDaily, spySnapshot) {
  if (spyDaily.length < 50) return false;

  const sma50 = computeSMA(spyDaily.map(b => b.c), 50);
  const currentPrice = spySnapshot.price;

  return sma50 ? currentPrice > sma50 : false;
}

function computeSectorRanking(sectorDaily, sectorSnapshots, spyDaily) {
  const sectorRank = {};
  const sectorStrengths = {};

  // Calculate 50-day RSI for each sector
  for (const symbol in sectorDaily) {
    const bars = sectorDaily[symbol];
    if (bars.length >= 14) {
      const closes = bars.map(b => b.c);
      const rsi = computeRSI(closes, 14);
      const sma50 = computeSMA(closes, 50);
      const currentPrice = sectorSnapshots[symbol]?.price || 0;

      // Strength = RSI + position above SMA50 boost
      let strength = rsi || 50;
      if (sma50 && currentPrice > sma50) strength += 5;

      sectorStrengths[symbol] = strength;
    }
  }

  // Rank sectors by strength
  const sorted = Object.entries(sectorStrengths)
    .sort((a, b) => b[1] - a[1]);

  sorted.forEach((entry, index) => {
    sectorRank[entry[0]] = index + 1;
  });

  return sectorRank;
}

function computeVixProxy(vixSnapshots, vixBars, spyDaily) {
  // Try to use VIXY first
  if (vixSnapshots['VIXY']) {
    return parseFloat(vixSnapshots['VIXY'].price.toFixed(2));
  }

  // Fallback: compute implied volatility proxy from SPY ATR
  if (spyDaily.length >= 14) {
    const highs = spyDaily.map(b => b.h);
    const lows = spyDaily.map(b => b.l);
    const closes = spyDaily.map(b => b.c);

    const atr = computeATR(highs, lows, closes, 14);
    const currentClose = closes[closes.length - 1];

    if (atr && currentClose > 0) {
      // ATR-based VIX proxy (rough estimate)
      const vixProxy = (atr / currentClose) * 100 * 10; // Scaled to VIX range
      return parseFloat(Math.min(vixProxy, 100).toFixed(2));
    }
  }

  return 20; // Default VIX estimate
}

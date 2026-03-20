/* Vercel serverless function — fetches real stock data from Alpaca Markets.
   Uses snapshots for latest price + bars for historical price series + indicators. */

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const keyId = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!keyId || !secret) {
    return res.status(500).json({ error: "ALPACA_API_KEY / ALPACA_API_SECRET not configured" });
  }

  const symbols = (req.query.symbols || "").split(",").filter(Boolean);
  if (!symbols.length) {
    return res.status(400).json({ error: "Missing ?symbols=AAPL,MSFT,..." });
  }

  const headers = {
    "APCA-API-KEY-ID": keyId,
    "APCA-API-SECRET-KEY": secret,
  };

  const BASE = "https://data.alpaca.markets";

  try {
    const symParam = symbols.join(",");
    const [snapRes, barsRes] = await Promise.all([
      fetch(`${BASE}/v2/stocks/snapshots?symbols=${symParam}&feed=iex`, { headers }),
      fetch(`${BASE}/v2/stocks/bars?symbols=${symParam}&timeframe=1Day&limit=81&feed=iex`, { headers }),
    ]);

    if (!snapRes.ok) {
      const t = await snapRes.text();
      return res.status(snapRes.status).json({ error: `Alpaca snapshot error: ${snapRes.status}` });
    }
    if (!barsRes.ok) {
      const t = await barsRes.text();
      return res.status(barsRes.status).json({ error: `Alpaca bars error: ${barsRes.status}` });
    }

    const snapshots = await snapRes.json();
    const barsData = await barsRes.json();
    const barsBySymbol = barsData.bars || barsData;

    const result = {};

    for (const sym of symbols) {
      const snap = snapshots[sym];
      const bars = barsBySymbol[sym];

      if (!snap && !bars) { result[sym] = null; continue; }

      let prices = [];
      if (bars && bars.length > 0) { prices = bars.map(b => b.c); }

      const current = snap?.latestTrade?.p || snap?.minuteBar?.c || (prices.length ? prices[prices.length - 1] : 0);
      const prev = prices.length >= 2 ? prices[prices.length - 2] : current;
      const change = prev ? parseFloat(((current - prev) / prev * 100).toFixed(2)) : 0;

      let gains = 0, losses = 0;
      if (prices.length >= 15) {
        for (let i = 1; i <= 14; i++) {
          const d = prices[prices.length - i] - prices[prices.length - i - 1];
          if (d > 0) gains += d; else losses += Math.abs(d);
        }
      }
      const rsi = parseFloat((100 - 100 / (1 + (gains / 14) / (losses / 14 || 0.001))).toFixed(1));

      const ema12 = prices.length >= 12 ? prices.slice(-12).reduce((a, b) => a + b, 0) / 12 : current;
      const ema26 = prices.length >= 26 ? prices.slice(-26).reduce((a, b) => a + b, 0) / 26 : current;
      const macd = parseFloat((ema12 - ema26).toFixed(2));

      const sma20 = prices.length >= 20 ? parseFloat((prices.slice(-20).reduce((a, b) => a + b, 0) / 20).toFixed(2)) : current;
      const sma50 = prices.length >= 50 ? parseFloat((prices.slice(-50).reduce((a, b) => a + b, 0) / 50).toFixed(2)) : current;

      const sma20arr = prices.slice(-20);
      const stdDev = sma20arr.length >= 20 ? Math.sqrt(sma20arr.reduce((a, v) => a + Math.pow(v - sma20, 2), 0) / 20) : 1;
      const bbUpper = sma20 + 2 * stdDev;
      const bbLower = sma20 - 2 * stdDev;
      const bbPos = parseFloat(((current - bbLower) / (bbUpper - bbLower || 1) * 100).toFixed(0));

      const dailyVol = snap?.dailyBar?.v || 0;
      const prevVol = snap?.prevDailyBar?.v || 1;
      const volRatio = parseFloat((dailyVol / (prevVol || 1)).toFixed(2));

      let atrSum = 0;
      if (prices.length >= 15) {
        for (let i = 1; i <= 14; i++) atrSum += Math.abs(prices[prices.length - i] - prices[prices.length - i - 1]);
      }
      const atr = parseFloat((atrSum / 14).toFixed(2));
      const atrPct = parseFloat((atr / (current || 1) * 100).toFixed(2));

      const ret5d = prices.length >= 6 ? parseFloat(((current / prices[prices.length - 6] - 1) * 100).toFixed(2)) : 0;
      const ret20d = prices.length >= 21 ? parseFloat(((current / prices[prices.length - 21] - 1) * 100).toFixed(2)) : 0;

      result[sym] = { current: parseFloat(current.toFixed(2)), change, rsi, macd, sma20, sma50, bbPos, volRatio, atr, atrPct, ret5d, ret20d, prices };
    }

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json(result);
  } catch (err) {
    console.error("Stocks endpoint error:", err);
    return res.status(500).json({ error: err.message });
  }
}
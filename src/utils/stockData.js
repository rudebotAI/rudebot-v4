/* Stock data generation and technical analysis */

import { RULES } from "../config/rules";
import { MOMENTUM_STOCKS, DIVIDEND_STOCKS, SECTOR_ROTATION } from "../config/stocks";

export function getStrategy(stock) {
  if (MOMENTUM_STOCKS.find((s) => s.symbol === stock.symbol)) return "MOMENTUM";
  if (DIVIDEND_STOCKS.find((s) => s.symbol === stock.symbol)) return "DIVIDEND";
  if (SECTOR_ROTATION.find((s) => s.symbol === stock.symbol)) return "ROTATION";
  return "MEAN_REV";
}

export function generateStockData(stock) {
  const base = 50 + Math.random() * 400;
  const prices = [];
  let p = base;
  for (let i = 80; i >= 0; i--) {
    p = p * (1 + (Math.random() - 0.47) * 0.025);
    prices.push(parseFloat(p.toFixed(2)));
  }

  const current = prices[prices.length - 1];
  const prev = prices[prices.length - 2];
  const change = parseFloat(((current - prev) / prev * 100).toFixed(2));

  // RSI 14
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= 14; i++) {
    const d = prices[prices.length - i] - prices[prices.length - i - 1];
    if (d > 0) gains += d;
    else losses += Math.abs(d);
  }
  const rsi = parseFloat((100 - 100 / (1 + gains / 14 / (losses / 14 || 0.001))).toFixed(1));

  // MACD
  const ema12 = prices.slice(-12).reduce((a, b) => a + b, 0) / 12;
  const ema26 = prices.slice(-26).reduce((a, b) => a + b, 0) / 26;
  const macd = parseFloat((ema12 - ema26).toFixed(2));

  // SMAs
  const sma20 = parseFloat((prices.slice(-20).reduce((a, b) => a + b, 0) / 20).toFixed(2));
  const sma50 = parseFloat((prices.slice(-50).reduce((a, b) => a + b, 0) / 50).toFixed(2));

  // Bollinger position
  const sma20arr = prices.slice(-20);
  const stdDev = Math.sqrt(sma20arr.reduce((a, v) => a + Math.pow(v - sma20, 2), 0) / 20);
  const bbUpper = sma20 + 2 * stdDev;
  const bbLower = sma20 - 2 * stdDev;
  const bbPos = parseFloat(((current - bbLower) / (bbUpper - bbLower || 1) * 100).toFixed(0));

  // Volume ratio
  const volRatio = parseFloat((0.5 + Math.random() * 2).toFixed(2));

  // ATR
  let atrSum = 0;
  for (let i = 1; i <= 14; i++) atrSum += Math.abs(prices[prices.length - i] - prices[prices.length - i - 1]);
  const atr = parseFloat((atrSum / 14).toFixed(2));
  const atrPct = parseFloat((atr / current * 100).toFixed(2));

  // Returns
  const ret5d = parseFloat(((current / prices[prices.length - 6] - 1) * 100).toFixed(2));
  const ret20d = parseFloat(((current / prices[prices.length - 21] - 1) * 100).toFixed(2));

  // Composite score
  let score = 50;
  if (rsi < 32) score += 20;
  else if (rsi < 42) score += 12;
  else if (rsi < 50) score += 5;
  if (rsi > 75) score -= 18;
  else if (rsi > 68) score -= 8;
  if (macd > 0) score += 12;
  else score -= 5;
  if (current > sma20) score += 8;
  else score -= 5;
  if (sma20 > sma50) score += 8;
  else score -= 5;
  if (volRatio > 1.5) score += 8;
  else if (volRatio > 1.2) score += 4;
  if (bbPos < 20) score += 10;
  if (bbPos > 85) score -= 8;
  if (ret5d > 2 && ret5d < 8) score += 6;
  if (ret5d < -5) score -= 8;
  if (stock.growth > 20) score += 10;
  else if (stock.growth > 10) score += 5;
  if (stock.divYield > 3) score += 6;
  if (stock.pe && stock.pe < 15) score += 8;
  else if (stock.pe > 50) score -= 5;
  if (change > 1.5) score += 5;
  else if (change < -3) score -= 12;
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

  return {
    ...stock, current, change, rsi, macd, sma20, sma50, volRatio,
    score, buySignals, sellSignals, strategy, prices, bbPos, atr, atrPct, ret5d, ret20d,
  };
}

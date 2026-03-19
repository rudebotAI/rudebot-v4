/* âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
   STOCK UNIVERSE â 30 equities + 5 sector ETFs
   âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */

export const MOMENTUM_STOCKS = [
  { symbol: "NVDA", name: "NVIDIA", sector: "Semiconductors", pe: 35, beta: 1.8, growth: 120, mktCap: "3.4T" },
  { symbol: "META", name: "Meta Platforms", sector: "Tech", pe: 22, beta: 1.4, growth: 25, mktCap: "1.5T" },
  { symbol: "AMZN", name: "Amazon", sector: "Tech", pe: 40, beta: 1.3, growth: 18, mktCap: "2.1T" },
  { symbol: "MSFT", name: "Microsoft", sector: "Tech", pe: 32, beta: 1.1, growth: 16, mktCap: "3.1T" },
  { symbol: "GOOGL", name: "Alphabet", sector: "Tech", pe: 24, beta: 1.2, growth: 15, mktCap: "2.2T" },
  { symbol: "AAPL", name: "Apple", sector: "Tech", pe: 29, beta: 1.0, growth: 8, mktCap: "3.5T" },
  { symbol: "TSM", name: "TSMC", sector: "Semiconductors", pe: 20, beta: 1.3, growth: 30, mktCap: "900B" },
  { symbol: "AVGO", name: "Broadcom", sector: "Semiconductors", pe: 28, beta: 1.2, growth: 22, mktCap: "800B" },
  { symbol: "PLTR", name: "Palantir", sector: "Tech", pe: 60, beta: 2.1, growth: 35, mktCap: "220B" },
  { symbol: "CRM", name: "Salesforce", sector: "Tech", pe: 26, beta: 1.3, growth: 12, mktCap: "280B" },
];

export const DIVIDEND_STOCKS = [
  { symbol: "JPM", name: "JPMorgan", sector: "Financials", divYield: 2.5, divGrowth: 8, pe: 12, mktCap: "680B" },
  { symbol: "JNJ", name: "Johnson & Johnson", sector: "Healthcare", divYield: 3.0, divGrowth: 6, pe: 15, mktCap: "390B" },
  { symbol: "KO", name: "Coca-Cola", sector: "Consumer", divYield: 3.1, divGrowth: 4, pe: 22, mktCap: "310B" },
  { symbol: "XOM", name: "ExxonMobil", sector: "Energy", divYield: 3.5, divGrowth: 3, pe: 14, mktCap: "520B" },
  { symbol: "PG", name: "Procter & Gamble", sector: "Consumer", divYield: 2.4, divGrowth: 5, pe: 24, mktCap: "400B" },
  { symbol: "ABBV", name: "AbbVie", sector: "Healthcare", divYield: 3.8, divGrowth: 7, pe: 13, mktCap: "310B" },
  { symbol: "HD", name: "Home Depot", sector: "Retail", divYield: 2.5, divGrowth: 10, pe: 22, mktCap: "380B" },
  { symbol: "UNH", name: "UnitedHealth", sector: "Healthcare", divYield: 1.5, divGrowth: 14, pe: 18, mktCap: "520B" },
];

export const MEAN_REVERSION = [
  { symbol: "PYPL", name: "PayPal", sector: "Fintech", pe: 14, beta: 1.5, mktCap: "85B" },
  { symbol: "INTC", name: "Intel", sector: "Semiconductors", pe: 12, beta: 1.2, mktCap: "110B" },
  { symbol: "PFE", name: "Pfizer", sector: "Healthcare", pe: 11, beta: 0.7, mktCap: "160B" },
  { symbol: "BA", name: "Boeing", sector: "Industrials", pe: 25, beta: 1.4, mktCap: "130B" },
  { symbol: "DIS", name: "Disney", sector: "Media", pe: 20, beta: 1.1, mktCap: "200B" },
  { symbol: "NKE", name: "Nike", sector: "Consumer", pe: 22, beta: 1.0, mktCap: "115B" },
  { symbol: "SBUX", name: "Starbucks", sector: "Consumer", pe: 24, beta: 0.9, mktCap: "105B" },
];

export const SECTOR_ROTATION = [
  { symbol: "XLF", name: "Financials Select", sector: "Financials", pe: 14, beta: 1.1, isETF: true, mktCap: "45B" },
  { symbol: "XLE", name: "Energy Select", sector: "Energy", pe: 12, beta: 1.3, isETF: true, mktCap: "38B" },
  { symbol: "XLK", name: "Technology Select", sector: "Tech", pe: 28, beta: 1.2, isETF: true, mktCap: "65B" },
  { symbol: "XLV", name: "Healthcare Select", sector: "Healthcare", pe: 17, beta: 0.8, isETF: true, mktCap: "42B" },
  { symbol: "XLI", name: "Industrials Select", sector: "Industrials", pe: 20, beta: 1.1, isETF: true, mktCap: "18B" },
];

export const ALL_STOCKS = [...MOMENTUM_STOCKS, ...DIVIDEND_STOCKS, ...MEAN_REVERSION, ...SECTOR_ROTATION];

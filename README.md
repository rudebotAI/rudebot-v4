# RudeBot v4 â Stock Trading Engine

Multi-strategy stock trading bot with 30 equities + 5 sector ETFs.
Strategies: Momentum, Dividend, Mean Reversion, Sector Rotation.

## Deploy to Vercel

### Option A: CLI
```bash
cd rudebot-v4
npm install
npx vercel
```

### Option B: GitHub
1. Push to a GitHub repo
2. Go to vercel.com > New Project > Import repo
3. Add environment variable: `ANTHROPIC_API_KEY` = your key
4. Deploy

### Environment Variables (required for AI Intel tab)
In Vercel dashboard: Settings > Environment Variables

| Variable | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

## Local Development
```bash
npm install
npm start
```
Opens at http://localhost:3000

Note: AI Intel won't work locally unless you run `vercel dev` (which loads the serverless function).

## Project Structure
```
src/
  App.js                    Main app component
  config/
    rules.js                Trading engine rules
    stocks.js               Stock universe (30 + 5 ETFs)
    theme.js                Color palette
  components/
    Charts.js               Spark + Equity Curve SVG charts
  utils/
    format.js               Number formatting
    stockData.js             Technical analysis + scoring
api/
  analyze.js                Vercel serverless function (Anthropic proxy)
```

# 📊 Portfolio Tracking Feature

## Overview

The bot now integrates with Limitless Exchange API to fetch complete portfolio data, including realized/unrealized P&L, position history, and points tracking.

## What's Tracked

### Portfolio Snapshot (`data/portfolio-snapshot.json`)

Updated every 5 minutes with:

```json
{
  "0x967ee892abEbD0953b1C50EFA25b9b17df96d867": {
    "timestamp": "2025-10-14T23:30:00.000Z",
    "wallet": "0x967ee892abEbD0953b1C50EFA25b9b17df96d867",
    "points": "1833.568",
    "accumulativePoints": "1833.568",
    "summary": {
      "totalPositions": 125,
      "openPositions": 5,
      "closedPositions": 120,
      "totalRealizedPnl": "45.234567",
      "totalUnrealizedPnl": "2.150000",
      "totalNetPnl": "47.384567"
    },
    "positions": [...]
  }
}
```

### Position Data

Each position includes:
- **Market details**: ID, title, slug, deadline, closed status
- **Position info**: outcome index, token amounts, collateral
- **P&L metrics**:
  - `realizedPnl`: Profit/loss from completed trades
  - `unrealizedPnl`: Current P&L for open positions
  - `averageFillPrice`: Your average entry price
  - `totalBuysCost`: Total spent buying
  - `totalSellsCost`: Total received from selling
  - `latestTradePrice`: Current market price

## Key Features

### 1. Accurate P&L Tracking
- Uses Limitless's official calculation
- Includes ALL positions (not just from this bot)
- Tracks realized gains/losses from closed positions
- Shows unrealized P&L on open positions

### 2. Points Tracking
- Total points earned
- Accumulative points over time
- Useful for rewards/leaderboards

### 3. Position History
- Every trade you've ever made
- Complete market information
- Entry/exit prices and amounts

## How It Works

1. **Every 5 minutes**, bot calls:
   ```
   GET https://api.limitless.exchange/portfolio/{wallet}/positions
   ```

2. **Calculates totals**:
   - Sums realized P&L from all closed positions
   - Sums unrealized P&L from open positions
   - Counts open vs closed positions

3. **Saves snapshot** to `data/portfolio-snapshot.json`

4. **Uploads to S3** (if enabled) for dashboard access

## Benefits

### No Logic Changes
- Buy/sell logic remains untouched
- This is pure logging/tracking
- Zero impact on trading performance

### Comprehensive Data
- Includes positions from manual trades
- Includes positions from other bots
- Historical data from before this bot started

### Dashboard Integration
- Portfolio data uploaded to S3
- Dashboard can show:
  - Total portfolio value
  - Realized vs unrealized P&L
  - Position details with current prices
  - Points earned
  - Historical performance

## Console Output

When running, you'll see:

```
📊 [PORTFOLIO] Fetching portfolio snapshots...
✅ [PORTFOLIO] 0x967e...d867: 125 positions, Net P&L: $47.38
💾 [PORTFOLIO] Snapshot saved to data/portfolio-snapshot.json
```

Every 5 minutes.

## Example Use Cases

### 1. Accurate P&L Reporting
```javascript
// Read portfolio snapshot
const portfolio = JSON.parse(fs.readFileSync('data/portfolio-snapshot.json'));
const wallet = portfolio['0x967ee892abEbD0953b1C50EFA25b9b17df96d867'];

console.log(`Total P&L: $${wallet.summary.totalNetPnl}`);
console.log(`Realized: $${wallet.summary.totalRealizedPnl}`);
console.log(`Unrealized: $${wallet.summary.totalUnrealizedPnl}`);
console.log(`Win Rate: ${(wallet.summary.closedPositions / wallet.summary.totalPositions * 100).toFixed(2)}%`);
```

### 2. Position Analysis
```javascript
// Find your biggest winner
const positions = wallet.positions.sort((a, b) =>
  parseFloat(b.realizedPnl) - parseFloat(a.realizedPnl)
);
const biggestWin = positions[0];

console.log(`Best trade: ${biggestWin.market.title}`);
console.log(`Profit: $${biggestWin.realizedPnl}`);
```

### 3. Open Position Monitoring
```javascript
// Check open positions
const open = wallet.positions.filter(p =>
  parseFloat(p.outcomeTokenAmount) > 0 || parseFloat(p.collateralAmount) > 0
);

console.log(`\n📊 Open Positions (${open.length}):`);
open.forEach(pos => {
  console.log(`- ${pos.market.title}`);
  console.log(`  Unrealized P&L: $${pos.unrealizedPnl}`);
  console.log(`  Deadline: ${pos.market.deadline}`);
});
```

## Files Created

- `data/portfolio-snapshot.json` - Latest portfolio state (local)
- `portfolio-snapshot.json` - Uploaded to S3 (if enabled)

## Dashboard Updates

The dashboard can now show:
- **Portfolio Overview**: Total P&L across all positions
- **Open Positions Table**: Current holdings with unrealized P&L
- **Closed Positions**: Historical trades with realized P&L
- **Points Earned**: Loyalty/reward points
- **Performance Charts**: P&L over time

## Troubleshooting

### "Failed to fetch portfolio"
- Check internet connection
- Verify wallet address is correct
- API may be temporarily down

### Data looks wrong
- This includes ALL positions from the wallet
- Not just trades from this bot
- Includes manual trades on Limitless website
- Includes positions from before bot started

### Performance impact
- Fetches once per 5 minutes per wallet
- Very lightweight API call
- No impact on trading speed
- Can be disabled by commenting out in code

## Future Enhancements

Possible additions:
- Historical snapshots (time series)
- P&L charts over time
- Position performance analysis
- Strategy comparison
- Tax reporting exports

---

**Note**: This feature uses publicly available API endpoints and doesn't require authentication. It only reads data, never modifies positions or executes trades.

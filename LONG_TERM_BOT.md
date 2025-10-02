# 📊 Long-Term Crypto Markets Bot

Automated trading bot for **daily and weekly** crypto prediction markets on Limitless Exchange using a hybrid time+price exit strategy.

## 🎯 Strategy Overview

This bot uses **Option 2: Hybrid Time + Price** approach, which adapts its risk management based on how much time is left in the market.

### Three-Phase System

#### **Daily Markets** (24 hours)
- **Early Phase (0-18 hours)**
  - 8% trailing stop from peak
  - No hard stop loss
  - Let winners run with patience

- **Mid Phase (18-22 hours)**
  - 5% trailing stop (tightening)
  - Still no hard stop loss
  - Preparing for final exit

- **Final Phase (22-24 hours)**
  - 3% trailing stop (tight)
  - Hard stop loss ACTIVE (-10%)
  - Protect capital as deadline approaches

#### **Weekly Markets** (7 days)
- **Early Phase (0-5.5 days)**
  - 10% trailing stop from peak
  - No hard stop loss
  - Maximum patience for long-term trends

- **Mid Phase (5.5-6.5 days)**
  - 7% trailing stop (tightening)
  - Still no hard stop loss
  - Beginning to lock in gains

- **Final Phase (6.5-7 days / last 12 hours)**
  - 5% trailing stop (tight)
  - Hard stop loss ACTIVE (-10%)
  - Ensure profitable exit before resolution

## 🌟 Key Features

- **API-Based Market Discovery** - Fetches from `/markets/active/2` (Crypto category)
- **Tag Filtering** - Only trades markets tagged "Daily" or "Weekly"
- **Phase-Aware Exits** - Different trailing stops based on time remaining
- **Peak PnL Tracking** - Protects profits once target hit
- **No Early Stop Loss** - Lets positions recover from temporary dips
- **Auto-Tightening** - Gradually reduces risk as deadline approaches

## 🚀 Quick Start

### 1. Configure

Add to your `.env`:

```bash
# Long-term bot settings
LONG_TERM_FREQUENCY=daily          # or 'weekly'
LONG_TERM_BUY_AMOUNT_USDC=10
LONG_TERM_TARGET_PROFIT_PCT=15
LONG_TERM_STOP_LOSS_PCT=-10
LONG_TERM_POLL_INTERVAL_MS=60000   # 1 minute polling
```

### 2. Run

```bash
node src/long-term-bot.js
```

## 📋 How It Works

### Market Selection
- Fetches active crypto markets from API
- Filters by frequency tag (Daily or Weekly)
- Only considers FUNDED, non-expired markets

### Entry (Manual for now)
- Bot focuses on managing existing positions
- Add your own entry logic based on your strategy

### Exit Logic

**Example: Daily Market**

1. **Hour 5** - Position at 12% profit
   - Starts trailing stop at 12% - 8% = 4%
   - Won't sell unless drops to 4%

2. **Hour 10** - Position reaches 18% profit
   - New trailing stop: 18% - 8% = 10%
   - Locked in minimum 10% profit

3. **Hour 19** - Enter mid phase at 16%
   - Trailing tightens to 5%
   - New stop: 16% - 5% = 11%

4. **Hour 22** - Final phase at 14%
   - Trailing tightens to 3%
   - Stop: 14% - 3% = 11%
   - Hard stop loss now active at -10%

5. **Hour 23** - Price drops to 11.5%
   - Still above 11% stop, holding

6. **Hour 23:30** - Price drops to 10.5%
   - Hits 3% trailing stop → **SELLS**

## 🎮 Configuration Options

### Position Sizing
```bash
LONG_TERM_BUY_AMOUNT_USDC=10      # Bet size per market
```

### Profit Targets
```bash
LONG_TERM_TARGET_PROFIT_PCT=15     # Start trailing at 15%
LONG_TERM_STOP_LOSS_PCT=-10        # Hard stop in final phase
```

### Frequency
```bash
LONG_TERM_FREQUENCY=daily          # or 'weekly'
```

### Custom Phase Timing

Edit `src/long-term-bot.js` to adjust phase durations:

```javascript
daily: {
  earlyPhaseHours: 18,     // Customize early phase duration
  midPhaseHours: 4,        // Customize mid phase duration
  finalPhaseHours: 2,      // Customize final phase duration
  earlyTrailingPct: 8,     // Customize trailing stops
  midTrailingPct: 5,
  finalTrailingPct: 3
}
```

## 📊 Example Output

```
🚀 Starting Long-Term Crypto Bot
📅 Frequency: DAILY
💰 Position size: $10
📈 Target: 15% | Stop loss: -10% (final phase only)
🎯 Trailing stops: Early 8% → Mid 5% → Final 3%

🔄 [2025-10-02T12:00:00.000Z] Checking daily crypto markets...

📡 Found 5 active daily crypto markets

📈 0x1234...5678: BTC $100k by Dec? | Phase: early | PnL: 12.3% | Peak: 14.5% | Hours left: 18.2
⏳ Holding - early phase

📈 0x1234...5678: BTC $100k by Dec? | Phase: mid | PnL: 13.1% | Peak: 14.5% | Hours left: 3.5
⏳ Holding - mid phase

📉 0x1234...5678: BTC $100k by Dec? | Phase: final | PnL: 11.2% | Peak: 14.5% | Hours left: 1.2
🚪 Selling: TRAILING_STOP (Peak: 14.5%, Drop: 3%)
🧾 Sell tx: 0xabc123...
✅ SOLD at 11.2% | P&L: $1.12
```

## ⚖️ Daily vs Weekly Comparison

| Feature | Daily | Weekly |
|---------|-------|--------|
| **Total Duration** | 24 hours | 7 days |
| **Early Phase** | 18 hours | 5.5 days |
| **Early Trailing** | 8% | 10% |
| **Mid Phase** | 4 hours | 1 day |
| **Mid Trailing** | 5% | 7% |
| **Final Phase** | 2 hours | 12 hours |
| **Final Trailing** | 3% | 5% |
| **Poll Interval** | 1 min | 1 min |
| **Recommended Size** | $10 | $20 |

## 🔧 Troubleshooting

### No markets found
- Check API is accessible
- Verify crypto markets exist for your frequency
- Check tags match ("Daily" or "Weekly")

### Position not exiting
- Check phase detection (logs show current phase)
- Verify trailing stop hasn't been hit
- Ensure market hasn't expired

### API rate limiting
- Increase `LONG_TERM_POLL_INTERVAL_MS` to 120000 (2 min)
- Bot already polls less frequently than hourly bot

## 💡 Strategy Tips

### For Daily Markets
- More volatile than hourly
- 8% early trailing gives room to breathe
- Final 2 hours are critical for exit

### For Weekly Markets
- Long-term trends are smoother
- 10% early trailing allows for multi-day swings
- Last 12 hours ensure clean exit

### Best Practices
- Start with daily markets (easier to learn)
- Monitor first few days manually
- Adjust profit targets based on crypto volatility
- Consider wider trailing stops for high-volatility assets

## ⚠️ Limitations

1. **Manual Entry** - Bot manages exits only (add entry logic yourself)
2. **Single Category** - Only crypto markets (category ID 2)
3. **No Group Markets** - Works on single markets only currently
4. **Time-Based** - Assumes markets run full duration

## 📈 Performance Optimization

### Increase Win Rate
- Raise `LONG_TERM_TARGET_PROFIT_PCT` to 20%+ (fewer exits, bigger wins)
- Widen early trailing stops to 10-12%

### Reduce Losses
- Tighten `LONG_TERM_STOP_LOSS_PCT` to -8%
- Enable hard stop loss in mid phase (edit code)

### Handle Volatility
- Use wider trailing stops across all phases
- Consider entering positions in mid phase only

## 🤝 Contributing

This is a starting point! Customize for your needs:
- Add entry signal logic
- Support group markets (e.g., Solana price ranges)
- Add sentiment analysis integration
- Implement Kelly criterion position sizing

---

**Disclaimer:** Educational purposes only. Test thoroughly before live trading. Past performance does not guarantee future results.

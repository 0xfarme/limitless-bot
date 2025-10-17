# 🎭 Simulation Mode Guide

## Overview

The bot includes a **built-in simulation mode** that lets you test strategies **without spending real money**. Perfect for:
- Testing new strategies
- Learning how the bot works
- Verifying configurations
- Backtesting with live market data

## ✅ How It Works

### What Gets Simulated

When simulation mode is enabled:

1. **✅ Buys are simulated** - No real USDC spent, no blockchain transactions
2. **✅ Sells are simulated** - Profit taking and stop loss tracked without real txs
3. **✅ Positions are tracked** - Bot records simulated holdings with entry prices
4. **✅ PnL is calculated** - Uses real-time market prices to calculate profits/losses
5. **✅ Separate logs** - All data saved to `simulation/` directory
6. **✅ Real market data** - Fetches actual live markets and prices
7. **✅ All strategies work** - Early contrarian, moonshot, late window all function
8. **✅ Complete trade cycle** - Buy → Hold → Sell (profit/loss) all simulated

### What's Different

- **No blockchain transactions** - approvals, buys not executed
- **No gas costs** - simulation is free
- **Simulated tx hashes** - Format: `0xsim[timestamp][random]`
- **Separate files** - Logs saved to `simulation/` not `data/`
- **[SIM] prefix** - All log messages tagged with `[SIM]`

## 🚀 Quick Start

### Enable Simulation Mode

Edit your `.env` file:

```bash
# Enable simulation for ALL strategies
SIMULATION_MODE=true
```

That's it! Run the bot:

```bash
node src/index.js
```

### Verify It's Working

Look for these indicators:

```
[SIM] [0x1234...] 🔄 Polling market data...
[SIM] [0x1234...] 🎭 [SIMULATED DEFAULT BUY] Skipping real transaction
[SIM] [0x1234...] ✅ [SIMULATED] Buy completed - simulated tx: 0xsim...
[SIM] [0x1234...] 🎭 [SIMULATED DEFAULT SELL] Skipping real transaction - recording simulated profit sell
[SIM] [0x1234...] ✅ [SIMULATED] 100% sell completed. PnL: 🔺5.2500 USDC (21.00%)
```

## 📁 Simulation Files

All simulation data is stored in separate files:

```
simulation/
├── sim-state.json          # Simulated positions
├── sim-trades.jsonl        # Trade history (JSONL format)
├── sim-stats.json          # Performance statistics
└── sim-redemptions.jsonl   # Market resolutions
```

Your real trading data stays in `data/` untouched.

## 🎯 Use Cases

### 1. Test New Strategies

```bash
# Test aggressive moonshot settings
SIMULATION_MODE=true
MOONSHOT_AMOUNT_USDC=10
MOONSHOT_MAX_ODDS=15
```

Run for a few hours and check `simulation/sim-stats.json` for results.

### 2. Verify Stop Loss Settings

```bash
# Test if stop loss triggers appropriately
SIMULATION_MODE=true
STOP_LOSS_PNL_PCT=-30
```

Watch logs for `🚨 Stop loss!` messages.

### 3. Compare Strategy Performance

Run simulation with different configs, compare stats:

```bash
# Config A: Conservative
EARLY_TRIGGER_ODDS=80
TARGET_PROFIT_PCT=15

# Config B: Aggressive
EARLY_TRIGGER_ODDS=65
TARGET_PROFIT_PCT=30
```

### 4. Learn How the Bot Works

Enable simulation and watch the logs to understand:
- When markets trigger buys
- How PnL is calculated
- When profit targets are hit
- How stop loss activates

## 📊 Analyzing Simulation Results

### Check Stats

```bash
cat simulation/sim-stats.json
```

Example output:
```json
{
  "totalTrades": 15,
  "wins": 9,
  "losses": 6,
  "totalPnL": 12.45,
  "winRate": 60.0,
  "avgPnL": 0.83
}
```

### View Trade History

```bash
cat simulation/sim-trades.jsonl | jq
```

Each line is a trade with full details:
- Entry/exit prices
- PnL
- Strategy used
- Market information

### Check Current Positions

```bash
cat simulation/sim-state.json | jq '.wallets[].holdings'
```

Shows all active simulated positions with:
- Market address
- Entry price
- Cost
- Strategy
- Timestamp

## ⚙️ Advanced: Per-Strategy Simulation

You can simulate specific strategies while running others live:

```bash
# Simulate early contrarian, run late window live
SIMULATION_MODE=false
SIMULATE_STRATEGIES=early
```

Options:
- `SIMULATE_STRATEGIES=early` - Only simulate early contrarian
- `SIMULATE_STRATEGIES=late` - Only simulate late window
- `SIMULATE_STRATEGIES=moonshot` - Only simulate moonshot
- `SIMULATE_STRATEGIES=early,moonshot` - Simulate multiple
- `SIMULATE_STRATEGIES=all` - Same as `SIMULATION_MODE=true`

⚠️ **Warning:** Mixing simulated and live strategies is advanced. Make sure you understand which strategies are live before running.

## 🔄 Switching Between Modes

### Simulation → Live

1. Backup simulation results:
```bash
cp -r simulation simulation-backup-$(date +%Y%m%d)
```

2. Update .env:
```bash
SIMULATION_MODE=false
```

3. Verify settings (amounts, stop loss, etc.)
4. Start bot - it will trade live!

### Live → Simulation

```bash
# Just flip the switch
SIMULATION_MODE=true
```

Your live data in `data/` is preserved.

## 📝 Example Session

**Start simulation:**
```bash
# .env
SIMULATION_MODE=true
BUY_AMOUNT_USDC=25
EARLY_STRATEGY_ENABLED=true
MOONSHOT_ENABLED=true
```

**Run bot:**
```bash
node src/index.js
```

**Watch logs:**
```
2025-10-17T12:00:00.000Z 🔄 [SIM] [0x1234...] Polling market data...
2025-10-17T12:00:01.234Z 📰 [SIM] [0x1234...] Market: ETH above $4000?
2025-10-17T12:00:01.456Z 🎭 [SIM] [0x1234...] [SIMULATED DEFAULT BUY] Skipping real transaction
2025-10-17T12:00:01.567Z ✅ [SIM] [0x1234...] [SIMULATED] Buy completed
```

**Check results after 1 hour:**
```bash
cat simulation/sim-stats.json
{
  "totalTrades": 4,
  "wins": 2,
  "losses": 2,
  "totalPnL": 1.25,
  "winRate": 50.0,
  "avgPnL": 0.31
}
```

## ⚠️ Important Notes

### Simulation Limitations

1. **No slippage simulation** - Assumes you get exact prices
2. **No gas costs** - Real trading has gas fees (~$0.10-0.50 per tx)
3. **No failed transactions** - Simulation always succeeds
4. **No approval delays** - Real first trades need approvals (extra tx)
5. **No network issues** - Simulation doesn't experience RPC failures
6. **Simplified sell prices** - Uses current market value minus 1% safety margin
7. **No redemptions** - Simulated positions close at profit target, not via blockchain redemption

### Real trading differences:
- Expect slightly worse prices due to slippage
- Factor in gas costs (~$0.10-0.50 per transaction)
- First trade per market needs approval (extra transaction)
- Network issues can cause missed opportunities

## 🎓 Best Practices

### 1. Always Simulate First

Before running live with new settings:
```bash
SIMULATION_MODE=true  # Test first
```

Run for at least a few market cycles (several hours).

### 2. Compare with Small Live Test

After simulation looks good:
```bash
SIMULATION_MODE=false
BUY_AMOUNT_USDC=1  # Start tiny
```

Run live with minimal amount to verify behavior.

### 3. Gradually Increase

Once confident:
```bash
BUY_AMOUNT_USDC=5   # Slowly increase
BUY_AMOUNT_USDC=10
BUY_AMOUNT_USDC=25  # Full amount
```

### 4. Keep Simulation Data

Archive successful simulation runs:
```bash
mkdir -p simulations/archive
cp -r simulation simulations/archive/test-$(date +%Y%m%d-%H%M)
```

Useful for comparing different configurations.

## 🔍 Troubleshooting

**Simulation not starting?**
- Check `SIMULATION_MODE=true` in .env
- Verify .env file exists and is loaded
- Look for `[SIM]` prefix in logs

**No trades happening?**
- Simulation still needs markets to match strategy criteria
- Check market odds, timing windows, etc.
- Not all markets will trigger buys

**Stats showing zero?**
- Simulation needs time to complete trades
- Markets must reach deadlines for PnL calculation
- Wait at least one full market cycle (1 hour for hourly markets)

**Want to reset simulation?**
```bash
rm -rf simulation/
```

Bot will create fresh simulation files.

## 📈 Next Steps

1. **Run a test simulation** - Enable SIMULATION_MODE=true
2. **Monitor for a few hours** - Let it complete some trades
3. **Analyze results** - Check sim-stats.json
4. **Adjust settings** - Tune based on simulation performance
5. **Go live carefully** - Start with small amounts

---

**Remember:** Simulation is a learning tool. Real trading involves additional risks, costs, and market dynamics. Always start small when going live!

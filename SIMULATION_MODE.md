# 🎮 Simulation Mode Guide

## What is Simulation Mode?

Simulation mode lets you test the trading bot with **real market data** from the Limitless API without executing any actual blockchain transactions. It simulates all trading logic, tracks virtual balances, and logs everything just like live trading.

## How to Enable

Add to your `.env` file:

```bash
# Enable simulation mode
SIMULATION_MODE=true

# Set virtual starting balance (optional, default: 100 USDC)
SIMULATION_BALANCE_USDC=100
```

## What Happens in Simulation Mode

### ✅ Real Data
- Fetches **real market prices** from Limitless API
- Uses **actual market deadlines** and timing
- Applies **real strategy logic** (dominant/opposite/hybrid)
- Calculates **realistic PnL** based on price changes

### 🎮 Simulated Actions
- **No blockchain transactions** - completely safe
- Virtual balance tracking (starts at SIMULATION_BALANCE_USDC)
- Simulated gas costs (~0.0002 ETH per trade)
- No wallet/private keys needed

### 📊 Full Logging
- All trades logged to CSV with exit reasons
- Console shows `[SIM]` prefix for simulated actions
- Track balance changes in real-time
- Summary report on exit (Ctrl+C)

## Running a Simulation

```bash
# 1. Set simulation mode in .env
SIMULATION_MODE=true
SIMULATION_BALANCE_USDC=1000

# 2. Configure your strategy to test
STRATEGY_MODE=hybrid
ENABLE_TRAILING_PROFIT=true
ENABLE_PARTIAL_EXITS=true
TARGET_PROFIT_PCT=10
STOP_LOSS_PCT=-6

# 3. Run the bot
npm start

# 4. Watch it trade (no real money at risk!)
# 5. Press Ctrl+C to see summary
```

## Simulation Output Example

```
🚀 Starting Multi-Market Limitless Bot
🎮 SIMULATION MODE - NO REAL TRADES
💵 Starting balance: 100 USDC (virtual)
📊 Strategy: HYBRID
...

🎮 [0xSimul...] [SIM] BUY outcome 1 for $2 | Balance: 100.00 USDC
✅ [0xSimul...] [SIM] BUY completed | New balance: 98.00 USDC

📈 [0xSimul...] Value: 2.15 | PnL: 7.5% | Peak: 7.5% | Target: 10.0% | Stop: -4.0% | Time: 25.3m (mid)

🎮 [0xSimul...] [SIM] SELL at 7.5% | Proceeds: $2.15 | New balance: 100.15 USDC
✅ [0xSimul...] [SIM] SOLD | Reason: TRAILING_STOP
```

## Simulation Summary (on exit)

When you press Ctrl+C, you'll see:

```
============================================================
🎮 SIMULATION SUMMARY
============================================================

💼 Wallet: 0xSimulationabc123
   Start: 100.00 USDC
   End:   105.50 USDC
   PnL:   +5.50 USDC (+5.50%)

📊 Trade Stats:
   Total trades: 12
   Wins: 8 | Losses: 4
   Win rate: 66.7%

🚪 Exit Reasons:
   PROFIT_TARGET: 5
   TRAILING_STOP: 3
   STOP_LOSS: 2
   PARTIAL_EXIT: 2

============================================================
```

## Use Cases

### 1. Test New Strategies
```bash
# Try different strategy modes
STRATEGY_MODE=hybrid
STRATEGY_MODE=dominant
STRATEGY_MODE=opposite
```

### 2. Optimize Parameters
```bash
# Test different profit targets
TARGET_PROFIT_PCT=8
TARGET_PROFIT_PCT=12
TARGET_PROFIT_PCT=15
```

### 3. Validate Risk Management
```bash
# Test trailing stops
TRAILING_DISTANCE_PCT=3
TRAILING_DISTANCE_PCT=5
TRAILING_DISTANCE_PCT=7
```

### 4. Monitor Real Markets
```bash
# Watch markets without trading
# Learn patterns and timing
# Build confidence before going live
```

## Logs Generated

All logs are still created:
- `data/trades.log` - Human readable trade log with [SIM] markers
- `data/trades.csv` - Full trade data with exit reasons
- `data/summary.json` - Win rate and statistics
- `data/analytics.json` - Detailed analytics
- `data/state.json` - Position state (virtual)

## Tips for Simulation

1. **Run for at least 1 hour** to see multiple market cycles
2. **Test different market conditions** (check hourly markets at different times)
3. **Compare strategies** by running simulations back-to-back
4. **Check exit reasons** to see if stop losses are too tight
5. **Validate position limits** work correctly

## Switching to Live Trading

Once satisfied with simulation results:

```bash
# 1. Disable simulation mode
SIMULATION_MODE=false

# 2. Add real wallet private keys
PRIVATE_KEYS=your_private_key_here

# 3. Verify RPC and network settings
RPC_URL=your_rpc_url
CHAIN_ID=8453

# 4. Start with small position sizes
BUY_AMOUNT_USDC=1

# 5. Run live!
npm start
```

## Important Notes

⚠️ **Simulation is approximate** - Real blockchain execution may differ due to:
- Actual slippage
- Gas price fluctuations
- Market depth
- MEV/frontrunning

✅ **But simulation is excellent for**:
- Strategy validation
- Risk management testing
- Parameter optimization
- Learning bot behavior
- Building confidence

---

Happy simulating! 🎮

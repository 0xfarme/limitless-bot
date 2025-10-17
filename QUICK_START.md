# ⚡ Quick Start Guide

## 🎯 Get Running in 3 Minutes

### Step 1: Configure (1 min)

```bash
# Copy example config
cp .env.example .env

# Edit with your settings
nano .env  # or use your editor
```

**Minimum required settings:**
```env
# Your wallet private key
PRIVATE_KEYS=your_private_key_here

# RPC endpoint
RPC_URL=https://rpc.ankr.com/base

# Markets to trade
PRICE_ORACLE_ID=58,59,60,61

# Enable simulation (TEST MODE)
SIMULATION_MODE=true
```

### Step 2: Run (30 seconds)

```bash
node src/index.js
```

Look for this:
```
[SIM] 🔄 Polling market data...
[SIM] 📰 Market: ETH above $4000?
[SIM] 🎭 [SIMULATED DEFAULT BUY] Skipping real transaction
```

### Step 3: Check Results (30 seconds)

After a few hours:
```bash
cat simulation/sim-stats.json
```

---

## 🔥 Common Configurations

### Safe Testing (Recommended First)
```env
SIMULATION_MODE=true
BUY_AMOUNT_USDC=25
STOP_LOSS_PNL_PCT=-50
TARGET_PROFIT_PCT=20
```

### Go Live (After Testing)
```env
SIMULATION_MODE=false        # REAL MONEY!
BUY_AMOUNT_USDC=5            # Start small
STOP_LOSS_PNL_PCT=-50
TARGET_PROFIT_PCT=20
```

### Conservative Strategy
```env
MIN_ODDS=80                  # High confidence only
MAX_ODDS=90
STOP_LOSS_PNL_PCT=-30        # Exit losses early
TARGET_PROFIT_PCT=15         # Take profits early
MOONSHOT_ENABLED=false       # No risky bets
```

### Aggressive Strategy
```env
MIN_ODDS=70                  # More opportunities
MAX_ODDS=95
STOP_LOSS_PNL_PCT=-70        # Hold through dips
TARGET_PROFIT_PCT=40         # Hold for big wins
MOONSHOT_ENABLED=true        # Include moonshots
```

### Per-Strategy Buy Amounts
```env
# Default amount (applies to all strategies unless overridden)
BUY_AMOUNT_USDC=25

# Optional: Override amount for specific strategies
EARLY_BUY_AMOUNT_USDC=10     # Early contrarian (riskier, use less)
LATE_BUY_AMOUNT_USDC=50      # Late window (safer, use more)
MOONSHOT_AMOUNT_USDC=2       # Moonshot (always separate)
```

**Example: Conservative with different amounts**
```env
BUY_AMOUNT_USDC=25           # Default
EARLY_BUY_AMOUNT_USDC=10     # Lower for risky early trades
LATE_BUY_AMOUNT_USDC=40      # Higher for safer late trades
MOONSHOT_AMOUNT_USDC=1       # Small lottery ticket
```

---

## 📊 Essential Commands

### Start Bot
```bash
node src/index.js
```

### Check Simulation Stats
```bash
cat simulation/sim-stats.json
```

### View Trades
```bash
cat simulation/sim-trades.jsonl | jq
```

### Reset Simulation
```bash
rm -rf simulation/
```

### Check Live Stats
```bash
cat data/stats.json
```

---

## 🎭 Simulation vs Live

| Mode | Costs Real Money? | Use Case |
|------|-------------------|----------|
| `SIMULATION_MODE=true` | ❌ No | Testing strategies |
| `SIMULATION_MODE=false` | ✅ YES | Real trading |

**⚠️ IMPORTANT:** Always test in simulation first!

---

## 🚨 Stop Loss Settings

### What It Does
Automatically sells when losing too much money.

### Configuration
```env
STOP_LOSS_ENABLED=true       # Turn on/off
STOP_LOSS_PNL_PCT=-50        # Sell at -50% loss
STOP_LOSS_MINUTES=2          # Active in last 2 minutes
```

### Examples
```env
# Conservative (exit early)
STOP_LOSS_PNL_PCT=-20

# Balanced
STOP_LOSS_PNL_PCT=-50

# Aggressive (hold longer)
STOP_LOSS_PNL_PCT=-70

# Disable stop loss
STOP_LOSS_ENABLED=false
```

---

## 📈 Strategy Settings

### Early Contrarian
Buy opposite side when market is one-sided early on.

```env
EARLY_STRATEGY_ENABLED=true
EARLY_WINDOW_MINUTES=30      # First 30 min of market
EARLY_TRIGGER_ODDS=70        # Buy opposite if side > 70%
EARLY_PROFIT_TARGET_PCT=20
```

### Late Window (Default)
Buy strong side in last minutes before deadline.

```env
BUY_WINDOW_MINUTES=13        # Last 13 minutes
MIN_ODDS=75                  # Minimum 75% confidence
MAX_ODDS=95                  # Maximum 95%
TARGET_PROFIT_PCT=20
```

### Moonshot
Small bets on extreme underdogs.

```env
MOONSHOT_ENABLED=true
MOONSHOT_WINDOW_MINUTES=2    # Last 2 minutes
MOONSHOT_MAX_ODDS=10         # Opposite side <= 10%
MOONSHOT_AMOUNT_USDC=1       # Small bet size
MOONSHOT_PROFIT_TARGET_PCT=100
```

---

## 🔍 Log Messages Cheat Sheet

### Simulation Mode
```
[SIM] 🎭 [SIMULATED BUY]     → Fake buy
[SIM] 🎭 [SIMULATED SELL]    → Fake sell
[SIM] ✅ [SIMULATED]          → Fake transaction completed
```

### Real Mode (No [SIM] tag)
```
🛒 Buying outcome=1           → Real buy starting
🧾 Buy tx: 0x...             → Real transaction sent
✅ Buy completed             → Real money spent
💸 Sending sell transaction  → Real sell starting
```

### Stop Loss
```
🚨 Stop loss! PnL -55%       → Selling to limit loss
✅ Stop loss sell completed  → Loss limited
```

### Profit Taking
```
🎯 Profit target reached!    → Taking profits
✅ sell completed. PnL: 🔺   → Profit banked
```

---

## ⚠️ Safety Checklist

Before going live:

- [ ] Tested in `SIMULATION_MODE=true` for a few hours
- [ ] Reviewed `simulation/sim-stats.json` results
- [ ] Set `BUY_AMOUNT_USDC=1` or `5` (start small!)
- [ ] Verified `STOP_LOSS_ENABLED=true`
- [ ] Set appropriate `STOP_LOSS_PNL_PCT` (-50 is reasonable)
- [ ] Have enough ETH for gas (~$1-2 worth)
- [ ] Understand you're trading REAL money

---

## 🆘 Quick Troubleshooting

**Bot not starting?**
```bash
# Check .env file exists
ls -la .env

# Verify Node.js version
node --version  # Need v16+
```

**No markets found?**
- Markets may not be active right now
- Check `PRICE_ORACLE_ID` is correct
- Try adding more oracle IDs

**Simulation not working?**
```bash
# Verify setting
grep SIMULATION_MODE .env

# Should show: SIMULATION_MODE=true
```

**Stop loss not triggering?**
- Must be in last 2 minutes of market
- PnL must be below threshold
- Check `STOP_LOSS_ENABLED=true`

**Want help?**
Read the full guides:
- `README_REFACTOR.md` - Complete overview
- `SIMULATION_MODE_GUIDE.md` - Simulation details
- `SUMMARY.md` - All changes summary

---

## 🎓 Learning Path

1. **Day 1:** Run in simulation mode, observe logs
2. **Day 2:** Check simulation results, adjust settings
3. **Day 3:** Test again with new settings
4. **Day 4:** Go live with tiny amounts ($1-5)
5. **Week 1:** Monitor closely, adjust strategy
6. **Week 2+:** Gradually increase amounts

---

## 💡 Pro Tips

1. **Start tiny:** Use $1-5 per trade when going live
2. **Test first:** Always simulate new settings
3. **Monitor gas:** Each trade costs ~$0.10-0.50 in fees
4. **Be patient:** Don't expect trades every minute
5. **Keep logs:** Archive simulation results
6. **Stay safe:** Never trade more than you can afford to lose

---

## 🚀 Ready to Start?

```bash
# 1. Configure
cp .env.example .env
nano .env  # Add your PRIVATE_KEYS

# 2. Enable simulation
echo "SIMULATION_MODE=true" >> .env

# 3. Run
node src/index.js

# 4. Watch logs
# Look for [SIM] tags

# 5. Check results (after a few hours)
cat simulation/sim-stats.json

# 6. Go live (when ready)
# Change SIMULATION_MODE=false in .env
```

---

**That's it! You're ready to trade.** 🎉

**Questions?** Check the full documentation in `README_REFACTOR.md`

**Need help?** Read `SIMULATION_MODE_GUIDE.md` for detailed simulation tutorial

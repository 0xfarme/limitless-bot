# ⚡ Strategies Quick Reference

## 🎯 3 Active Strategies

```
TIMELINE: Market Hour (Minute 0 → 60)
┌─────────────────────────────────────────────────────────────┐
│ 0   10        30              47                  58   60   │
│ │   │         │               │                   │    │    │
│ │   └─────────┘               └───────────────────┘    │    │
│ │   🌅 EARLY                  🎯 LATE WINDOW           │    │
│ │   Minutes 10-30             Last 13 minutes          │    │
│ │   Buy Underdog              Buy Favorite         🌙  │    │
│ │   When > 70%                75-95% Range         Last 2m  │
│ │                                                  Moonshot  │
│ Market Opens                                       Market    │
│                                                    Closes    │
└─────────────────────────────────────────────────────────────┘
```

---

## 🌅 Early Contrarian (Minutes 10-30)

**What:** Buy the underdog when crowd picks a favorite
**When:** Minutes 10-30, one side ≥ 70%
**Risk:** Medium
**Profit:** 20% target (trailing stop)

```env
EARLY_STRATEGY_ENABLED=true
EARLY_TRIGGER_ODDS=70
EARLY_BUY_AMOUNT_USDC=25      # Optional: override default
```

**Exit:**
- Trailing stop: -30% from peak
- Minute 45: Sell if profitable
- After 45: Hold to end

---

## 🎯 Late Window (Last 13 Minutes)

**What:** Ride the strong favorite to deadline
**When:** Last 13 min, 75-95% odds
**Risk:** Low-Medium
**Profit:** Hold until close

```env
BUY_WINDOW_MINUTES=13
MIN_ODDS=75
MAX_ODDS=95
LATE_BUY_AMOUNT_USDC=25       # Optional: override default
```

**Exit:**
- Hold until market closes
- Stop loss: -50% PnL (last 2 min)

---

## 🌙 Moonshot (Last 2 Minutes)

**What:** Small bet on extreme underdog
**When:** Last 2 min, underdog ≤ 10%
**Risk:** High (but small $)
**Profit:** 100% target (2x)

```env
MOONSHOT_ENABLED=true
MOONSHOT_MAX_ODDS=10
MOONSHOT_AMOUNT_USDC=1
```

**Two Modes:**
1. **Independent:** Buys underdog in last 2 min (works alone)
2. **Hedge:** Buys opposite after late window (if qualifies)

**Special Feature:**
- **Ignores MIN_MARKET_AGE_MINUTES** - can bet on brand new markets

**Exit:**
- Profit target: 100%
- Usually rides to end

---

## 🔢 Trade Examples

### Example 1: All Strategies Active

```
Market: "ETH above $4000?"

Min 15: YES 75% → Early buys NO @ 25% ($25)
Min 48: YES 88% → Late buys YES @ 88% ($25)
Min 58: YES 92% → Moon buys NO @ 8% ($1)

If ETH > $4000 (YES wins):
  Early NO: -$25
  Late YES: +$3.40
  Moon NO: -$1
  Total: -$22.60

If ETH < $4000 (NO wins):
  Early NO: +$75
  Late YES: -$25
  Moon NO: +$11.50
  Total: +$61.50
```

### Example 2: Early Exit + Late Win

```
Market: "BTC above $100k?"

Min 20: NO 72% → Early buys YES @ 28% ($25)
Min 35: YES climbs to 45% (+$15 profit)
Min 45: Early sells YES @ +20% → +$5 profit
Min 48: NO 85% → Late buys NO @ 85% ($25)
Min 60: Market closes NO

Result:
  Early: +$5 (exited early)
  Late: +$4.41
  Total: +$9.41
```

---

## ⚙️ Configuration Presets

### Conservative
```env
EARLY_STRATEGY_ENABLED=false    # No risky early bets
MIN_ODDS=80                      # High confidence only
MAX_ODDS=90
MOONSHOT_ENABLED=false           # No lottery tickets
STOP_LOSS_PNL_PCT=-30           # Exit losses quick
BUY_AMOUNT_USDC=10               # Smaller size
```

### Balanced ⭐ (Recommended)
```env
EARLY_STRATEGY_ENABLED=true
EARLY_TRIGGER_ODDS=70
MIN_ODDS=75
MAX_ODDS=95
MOONSHOT_ENABLED=true
MOONSHOT_AMOUNT_USDC=1
STOP_LOSS_PNL_PCT=-50
BUY_AMOUNT_USDC=25
```

### Aggressive
```env
EARLY_STRATEGY_ENABLED=true
EARLY_TRIGGER_ODDS=65            # More early trades
MIN_ODDS=70                      # More opportunities
MAX_ODDS=98
MOONSHOT_ENABLED=true
MOONSHOT_MAX_ODDS=15            # More moonshots
MOONSHOT_AMOUNT_USDC=2
STOP_LOSS_PNL_PCT=-70           # Hold losses longer
BUY_AMOUNT_USDC=50
```

### Per-Strategy Amounts 💰
```env
# Default amount (applies to all unless overridden)
BUY_AMOUNT_USDC=25

# Optional: Set different amounts per strategy
EARLY_BUY_AMOUNT_USDC=10        # Early contrarian
LATE_BUY_AMOUNT_USDC=50         # Late window (default)
MOONSHOT_AMOUNT_USDC=1          # Moonshot (always separate)
```

**Why use different amounts?**
- **Early Contrarian:** Riskier (40-50% win rate) → Use less
- **Late Window:** Safer (70-80% win rate) → Use more
- **Moonshot:** Lottery ticket → Always small

**Example: Risk-Adjusted**
```env
BUY_AMOUNT_USDC=25              # Fallback
EARLY_BUY_AMOUNT_USDC=15        # Lower risk on early
LATE_BUY_AMOUNT_USDC=40         # Higher on safer late
MOONSHOT_AMOUNT_USDC=2          # Slightly bigger lottery
```

---

## 📊 Win Rates & Returns

| Strategy | Win Rate | Avg Win | Avg Loss | Best Case | Worst Case |
|----------|----------|---------|----------|-----------|------------|
| Early    | 40-50%   | +20%    | -50%     | +100%     | -70%       |
| Late     | 70-80%   | +15%    | -50%     | +25%      | -100%      |
| Moonshot | 5-15%    | +800%   | -100%    | +1500%    | -100%      |

---

## 🎮 How to Use

### Start Simple
```env
# 1. Enable only late window
EARLY_STRATEGY_ENABLED=false
MOONSHOT_ENABLED=false
MIN_ODDS=75
MAX_ODDS=95
```

### Add Complexity
```env
# 2. Add moonshot (small risk)
MOONSHOT_ENABLED=true
MOONSHOT_AMOUNT_USDC=1
```

### Full Strategy
```env
# 3. Enable all strategies
EARLY_STRATEGY_ENABLED=true
MOONSHOT_ENABLED=true
```

---

## 🔍 Log Messages Cheat Sheet

```
🌅 Early contrarian: Side 0 at 75%
   → Early strategy buying opposite

🎯 Last 13min strategy: Buying outcome 1
   → Late window buying favorite

🔄 Early contrarian holding exists on outcome 0 - will only buy opposite side
   → Late window checking for early position before buying

🚫 Late window would buy outcome 0 but early contrarian already holds same side
   → Skipping buy to avoid doubling down on losing position

🔄 Late window buying outcome 1 to hedge early contrarian position on outcome 0
   → Creating natural hedge with opposite side

🌙 Independent moonshot! Underdog side 1 at 7% (<= 10%)
   → Independent moonshot buying extreme underdog

🌙 Moonshot! Bought side 1, now buying opposite
   → Moonshot placing hedge bet after late window

🌙 Skipping late window moonshot - already have moonshot position
   → Already placed independent moonshot

🌙 Skipping moonshot - already have opposite side covered by early_contrarian
   → Both sides already covered, no moonshot needed

🌙 In moonshot window but underdog at 15% (> 10% threshold)
   → Underdog odds too high, not a true moonshot

🛑 Trailing stop triggered! Peak=50%, Current=20%
   → Early contrarian exiting on trailing stop

⏰ Minute 45 - Force selling early_contrarian
   → Clearing early position for late strategy

💎 Holding position until market closes
   → Late window holding to deadline
```

---

## 🆘 Quick Fixes

**No trades happening?**
```env
# Widen odds ranges
MIN_ODDS=70
MAX_ODDS=98
EARLY_TRIGGER_ODDS=65
```

**Too many losses?**
```env
# Tighten odds, exit earlier
MIN_ODDS=80
MAX_ODDS=90
STOP_LOSS_PNL_PCT=-30
EARLY_STRATEGY_ENABLED=false
```

**Missing moonshots?**
```env
# More moonshot opportunities
MOONSHOT_MAX_ODDS=15
MOONSHOT_AMOUNT_USDC=2
```

---

## 💡 Pro Tips

1. **Test in simulation first**
   ```env
   SIMULATION_MODE=true
   ```

2. **Watch logs to understand timing**
   ```bash
   # Run bot and watch strategy triggers
   node src/index.js | grep "🌅\|🎯\|🌙"
   ```

3. **Check strategy performance**
   ```bash
   # View trades by strategy
   cat data/trades.jsonl | grep "early_contrarian"
   cat data/trades.jsonl | grep "default"
   cat data/trades.jsonl | grep "moonshot"
   ```

4. **Start with one strategy**
   - Master late window first
   - Add moonshot (low risk)
   - Add early contrarian last

5. **Adjust based on results**
   - Losing on early? Disable it
   - Late missing trades? Widen odds
   - Want more moonshots? Increase max odds

---

## 📚 Full Details

For complete strategy documentation, see:
- **STRATEGIES_GUIDE.md** - Full guide with examples
- **QUICK_START.md** - Get started quickly
- **SIMULATION_MODE_GUIDE.md** - Test strategies safely

---

**Quick Start:**
```bash
# 1. Configure
cp .env.example .env

# 2. Enable simulation
echo "SIMULATION_MODE=true" >> .env

# 3. Pick strategy setup (or use balanced default)
# Edit .env with configuration above

# 4. Run
node src/index.js

# 5. Watch strategies trigger
# Look for 🌅 🎯 🌙 emojis
```

**Ready to trade!** 🚀

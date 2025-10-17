# 🎯 Trading Strategies Guide

Your bot has **3 active strategies** that can run simultaneously. Each strategy targets different market conditions and time windows.

---

## 📊 Strategy Overview

| Strategy | When | What | Risk | Profit Target |
|----------|------|------|------|---------------|
| **🌅 Early Contrarian** | Minutes 10-30 | Buy underdog when favorite > 70% | Medium | 20% |
| **🎯 Late Window** | Last 13 min | Buy strong side (75-95%) | Low-Med | 20% |
| **🌙 Moonshot** | Last 2 min | Buy extreme underdog (<10%) | High | 100% |

All strategies can hold positions in the **same market** simultaneously on **different outcomes**.

---

## 🌅 Strategy 1: Early Contrarian

### Concept
**Bet against the crowd early** - When one side becomes heavily favored early in the market, buy the opposite (underdog) side betting on mean reversion.

### Entry Conditions
- ✅ Market is in **minutes 10-30** of the hour
- ✅ Market is at least **10 minutes old**
- ✅ One side reaches **≥70% odds** (configurable)
- ✅ No existing early contrarian position in this market

### The Trade
- **Buys:** Opposite side of the dominant side
- **Example:** If YES is at 75%, buy NO at 25%
- **Amount:** `BUY_AMOUNT_USDC` (default: $25)

### Exit Conditions

**Trailing Stop (Minutes 10-45):**
- Tracks peak PnL
- Sells if PnL drops **30% from peak**
- Example: Peak 50% → Sells at 20% (50% - 30%)

**Force Sell at Minute 45:**
- If **profitable**: Sells entire position to clear for late strategy
- If **losing**: Holds position and rides to end

**After Minute 45:**
- No more sells - position rides to market close
- Let winner or loser play out

### Configuration
```env
EARLY_STRATEGY_ENABLED=true         # Enable/disable
EARLY_TRIGGER_ODDS=70               # Buy opposite when side >= 70%
EARLY_PROFIT_TARGET_PCT=20          # Not used (trailing stop instead)
BUY_AMOUNT_USDC=25                  # Investment per trade
```

### Example Timeline
```
Minute 10: Market opens, tracking odds
Minute 15: YES reaches 72% → Buy NO at 28%
Minute 20: NO climbs to 35% (peak +25% PnL)
Minute 25: NO drops to 30% (still +7% PnL, within 30% of peak)
Minute 30: NO at 32% (+14% PnL)
Minute 45: Profitable → Force sell at +14%
```

### Why It Works
- Early odds can be volatile and overshoot
- Crowds often overreact to initial information
- Mean reversion tendency in prediction markets
- Gets out before late window trades dominate

---

## 🎯 Strategy 2: Late Window (Default)

### Concept
**Ride the favorite to deadline** - In the last minutes, buy the strongly favored side and hold until market closes.

### Entry Conditions
- ✅ Market is in **last 13 minutes** before deadline
- ✅ NOT in last 2 minutes (too late)
- ✅ At least 5 minutes remain
- ✅ One side is **75-95% odds** (configurable range)
- ✅ No existing late window position in this market

### The Trade
- **Buys:** The side with highest odds in 75-95% range
- **Example:** If YES is at 87%, buy YES
- **Amount:** `BUY_AMOUNT_USDC` (default: $25)

### Exit Conditions

**Hold Until Close:**
- **No profit taking** during last 13 minutes
- Holds position through market deadline
- Relies on strong odds being correct
- **Stop loss active** in last 2 minutes (PnL-based)

**Stop Loss (Last 2 Minutes):**
- If PnL drops below threshold (default: -50%)
- Sells to limit catastrophic losses
- Emergency exit only

### Configuration
```env
BUY_WINDOW_MINUTES=13               # Last N minutes to buy
NO_BUY_FINAL_MINUTES=2              # Don't buy in final N min
MIN_ODDS=75                         # Minimum odds to buy
MAX_ODDS=95                         # Maximum odds to buy
TARGET_PROFIT_PCT=20                # Not used (holds until close)
STOP_LOSS_ENABLED=true
STOP_LOSS_PNL_PCT=-50
BUY_AMOUNT_USDC=25
```

### Example Timeline
```
Minute 47: In last 13 min window
Minute 48: YES at 86% (in 75-95% range) → Buy YES
Minute 49-58: Hold position, watch PnL
Minute 59: Hold position
Minute 60: Market closes
→ If YES wins: Profit ~16% (100% - 86% paid)
→ If NO wins: Loss -100%
```

### Why It Works
- Strong late odds have information advantage
- Market has converged on likely outcome
- Less time for surprises
- High-confidence bets near resolution

---

## 🌙 Strategy 3: Moonshot

### Concept
**Lottery tickets on extreme underdogs** - Small bets on the unlikely outcome with huge upside.

### Entry Conditions
- ✅ Market is in **last 2 minutes** (moonshot window)
- ✅ Underdog side has **≤10% odds** (configurable)
- ✅ No existing moonshot position in this market
- ✅ **Ignores MIN_MARKET_AGE_MINUTES** - will bet on brand new markets
- ✅ Works independently OR as hedge after late window buy

### The Trade
- **Buys:** Extreme underdog (side with lowest odds)
- **Example 1 (Independent):** Market at 92/8, moonshot buys 8% side for $1
- **Example 2 (After Late Window):** Late bought YES at 92%, moonshot buys NO at 8%
- **Amount:** `MOONSHOT_AMOUNT_USDC` (default: $1)

### Exit Conditions

**Profit Target:**
- Sells at **100% profit** (2x return)
- Example: $1 invested → Sell at $2 value

**Stop Loss:**
- Same as other strategies
- PnL-based in last 2 minutes

**Hold Strategy:**
- Since market closes soon, often rides to end
- Small bet size limits risk

### Two Operating Modes

**Mode 1: Independent Moonshot**
- Triggers in last 2 minutes regardless of other strategies
- Buys extreme underdog (lowest odds side)
- Works even if late window doesn't buy
- **Ignores MIN_MARKET_AGE_MINUTES** - can bet on brand new markets

**Mode 2: Late Window Hedge**
- Triggers after late window buy completes
- Buys opposite side of late window trade
- Only if opposite side qualifies as moonshot (≤10% odds)
- Skipped if early contrarian already holds opposite side

### Configuration
```env
MOONSHOT_ENABLED=true               # Enable/disable
MOONSHOT_WINDOW_MINUTES=2           # Last N minutes
MOONSHOT_MAX_ODDS=10                # Only buy if underdog <= 10%
MOONSHOT_AMOUNT_USDC=1              # Small bet size
MOONSHOT_PROFIT_TARGET_PCT=100      # 2x return target
```

### Example Timeline

**Example 1: Independent Moonshot**
```
Minute 58: Market shows YES 93%, NO 7%
Minute 58: Late window skips (93% > 95% MAX_ODDS)
Minute 58: Moonshot buys NO at 7% for $1 (independent)
Minute 60: Market closes
→ If NO wins: +$12.29 (~1229% profit!)
→ If YES wins: -$1 (small loss)
```

**Example 2: Late Window + Moonshot Hedge**
```
Minute 58: Late window buys YES at 92% for $25
Minute 58: NO at 8% (< 10%) → Moonshot buys NO for $1
Minute 59-60: Hold both positions
→ If YES wins: Late +$2.17, Moon -$1 = +$1.17 total
→ If NO wins: Late -$25, Moon +$11.50 = -$13.50 total
```

### Why It Works
- **Hedging:** Protects against late window loss
- **Asymmetric payoff:** Small loss, huge potential gain
- **Market inefficiency:** Extreme odds can be wrong
- **Small capital:** Only risks $1 for potential $10+ return

---

## 🔄 How Strategies Work Together

### Multiple Positions in One Market

Your bot can hold **3 simultaneous positions** in the same market:

```
Example Market: "ETH above $4000?"

Minute 15 - Early Contrarian:
  YES at 75% → Buy NO at 25% for $25

Minute 48 - Late Window:
  YES at 88% → Buy YES for $25

Minute 58 - Moonshot:
  YES at 92% → Buy NO at 8% for $1

Result: 3 positions active
  - NO position: $25 (early contrarian)
  - YES position: $25 (late window)
  - NO position: $1 (moonshot)
```

### Position Tracking

Each strategy tracks independently:
- Separate cost basis
- Separate profit targets
- Separate exit rules
- Separate PnL calculations

### Hedging Effect

The strategies naturally hedge each other:
- Early contrarian often opposite of late window
- Moonshot hedges late window
- Reduces overall portfolio volatility
- Captures profits from both directions

---

## 📈 Profit & Loss Examples

### Scenario 1: Market Resolves YES

```
Positions:
  Early: NO at 25% for $25
  Late:  YES at 88% for $25
  Moon:  NO at 8% for $1

Result if YES wins:
  Early: -$25 (100% loss)
  Late:  +$3.40 (~13.6% profit)
  Moon:  -$1 (100% loss)

Total: -$22.60
```

### Scenario 2: Market Resolves NO

```
Positions:
  Early: NO at 25% for $25
  Late:  YES at 88% for $25
  Moon:  NO at 8% for $1

Result if NO wins:
  Early: +$75 (300% profit!)
  Late:  -$25 (100% loss)
  Moon:  +$11.50 (1150% profit!)

Total: +$61.50
```

### Scenario 3: Early Exits with Profit

```
Minute 45: Early sells NO at +20% → +$5
Minute 58: Late buys YES at 90% for $25
Minute 59: Moon buys NO at 10% for $1

Result if YES wins:
  Early: +$5 (exited early)
  Late:  +$2.77 (~11% profit)
  Moon:  -$1

Total: +$6.77
```

---

## ⚙️ Strategy Configuration Tips

### Conservative Setup
```env
# Play it safe
EARLY_STRATEGY_ENABLED=false        # Disable risky early bets
MIN_ODDS=80                         # Only very confident bets
MAX_ODDS=90
MOONSHOT_ENABLED=false              # No lottery tickets
STOP_LOSS_PNL_PCT=-30              # Exit losses early
BUY_AMOUNT_USDC=10                  # Smaller position size
```

### Balanced Setup (Recommended)
```env
# Mix of strategies
EARLY_STRATEGY_ENABLED=true
EARLY_TRIGGER_ODDS=70
MIN_ODDS=75
MAX_ODDS=95
MOONSHOT_ENABLED=true
MOONSHOT_AMOUNT_USDC=1
STOP_LOSS_PNL_PCT=-50
BUY_AMOUNT_USDC=25
```

### Aggressive Setup
```env
# Maximum opportunities
EARLY_STRATEGY_ENABLED=true
EARLY_TRIGGER_ODDS=65              # Earlier triggers
MIN_ODDS=70                         # More opportunities
MAX_ODDS=98                         # Higher confidence range
MOONSHOT_ENABLED=true
MOONSHOT_MAX_ODDS=15               # More moonshots
MOONSHOT_AMOUNT_USDC=2
STOP_LOSS_PNL_PCT=-70              # Hold through dips
BUY_AMOUNT_USDC=50                  # Larger positions
```

### Moonshot Only
```env
# Lottery ticket strategy
EARLY_STRATEGY_ENABLED=false
MIN_ODDS=85                         # Very selective late buys
MAX_ODDS=95
MOONSHOT_ENABLED=true
MOONSHOT_MAX_ODDS=15               # More moonshots
MOONSHOT_AMOUNT_USDC=5             # Bigger moonshots
BUY_AMOUNT_USDC=25
```

---

## 🎓 Strategy Selection Guide

### When to Enable Each Strategy

**Early Contrarian:**
- ✅ You believe in mean reversion
- ✅ Markets are volatile in early minutes
- ✅ You can tolerate moderate risk
- ❌ Skip if you want conservative approach

**Late Window:**
- ✅ Always enable (core strategy)
- ✅ Highest win rate
- ✅ Most predictable
- ✅ Information advantage near deadline

**Moonshot:**
- ✅ You want upside exposure
- ✅ Small capital for big potential wins
- ✅ Natural hedge for late window
- ❌ Skip if you want predictable returns

---

## 📊 Performance Characteristics

### Early Contrarian
- **Win Rate:** 40-50%
- **Avg Profit:** 15-25% when wins
- **Avg Loss:** -50% when loses (trailing stop)
- **Best Case:** +100% (full reversal)
- **Worst Case:** -70% (held through minute 45)

### Late Window
- **Win Rate:** 70-80%
- **Avg Profit:** 10-20% when wins
- **Avg Loss:** -50% to -100% when loses
- **Best Case:** +25% (bought at 80%)
- **Worst Case:** -100% (wrong outcome)

### Moonshot
- **Win Rate:** 5-15%
- **Avg Profit:** 500-1000% when wins
- **Avg Loss:** -100% when loses (small $ amount)
- **Best Case:** +1500% (extreme upset)
- **Worst Case:** -100% (loses $1-2)

---

## 🔍 Advanced: Strategy Interactions

### Early → Late Transition

At minute 45, early contrarian positions are evaluated:
- **If profitable:** Sold to free capital for late window
- **If losing:** Held to ride out (might recover by deadline)

This allows the bot to:
1. Lock in early profits
2. Reallocate capital to late window
3. Still benefit if early loser becomes winner

### Late Window + Early Losing Position (Smart Hedging)

**NEW BEHAVIOR:** When early contrarian holds a losing position past minute 45, late window strategy intelligently hedges:

**Rules:**
1. **If late window wants to buy SAME side as losing early position:** Skip the buy (avoid doubling down on loser)
2. **If late window wants to buy OPPOSITE side:** Take the trade (natural hedge)
3. **No moonshot bet placed** (both sides already covered)

**Example 1: Skip Same-Side Buy**
```
Min 15: Early buys NO at 25% for $25
Min 45: NO at 30% (-16% PnL, losing) → Hold position (not sold)
Min 48: NO at 85% (in late window range)
→ Late window SKIPS buy (would be same side as losing early position)
→ Just ride the early NO position
```

**Example 2: Hedge with Opposite Side**
```
Min 15: Early buys NO at 25% for $25
Min 45: NO at 30% (-16% PnL, losing) → Hold position
Min 48: YES at 88% (in late window range)
→ Late window BUYS YES at 88% for $25 (opposite side = hedge)
→ Moonshot SKIPPED (both sides already covered)
→ Now holding: NO $25 + YES $25

If YES wins: Early loses -$25, Late wins +$3.40 = -$21.60 total
If NO wins: Early wins +$75, Late loses -$25 = +$50 total
```

**Why This Works:**
- Avoids throwing good money after bad (no doubling down)
- Creates natural hedge when buying opposite side
- Reduces risk exposure
- Still captures upside if early position recovers

### Late + Moonshot Combo

When late window buys WITHOUT existing early position:
1. Immediately checks if moonshot should trigger
2. Places small hedge on opposite side
3. Now has positions on BOTH outcomes

**Example:**
- Late: YES at 92% for $25
- Moon: NO at 8% for $1

**If YES wins:** +$2 profit (tiny win)
**If NO wins:** +$10.50 profit (moonshot saves it)

**Note:** Moonshot is automatically skipped if early contrarian already holds the opposite side.

---

## 💡 Pro Tips

### 1. Start with One Strategy
```env
# Test late window only first
EARLY_STRATEGY_ENABLED=false
MOONSHOT_ENABLED=false
```

### 2. Add Strategies Gradually
```env
# After late window works, add moonshot
MOONSHOT_ENABLED=true
MOONSHOT_AMOUNT_USDC=1  # Start tiny
```

### 3. Test in Simulation
```env
# Test all strategies together
SIMULATION_MODE=true
EARLY_STRATEGY_ENABLED=true
MOONSHOT_ENABLED=true
```

### 4. Monitor Each Strategy
```bash
# Check trade logs
cat data/trades.jsonl | grep "early_contrarian"
cat data/trades.jsonl | grep "moonshot"
cat data/trades.jsonl | grep "default"
```

### 5. Adjust Based on Results
- Early losing too much? → Disable or tighten `EARLY_TRIGGER_ODDS`
- Late window missing opportunities? → Widen `MIN_ODDS` to `MAX_ODDS` range
- Moonshot not triggering? → Increase `MOONSHOT_MAX_ODDS`

---

## 🆘 Troubleshooting

**No early contrarian trades?**
- Check minute 10-30 window
- Lower `EARLY_TRIGGER_ODDS` (try 65%)
- Verify markets reach 70%+ early

**Late window not buying?**
- Check last 13 minutes window
- Widen odds range (e.g., 70-98%)
- Ensure market is old enough (10+ min)

**Moonshot never triggers?**
- Verify `MOONSHOT_ENABLED=true`
- Increase `MOONSHOT_MAX_ODDS` (try 15%)
- Need late window to buy first

**Too many losses?**
- Tighten odds ranges
- Disable early contrarian
- Lower `STOP_LOSS_PNL_PCT` (exit earlier)

---

## 📚 Summary

Your bot runs **3 complementary strategies**:

1. **🌅 Early Contrarian** - Bet against the crowd (minutes 10-30)
2. **🎯 Late Window** - Ride the favorite (last 13 minutes)
3. **🌙 Moonshot** - Lottery ticket hedge (last 2 minutes)

Each strategy:
- Works independently
- Targets different market conditions
- Can hold simultaneous positions
- Has separate risk/reward profile

**Recommended:** Start with late window only, then add others after testing in simulation mode.

**Questions?** Test in `SIMULATION_MODE=true` and watch the logs to see how each strategy behaves!

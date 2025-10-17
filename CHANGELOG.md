# Changelog

## Latest Changes

### ✅ Independent Moonshot Strategy
**Date:** 2025-10-17

**What Changed:**
- Moonshot now operates independently in last 2 minutes
- No longer requires late window to buy first
- **Ignores MIN_MARKET_AGE_MINUTES** - can bet on brand new markets
- Buys extreme underdog (lowest odds side) if ≤ 10%
- Still works as hedge after late window buy (dual mode)

**Why:**
- Capture moonshot opportunities even when late window doesn't buy
- Brand new markets often have extreme odds in last minutes
- More moonshot opportunities = more lottery tickets
- Flexibility to work standalone or as hedge

**Two Operating Modes:**

**Mode 1: Independent**
```
Market at 93/7 in last 2 minutes
Late window: Skips (93% > MAX_ODDS)
Moonshot: Buys 7% side for $1 ✅
```

**Mode 2: Late Window Hedge**
```
Late window: Buys YES at 88%
Moonshot: Buys NO at 12% (if ≤ 10%) ✅
```

**Configuration:**
```env
MOONSHOT_ENABLED=true
MOONSHOT_WINDOW_MINUTES=2         # Last 2 minutes
MOONSHOT_MAX_ODDS=10              # Buy if underdog ≤ 10%
MOONSHOT_AMOUNT_USDC=1
MIN_MARKET_AGE_MINUTES=10         # Moonshot IGNORES this
```

**Log Messages:**
```
🌙 Independent moonshot! Underdog side 1 at 7% (<= 10%) with $1 USDC
🌙 Skipping late window moonshot - already have moonshot position
🌙 In moonshot window but underdog at 15% (> 10% threshold) - waiting
```

---

### ✅ Per-Strategy Buy Amounts
**Date:** 2025-10-17

**What Changed:**
- Each strategy can now have its own buy amount
- `EARLY_BUY_AMOUNT_USDC` - Override amount for early contrarian
- `LATE_BUY_AMOUNT_USDC` - Override amount for late window
- `MOONSHOT_AMOUNT_USDC` - Already separate (defaults to $1)
- Falls back to `BUY_AMOUNT_USDC` if strategy-specific not set

**Why:**
- Risk-adjusted position sizing
- Use less capital on riskier early trades (40-50% win rate)
- Use more capital on safer late trades (70-80% win rate)
- Keep moonshots small (lottery tickets)

**Configuration:**
```env
# Default for all strategies
BUY_AMOUNT_USDC=25

# Optional overrides
EARLY_BUY_AMOUNT_USDC=10      # Risky early trades
LATE_BUY_AMOUNT_USDC=50       # Safer late trades
MOONSHOT_AMOUNT_USDC=1        # Small lottery
```

**Example:**
```
Early contrarian: Buys with $10 (EARLY_BUY_AMOUNT_USDC)
Late window: Buys with $50 (LATE_BUY_AMOUNT_USDC)
Moonshot: Buys with $1 (MOONSHOT_AMOUNT_USDC)
```

---

### ✅ Smart Hedging: Late Strategy + Early Losing Positions
**Date:** 2025-10-17

**What Changed:**
- Late window strategy now checks for existing early contrarian positions
- **Skips buy** if it would be same side as losing early position (no doubling down)
- **Takes buy** if it's opposite side (natural hedge)
- **Skips moonshot** when both sides already covered

**Why:**
- Prevents throwing good money after bad
- Creates intelligent hedging when holding losing positions
- Reduces risk exposure
- Moonshot unnecessary when already hedged

**Example:**
```
Early contrarian: NO at 25% for $25 (losing at min 45)
Late window: YES at 88% available
→ Buys YES (opposite = hedge)
→ Skips moonshot (both sides covered)

Result:
  If YES wins: -$25 + $3.40 = -$21.60
  If NO wins: +$75 - $25 = +$50
```

**Log Messages:**
```
🔄 Early contrarian holding exists on outcome 0 - will only buy opposite side
🚫 Late window would buy outcome 0 but early contrarian already holds same side - skipping
🔄 Late window buying outcome 1 to hedge early contrarian position on outcome 0
🌙 Skipping moonshot - already have opposite side covered by early_contrarian
```

---

### ✅ Added Deep Sleep Mode
**Date:** 2025-10-17

**What Changed:**
- Added `LATE_STRATEGY_ENABLED` configuration option
- Bot enters deep sleep mode when all strategies are disabled
- Enhanced sleep mode logging shows which strategies are active
- Hourly status updates when in deep sleep

**Why:**
- Saves resources when no trading strategies are enabled
- Clear visibility into which strategies are active
- Bot only wakes up when there's actual work to do

**Configuration:**
```env
LATE_STRATEGY_ENABLED=true      # Enable/disable late window strategy
EARLY_STRATEGY_ENABLED=true     # Enable/disable early contrarian
MOONSHOT_ENABLED=true           # Enable/disable moonshot
```

**Log Messages:**
```
💤 DEEP SLEEP: All trading strategies disabled.
💤 Sleep mode (Active: late_window, moonshot | Holdings: 2)
```

---

### ✅ Removed Partial Sell Feature
**Date:** 2025-10-17

**What Changed:**
- Removed `PARTIAL_SELL_ENABLED` and `PARTIAL_SELL_PCT` configuration
- All profit-taking sells now sell **100% of position**
- Simplified sell logic - no more partial position tracking
- Cleaner code, easier to understand

**Why:**
- Simplifies strategy logic
- Easier to track PnL
- Reduces complexity
- Full exit on profit target is cleaner

**Migration:**
- Remove `PARTIAL_SELL_ENABLED` and `PARTIAL_SELL_PCT` from your .env
- No other changes needed - bot automatically sells 100%

---

### ✅ Fixed Stop Loss (PnL-Based)
**Date:** 2025-10-17

**What Changed:**
- Stop loss now triggers on PnL percentage instead of odds
- Added `STOP_LOSS_ENABLED` and `STOP_LOSS_PNL_PCT` config
- Removed `STOP_LOSS_ODDS_THRESHOLD` (unused)

**Why:**
- Previous odds-based stop loss was broken
- Example: DOGE at -59.95% PnL but 59.7% odds → didn't sell
- Now sells when PnL drops below threshold (default: -50%)

**Migration:**
```env
# Remove this
STOP_LOSS_ODDS_THRESHOLD=40

# Add these
STOP_LOSS_ENABLED=true
STOP_LOSS_PNL_PCT=-50
```

---

### ✅ Added Sell Simulation
**Date:** 2025-10-17

**What Changed:**
- Simulation mode now simulates sells (profit taking + stop loss)
- Complete trade cycle simulation: Buy → Hold → Sell
- Full PnL tracking in simulation mode

**Why:**
- Test complete strategies without spending money
- Verify profit targets and stop loss work correctly
- Track realistic performance

**How to Use:**
```env
SIMULATION_MODE=true
```

---

### ✅ Simplified .env Configuration
**Date:** 2025-10-17

**What Changed:**
- Reduced .env.example from 155 lines to 67 lines (-57%)
- Removed unused features:
  - S3 upload configuration
  - Legacy strategy settings (STRATEGY_MODE, TRIGGER_PCT, TRIGGER_BAND)
  - Per-strategy buy amounts
  - Unnecessary file path overrides

**Migration:**
- Copy new .env.example
- Fill in your PRIVATE_KEYS and RPC_URL
- Old settings are ignored (no breaking changes)

---

### ✅ Created Modular Foundation
**Date:** 2025-10-17

**What Changed:**
- Created utility modules:
  - `src/config.js` - Configuration management
  - `src/utils/logger.js` - Logging
  - `src/utils/blockchain.js` - Blockchain helpers
  - `src/utils/storage.js` - State management
  - `src/services/market.js` - Market fetching
  - `src/services/contracts.js` - Contract interactions

**Why:**
- Ready for future refactoring
- Cleaner code organization
- Easier to maintain and extend

---

### ✅ Comprehensive Documentation
**Date:** 2025-10-17

**What Created:**
- `QUICK_START.md` - Get running in 3 minutes
- `STRATEGIES_GUIDE.md` - Complete strategy documentation
- `STRATEGIES_QUICK_REF.md` - Quick reference card
- `SIMULATION_MODE_GUIDE.md` - Simulation tutorial
- `README_REFACTOR.md` - Overview of all changes
- `SUMMARY.md` - Complete summary
- `CLEANUP_GUIDE.md` - Technical cleanup details

---

## Summary of All Changes

| Feature | Before | After | Impact |
|---------|--------|-------|--------|
| **Stop Loss** | ❌ Broken (odds-based) | ✅ Fixed (PnL-based) | Actually protects capital |
| **Partial Sells** | ✅ Enabled (90% default) | ❌ Removed (100% always) | Simpler logic |
| **Simulation** | ❌ Buy only | ✅ Full cycle (buy+sell) | Complete testing |
| **.env size** | 155 lines | 67 lines | -57% clutter |
| **Documentation** | ❌ Minimal | ✅ Comprehensive | 7 guides created |
| **Code organization** | ❌ Monolithic | ✅ Modular | Ready for growth |

---

## Migration Checklist

If updating from older version:

- [ ] Backup your current .env file
- [ ] Copy new .env.example
- [ ] Update stop loss config:
  ```env
  STOP_LOSS_ENABLED=true
  STOP_LOSS_PNL_PCT=-50
  ```
- [ ] Remove partial sell config (no longer used):
  ```env
  # PARTIAL_SELL_ENABLED=true
  # PARTIAL_SELL_PCT=90
  ```
- [ ] Remove legacy strategy config (no longer used):
  ```env
  # STRATEGY_MODE=dominant
  # TRIGGER_PCT=60
  # TRIGGER_BAND=5
  ```
- [ ] Test in simulation mode first:
  ```env
  SIMULATION_MODE=true
  ```
- [ ] Review QUICK_START.md for new features

---

## Breaking Changes

### None!

All changes are backward compatible:
- Old config variables are ignored (not errors)
- Bot works with minimal .env (just PRIVATE_KEYS and RPC_URL)
- New features are optional

### Behavior Changes

**Stop Loss:**
- Old: Triggered on odds < 40%
- New: Triggers on PnL < -50%
- **Impact:** Stop loss will now actually work!

**Profit Sells:**
- Old: Sold 90% by default (kept 10%)
- New: Sells 100% always
- **Impact:** Full exit on profit target

---

## Upgrade Guide

### From Any Previous Version

1. **Backup:**
   ```bash
   cp .env .env.backup
   cp -r data data.backup
   ```

2. **Update .env:**
   ```bash
   # Add new stop loss settings
   echo "STOP_LOSS_ENABLED=true" >> .env
   echo "STOP_LOSS_PNL_PCT=-50" >> .env

   # Remove old settings (optional, they're ignored)
   # Remove: PARTIAL_SELL_*, STRATEGY_MODE, TRIGGER_*
   ```

3. **Test:**
   ```bash
   # Test in simulation first
   echo "SIMULATION_MODE=true" >> .env
   node src/index.js
   ```

4. **Go Live:**
   ```bash
   # When ready
   # Set SIMULATION_MODE=false
   node src/index.js
   ```

---

## Future Changes

### Planned
- None currently

### Under Consideration
- Per-strategy stop loss thresholds
- Trailing stop for late window strategy
- Dynamic position sizing
- Multi-wallet coordination

---

**Questions?** Check the comprehensive guides in the repo or review the bot logs.

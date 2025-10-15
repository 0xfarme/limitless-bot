# Per-Strategy Simulation Mode

## Overview

The bot now supports **per-strategy simulation**, allowing you to run some strategies live while testing others in simulation mode **simultaneously**.

This is perfect for:
- Testing new strategies without risking capital
- Comparing performance between live and simulated approaches
- Gradually rolling out strategies (simulate first, then go live)
- Running A/B tests on different configurations

## Configuration

### Option 1: Global Simulation (All Strategies)

```env
SIMULATION_MODE=true
```

All strategies run in simulation mode - no real transactions.

### Option 2: Per-Strategy Simulation (Mixed Mode)

```env
SIMULATION_MODE=false
SIMULATE_STRATEGIES=early
```

Available strategies:
- `early` - Early contrarian strategy (first 30 minutes)
- `late` - Late window strategy (last 13 minutes)
- `all` - Simulate all strategies
- `` (empty) - All strategies live

### Examples

#### Example 1: Simulate Early, Live Late
```env
SIMULATION_MODE=false
SIMULATE_STRATEGIES=early
```

**Result:**
- ✅ Early contrarian trades: SIMULATED (logs to `simulation/`)
- ✅ Late window trades: LIVE (logs to `data/`)

#### Example 2: Live Early, Simulate Late
```env
SIMULATION_MODE=false
SIMULATE_STRATEGIES=late
```

**Result:**
- ✅ Early contrarian trades: LIVE (logs to `data/`)
- ✅ Late window trades: SIMULATED (logs to `simulation/`)

#### Example 3: Simulate Both (Alternative to SIMULATION_MODE=true)
```env
SIMULATION_MODE=false
SIMULATE_STRATEGIES=early,late
```

**Result:**
- ✅ All trades: SIMULATED (logs to `simulation/`)

#### Example 4: All Live (Default)
```env
SIMULATION_MODE=false
SIMULATE_STRATEGIES=
```

**Result:**
- ✅ All trades: LIVE (logs to `data/`)

## How It Works

### Separate Log Files

Each strategy writes to the appropriate directory based on its mode:

**Live Strategies:**
- `data/state.json`
- `data/trades.jsonl`
- `data/stats.json`

**Simulated Strategies:**
- `simulation/sim-state.json`
- `simulation/sim-trades.jsonl`
- `simulation/sim-stats.json`

### Log Prefixes

Logs show which mode is active:

```
2025-10-15T06:00:00.000Z 🛒 [SIM] [0x967e...] [SIMULATED EARLY] Buying outcome=1...
2025-10-15T06:47:00.000Z 🛒 [0x967e...] Buying outcome=0... (live trade)
```

### Startup Display

Bot shows simulation configuration on startup:

```
🎭 Per-Strategy Simulation:
   Simulated Strategies: EARLY
   Early Contrarian: 🎭 SIMULATED
   Late Window: 💰 LIVE
```

## Use Cases

### Use Case 1: Testing New Strategy Parameters

You want to test more aggressive early contrarian settings without risking real money:

```env
# .env
EARLY_TRIGGER_ODDS=60    # More aggressive (was 70)
SIMULATE_STRATEGIES=early
```

The bot will:
- Execute early trades in simulation with new settings
- Execute late trades live with proven settings
- Allow you to compare performance in logs

### Use Case 2: Gradual Rollout

You're confident in late window strategy but want to test early contrarian:

**Week 1:** Simulate early
```env
SIMULATE_STRATEGIES=early
```

**Week 2:** If simulation shows good results, go live
```env
SIMULATE_STRATEGIES=
```

### Use Case 3: A/B Testing

Run the same bot with different configs:

**Bot Instance 1:**
```env
EARLY_TRIGGER_ODDS=70
SIMULATE_STRATEGIES=early
```

**Bot Instance 2:**
```env
EARLY_TRIGGER_ODDS=60
SIMULATE_STRATEGIES=early
```

Compare `simulation/sim-stats.json` from both to find optimal settings.

## Performance Impact

**Simulation mode is FAST:**
- Skips approval transactions
- Skips buy/sell transactions
- No gas costs
- Uses simulated transaction hashes (`0xsim...`)

**What still runs:**
- Market data fetching (same API calls)
- Price calculations (`calcBuyAmount`)
- Strategy logic (identical decision-making)
- Position tracking and P&L calculations

## Monitoring Mixed Mode

### Check What's Running

```bash
# View current configuration
grep -E "SIMULATION_MODE|SIMULATE_STRATEGIES" .env
```

### View Live Trades
```bash
tail -f data/trades.jsonl
```

### View Simulated Trades
```bash
tail -f simulation/sim-trades.jsonl
```

### Compare Performance
```bash
# Live stats
cat data/stats.json | grep "winRate\|netProfitUSDC"

# Simulated stats
cat simulation/sim-stats.json | grep "winRate\|netProfitUSDC"
```

## Important Notes

### Priority Rules

1. `SIMULATION_MODE=true` **overrides** `SIMULATE_STRATEGIES`
2. If both are set, all strategies simulate
3. Global mode is simpler for full testing

### State Isolation

- Live and simulated strategies maintain **separate state files**
- No cross-contamination between modes
- Safe to run simultaneously

### Redemptions

Redemptions always use the **live state** file. Simulated positions won't attempt real redemptions.

## Troubleshooting

### "Both showing [SIM] prefix"

Check if `SIMULATION_MODE=true` is set - it overrides per-strategy settings.

```bash
# Should show SIMULATION_MODE=false for mixed mode
grep SIMULATION_MODE .env
```

### "No simulated trades being logged"

Ensure strategy is active during that time window:

- `early` only runs in first 30 minutes
- `late` only runs in last 13 minutes

### "Want to reset simulated state"

```bash
rm -rf simulation/
```

Simulated state will start fresh on next run.

## Advanced: Running Both Strategies on Same Market

You can run BOTH live and simulated on the same market:

```env
PRICE_ORACLE_ID=58,59
SIMULATE_STRATEGIES=early
```

**Behavior:**
- Market 58 & 59: Early trades simulated
- Market 58 & 59: Late trades live
- Same markets, different strategies, different modes

This allows true A/B testing of strategy timing!

## Per-Strategy Buy Amounts

You can allocate different capital to each strategy using per-strategy buy amounts:

```env
# Universal amount (fallback)
BUY_AMOUNT_USDC=5

# Override for specific strategies
EARLY_BUY_AMOUNT_USDC=3      # Lower risk for early contrarian
LATE_BUY_AMOUNT_USDC=10      # Higher confidence in late window
```

### Examples:

#### Conservative Early, Aggressive Late
```env
BUY_AMOUNT_USDC=5           # Default
EARLY_BUY_AMOUNT_USDC=2     # Small bets early
LATE_BUY_AMOUNT_USDC=15     # Big bets late
```

**Result:**
- Early contrarian: $2 USDC per trade
- Late window: $15 USDC per trade

#### Test Early Small, Run Late Normal
```env
BUY_AMOUNT_USDC=10          # Default for late
EARLY_BUY_AMOUNT_USDC=1     # Test with $1
SIMULATE_STRATEGIES=early   # Simulate early
```

**Result:**
- Early: $1 USDC simulated trades
- Late: $10 USDC live trades

#### Balanced Approach
```env
BUY_AMOUNT_USDC=5           # Default
EARLY_BUY_AMOUNT_USDC=5     # Same as default
LATE_BUY_AMOUNT_USDC=5      # Same as default
```

**Result:**
- All strategies: $5 USDC per trade

### Strategy-Specific Amount Priority

1. **Strategy-specific amount** (EARLY_BUY_AMOUNT_USDC or LATE_BUY_AMOUNT_USDC)
2. **Universal amount** (BUY_AMOUNT_USDC)

If no strategy-specific amount is set, the universal amount is used.

### Startup Display

Bot shows which amounts are active:

```
📋 Configuration:
   BUY_AMOUNT_USDC: 5 (default)
   EARLY_BUY_AMOUNT_USDC: 3 (overrides default for early strategy)
   LATE_BUY_AMOUNT_USDC: 10 (overrides default for late strategy)
```

### Logging

Trade logs show the amount used:

```
🎯 Last 13min strategy: Buying outcome 0 at 85% with $10 USDC
🔄 Early contrarian: Buying opposite side 1 at 25% with $3 USDC
```

---

**Ready to test strategies risk-free? Set `SIMULATE_STRATEGIES` and let the bot run!** 🚀

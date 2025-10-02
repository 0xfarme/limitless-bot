# 🚀 Quick Start Guide - Copy Trader

Get started copying trades in 5 minutes!

## Step 1: Find a Wallet to Copy

Visit [Limitless Exchange](https://limitless.exchange) and find successful traders:

1. Browse recent trades
2. Check user profiles
3. Copy their wallet address (e.g., `0x1234...7890`)

## Step 2: Setup

```bash
cd copy-trader
npm install
cp .env.example .env
```

## Step 3: Configure

Edit `.env`:

```bash
# REQUIRED: Wallet to copy
TARGET_WALLET=0xPASTE_WALLET_ADDRESS_HERE

# REQUIRED: Your wallet (for live trading)
PRIVATE_KEY=your_private_key_here

# Copy settings
COPY_RATIO=0.5                    # Copy at 50% of their size
MAX_POSITION_SIZE_USDC=50         # Max $50 per trade
```

## Step 4: Test in Simulation

```bash
# Add to .env:
SIMULATION_MODE=true
SIMULATION_BALANCE_USDC=1000

# Run
npm start
```

Watch it copy trades without spending real money!

## Step 5: Go Live (Optional)

Once confident:

```bash
# Edit .env:
SIMULATION_MODE=false

# Make sure you have USDC on Base network

# Run
npm start
```

## Example Configurations

### Conservative Setup
```bash
COPY_RATIO=0.25                   # 25% of target
MIN_POSITION_SIZE_USDC=5          # Skip small positions
MAX_POSITION_SIZE_USDC=25         # Cap at $25
STOP_LOSS_PCT=-10                 # Stop at -10%
TAKE_PROFIT_PCT=20                # Exit at +20%
AUTO_CLOSE_ON_TARGET_EXIT=true
```

### Aggressive Setup
```bash
COPY_RATIO=1.5                    # 150% of target (leverage)
MAX_POSITION_SIZE_USDC=100        # Higher limit
STOP_LOSS_PCT=-20                 # Wider stop
TAKE_PROFIT_PCT=50                # Bigger targets
MIN_MARKET_LIQUIDITY=5000         # Only liquid markets
```

### Category-Specific
```bash
ALLOWED_CATEGORIES=crypto         # Only crypto markets
COPY_RATIO=1.0
MAX_POSITION_SIZE_USDC=75
```

## Monitoring

### Real-time Console
```
🎯 New target position detected: BTC to $100k?
🔄 Copying position: $5 (target: $10, ratio: 0.5)
✅ Position copied successfully

🚪 Closing position: BTC to $100k? - TARGET_EXIT
✅ Position closed successfully
```

### Check Logs
```bash
# Trade log
tail -f data/copy-trades.log

# Current state
cat data/copy-state.json
```

## Tips

✅ **Start Small** - Use low `COPY_RATIO` initially
✅ **Test First** - Always simulate before live trading
✅ **Set Limits** - Use `MAX_POSITION_SIZE_USDC` to control risk
✅ **Monitor Actively** - Check logs frequently when starting
✅ **Fund Wallet** - Ensure enough USDC for positions + gas

## Troubleshooting

**No positions copying?**
- Check target has active positions
- Verify `MIN_POSITION_SIZE_USDC` isn't too high
- Make sure category filters aren't too restrictive

**"Insufficient USDC balance"?**
- Add USDC to your wallet on Base network
- Lower `MAX_POSITION_SIZE_USDC`

**Simulation balance going down?**
- Normal! It's testing with random P&L
- Focus on learning the system, not sim results

## Next Steps

1. Read full [README.md](README.md) for advanced features
2. Monitor for 24 hours in simulation
3. Analyze results in logs
4. Adjust settings based on target's trading style
5. Go live with small amounts

Happy copying! 🎯

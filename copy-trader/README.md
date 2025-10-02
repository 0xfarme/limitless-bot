# 🎯 Limitless Copy Trader

Automatically copy trades from any wallet on Limitless Exchange. Mirror positions in real-time with customizable size ratios, risk management, and filtering.

## 🌟 Features

- **Real-time Position Tracking** - Monitor target wallet via Limitless API
- **Flexible Position Sizing** - Copy by ratio or fixed amount
- **Auto-Close on Exit** - Automatically close when target closes
- **Risk Management** - Stop loss and take profit levels
- **Category Filtering** - Only copy specific market categories
- **Liquidity Filters** - Skip low-liquidity markets
- **Simulation Mode** - Test strategies without real trades
- **Comprehensive Logging** - Track all copied trades

## 📋 Quick Start

### 1. Installation

```bash
cd copy-trader
npm install
```

### 2. Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Target wallet to copy
TARGET_WALLET=0x1234567890123456789012345678901234567890

# Your wallet
PRIVATE_KEY=your_private_key

# Copy settings
COPY_RATIO=0.5                    # Copy at 50% of target's size
MIN_POSITION_SIZE_USDC=1          # Ignore positions < $1
MAX_POSITION_SIZE_USDC=100        # Cap at $100 per position

# Risk management
AUTO_CLOSE_ON_TARGET_EXIT=true    # Close when target closes
STOP_LOSS_PCT=-15                 # Stop loss at -15%
TAKE_PROFIT_PCT=25                # Take profit at +25%
MAX_CONCURRENT_POSITIONS=10       # Max open positions
```

### 3. Test with Simulation

```bash
# Set in .env
SIMULATION_MODE=true
SIMULATION_BALANCE_USDC=1000

# Run
npm start
```

### 4. Go Live

```bash
# Set in .env
SIMULATION_MODE=false
PRIVATE_KEY=your_actual_key

# Run
npm start
```

## 🎮 How It Works

### Position Detection

1. **Polls target wallet** every 10 seconds (configurable)
2. **Detects new positions** by comparing with previous snapshot
3. **Fetches market details** to check filters
4. **Calculates copy amount** based on settings
5. **Executes trade** if all conditions met

### Auto-Close Logic

When `AUTO_CLOSE_ON_TARGET_EXIT=true`:

1. Monitors target's positions continuously
2. Detects when target closes a position
3. Automatically closes your copy position
4. Logs exit reason as `TARGET_EXIT`

### Risk Management

#### Stop Loss
- Monitors each position's current price vs entry price
- Closes position if loss exceeds `STOP_LOSS_PCT`
- Example: Set `-15` to close at -15% loss

#### Take Profit
- Closes position when profit reaches `TAKE_PROFIT_PCT`
- Example: Set `25` to close at +25% profit

#### Position Limits
- `MAX_CONCURRENT_POSITIONS` prevents over-exposure
- Ignores new signals when limit reached

## ⚙️ Configuration Options

### Copy Settings

```bash
# Option 1: Copy by ratio
COPY_RATIO=1.0                    # 100% of target's size
COPY_RATIO=0.5                    # 50% of target's size
COPY_RATIO=2.0                    # 200% of target's size (leverage)

# Option 2: Fixed amount (overrides ratio)
FIXED_POSITION_SIZE_USDC=10       # Always bet $10 regardless of target

# Limits (apply to both modes)
MIN_POSITION_SIZE_USDC=1          # Minimum to copy
MAX_POSITION_SIZE_USDC=100        # Maximum per position
```

### Filtering

#### By Category
```bash
# Only copy these categories
ALLOWED_CATEGORIES=crypto,sports,politics

# Or ignore specific categories
IGNORED_CATEGORIES=entertainment,memes
```

#### By Liquidity
```bash
# Skip markets with less than $1000 liquidity
MIN_MARKET_LIQUIDITY=1000
```

### Execution

```bash
# Polling frequency
POLL_INTERVAL_MS=10000            # Check every 10 seconds

# Slippage tolerance
SLIPPAGE_BPS=150                  # 1.5% slippage

# Gas settings
MAX_GAS_ETH=0.015
GAS_PRICE_GWEI=0.005
CONFIRMATIONS=1
```

## 📊 Monitoring

### Console Output

```
🚀 Starting Limitless Copy Trader
🎯 LIVE TRADING MODE
👤 Target Wallet: 0x1234...7890
💰 Copy Settings: Ratio 0.5x
📊 Limits: Min $1 | Max $100
🛡️ Risk: Stop Loss -15% | Take Profit 25%
🔄 Auto-close on target exit: true

👀 Starting to monitor target wallet...

🎯 New target position detected: Will BTC hit $100k? - Outcome 1
🔄 Copying position: $5 (target: $10, ratio: 0.5)
📝 Executing buy transaction...
🧾 Tx: 0xabc123...
✅ Position copied successfully

🚪 Closing position: Will BTC hit $100k? - TARGET_EXIT
📝 Executing sell transaction...
✅ Position closed successfully
```

### Log Files

**`data/copy-trades.log`** - Human readable log:
```
2024-01-15T10:30:00Z | COPY_BUY | Will BTC hit $100k? | Outcome: 1 | Amount: $5
2024-01-15T11:45:00Z | COPY_SELL | Will BTC hit $100k? | Outcome: 1 | Amount: $5.75 | PnL: 15%
```

**`data/copy-state.json`** - Current positions:
```json
{
  "copiedPositions": {
    "0xmarket-1": {
      "marketAddress": "0x...",
      "outcomeIndex": 1,
      "amount": 5,
      "entryTime": 1705315800000,
      "entryPrice": 62.5,
      "marketTitle": "Will BTC hit $100k?",
      "targetAmount": 10
    }
  },
  "simulationBalance": 1005.75
}
```

## 🎯 Use Cases

### 1. Copy Whale Traders
```bash
TARGET_WALLET=0xwhale_address
COPY_RATIO=0.1                    # Copy at 10% size
MAX_POSITION_SIZE_USDC=50
```

### 2. Mirror Friend's Portfolio
```bash
TARGET_WALLET=0xfriend_address
COPY_RATIO=1.0                    # Match their size
AUTO_CLOSE_ON_TARGET_EXIT=true
```

### 3. Test New Strategies
```bash
SIMULATION_MODE=true
TARGET_WALLET=0xsuccessful_trader
COPY_RATIO=1.0
# Let it run for a week, analyze results
```

### 4. Conservative Following
```bash
COPY_RATIO=0.25                   # 25% of target
STOP_LOSS_PCT=-10                 # Tight stop loss
TAKE_PROFIT_PCT=15                # Take profits early
MIN_MARKET_LIQUIDITY=5000         # Only liquid markets
```

### 5. Category-Specific Copying
```bash
ALLOWED_CATEGORIES=crypto         # Only crypto markets
COPY_RATIO=2.0                    # 2x leverage
MAX_POSITION_SIZE_USDC=200
```

## ⚠️ Risk Warnings

1. **Delayed Execution** - You will copy trades with delay (API polling + execution time)
2. **Slippage** - You may get worse prices than target due to market impact
3. **Target May Have Better Info** - They might know something you don't
4. **Gas Costs** - Each trade costs gas, which eats into profits
5. **Smart Contract Risk** - All DeFi risks apply

## 🔧 Troubleshooting

### "Failed to fetch target positions"
- Check `TARGET_WALLET` is a valid Ethereum address
- Verify Limitless API is accessible
- Target wallet may have no positions yet

### "Insufficient USDC balance"
- Fund your wallet with USDC on Base
- Check `MAX_POSITION_SIZE_USDC` isn't too high for your balance

### "Skipping - liquidity too low"
- Target is trading low-liquidity markets
- Lower `MIN_MARKET_LIQUIDITY` or wait for better opportunities

### Trades Not Copying
- Check `MIN_POSITION_SIZE_USDC` - might be filtering them out
- Verify category filters aren't too restrictive
- Ensure `MAX_CONCURRENT_POSITIONS` not reached

## 📈 Performance Tips

1. **Lower Poll Interval** - Set to 5000ms for faster copying (more RPC calls)
2. **Wider Slippage** - Increase `SLIPPAGE_BPS` if trades fail
3. **Monitor Gas** - Adjust `GAS_PRICE_GWEI` during congestion
4. **Test First** - Always run simulation before live trading

## 🚀 Advanced Features

### Custom Position Sizing Logic

Edit `calculateCopyAmount()` in `src/index.js`:

```javascript
function calculateCopyAmount(targetAmount) {
  // Example: Scale based on amount
  if (targetAmount < 10) {
    return targetAmount * 2;  // 2x for small positions
  } else if (targetAmount < 50) {
    return targetAmount * 1;  // 1x for medium
  } else {
    return targetAmount * 0.5;  // 0.5x for large
  }
}
```

### Add Custom Filters

Edit `shouldCopyPosition()` in `src/index.js`:

```javascript
function shouldCopyPosition(position, marketDetails) {
  // Example: Only copy if target's position is large
  const targetAmount = Number(position.collateralAmount || 0);
  if (targetAmount < 20) {
    log('⏭️', 'Skipping - target position too small');
    return false;
  }

  // Example: Only copy YES positions
  if (position.outcomeIndex !== 1) {
    log('⏭️', 'Skipping - only copying YES positions');
    return false;
  }

  return true;
}
```

## 📝 Simulation Mode

Perfect for testing before going live:

```bash
SIMULATION_MODE=true
SIMULATION_BALANCE_USDC=1000
```

**What it does:**
- ✅ Monitors real target wallet
- ✅ Fetches real market data
- ✅ Calculates real copy amounts
- ✅ Logs all trades
- ❌ No blockchain transactions
- ❌ No real money at risk

**On exit (Ctrl+C):**
```
👋 Shutting down...

💼 Final Balance: $1050.75
📊 PnL: +50.75 (+5.08%)
📈 Positions copied: 15
```

## 🤝 Contributing

Found a bug or have a feature request? Open an issue!

## ⚖️ License

MIT

---

**Disclaimer:** This bot is for educational purposes. Use at your own risk. Past performance does not indicate future results. Always do your own research.

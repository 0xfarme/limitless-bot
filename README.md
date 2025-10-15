# 🤖 Limitless Trading Bot

> ⚠️ **EDUCATIONAL USE ONLY - READ DISCLAIMER BELOW**
>
> This bot is for educational purposes only. Use at your own risk. The author is NOT responsible for any losses.
> **Always use a dedicated test wallet with minimal funds.**

---

> **New to Limitless?** Please consider joining via this referral to support the development:
>
> ### 👉 [https://limitless.exchange/?r=7EWN40FT4N](https://limitless.exchange/?r=7EWN40FT4N) 👈

Automated trading bot for Limitless prediction markets on Base. Features dual-strategy trading, partial profit-taking, risk-free simulation mode, and comprehensive PNL tracking.

---

## 📋 Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
- [Trading Strategies](#-trading-strategies)
- [Configuration](#-configuration)
- [Advanced Features](#-advanced-features)
- [Trade Logging & Analytics](#-trade-logging--analytics)
- [Troubleshooting](#-troubleshooting)
- [Disclaimer](#-disclaimer)

---

## ✨ Features

### Core Trading
- 🎯 **Dual Strategy System** - Early contrarian + Late window strategies (run independently!)
- 💎 **Partial Profit-Taking** - Sell 90%, let 10% ride for maximum upside
- 📊 **Independent Positions** - Each strategy can hold separate positions on same market
- 💰 **Per-Strategy Capital Allocation** - Different buy amounts for each strategy
- 🛡️ **Stop Loss Protection** - Automatic sell if odds drop in final minutes
- 🔄 **Auto-Redemption** - Claim winning positions automatically

### Risk Management
- 🎭 **Simulation Mode** - Test strategies without spending real money
- 🎲 **Per-Strategy Simulation** - Mix live and simulated strategies
- 💤 **Intelligent Sleep Mode** - Stays awake when positions open, sleeps otherwise
- 🔒 **Safety Guardrails** - Market age checks, duplicate trade prevention

### Analytics & Monitoring
- 📈 **Real-Time Analytics** - Win rate, profit/loss, detailed trade logs
- ⚡ **Multi-Wallet Support** - Run multiple accounts simultaneously
- 🎨 **Beautiful Logs** - Timestamped, emoji-based status updates
- 🔄 **Robust Error Handling** - Automatic RPC retries, balance verification

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18 or higher
- **NEW wallet dedicated for this bot** (see security note below)
- Base network wallet with ETH for gas
- USDC on Base for trading

> ⚠️ **IMPORTANT SECURITY RECOMMENDATION**
>
> **Create a new wallet specifically for this bot.** Do NOT use your main wallet or any wallet with significant funds.
>
> Steps:
> 1. Create a fresh wallet (MetaMask, Rabby, etc.)
> 2. Transfer only the funds you're willing to risk for testing
> 3. Use that wallet's private key in the bot
> 4. Never share your private key or commit it to git

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/limitless-bot.git
cd limitless-bot

# Install dependencies
npm install

# Copy example environment file
cp .env.example .env

# Edit .env with your settings
nano .env
```

### Minimum Configuration

Edit `.env` and add:

```bash
# Required
RPC_URL=https://mainnet.base.org
PRIVATE_KEYS=your_private_key_here

# Market Selection
PRICE_ORACLE_ID=58,59  # ETH and SOL hourly predictions
FREQUENCY=hourly

# Trading Amount
BUY_AMOUNT_USDC=5
```

### Run the Bot

```bash
npm start
```

---

## 🎯 Trading Strategies

The bot runs **two independent strategies** that can trade simultaneously on the same market:

### 1. Early Contrarian Strategy

**Concept:** Buy the underdog when one side dominates early

**How it works:**
- Active during **first 10-30 minutes** of market life
- Triggers when one side reaches **70%+** odds (configurable)
- Buys the **opposite side** (contrarian bet)
- Sells when position reaches **20-30% profit** (configurable)

**Example:**
```
Market: "Will ETH be above $3,500 at 1:00 PM?"
Time: 12:15 PM (15 mins after market opens)

Prices: Side 0 (Yes) = 82%, Side 1 (No) = 18%
Bot: Triggers! Buys Side 1 (No) at 18% for $3 USDC

12:25 PM: Side 1 rises to 25% → Position hits 30% profit
Bot: Sells 90% ($2.70 worth), keeps 10% ($0.30) riding

Result at close: If Side 1 wins, that 10% becomes a big win!
```

**Configuration:**
```env
EARLY_STRATEGY_ENABLED=true
EARLY_WINDOW_MINUTES=30         # Active first 30 mins
MIN_MARKET_AGE_MINUTES=10       # Ignore first 10 mins (too new)
EARLY_TRIGGER_ODDS=80           # Trigger at 80%+
EARLY_PROFIT_TARGET_PCT=30      # Sell at 30% profit
EARLY_BUY_AMOUNT_USDC=3         # $3 per early trade
```

### 2. Late Window Strategy

**Concept:** High-confidence bets in final minutes before close

**How it works:**
- Active during **last 13 minutes** before market closes
- Only buys if one side has **75-95% odds** (configurable)
- Buys the **high-probability side**
- Holds until market closes (or stop-loss triggers)

**Example:**
```
Market: "Will ETH be above $3,500 at 1:00 PM?"
Time: 12:50 PM (10 mins before close)

Prices: Side 0 (Yes) = 87%, Side 1 (No) = 13%
Bot: Triggers! Buys Side 0 (Yes) at 87% for $10 USDC

Stop Loss: If odds drop below 40% in last 2 mins → Auto-sell
Otherwise: Hold until 1:00 PM and claim if wins
```

**Configuration:**
```env
BUY_WINDOW_MINUTES=13           # Last 13 minutes
NO_BUY_FINAL_MINUTES=2          # Don't buy in last 2 mins
MIN_ODDS=75                     # Min 75% odds
MAX_ODDS=95                     # Max 95% odds
TARGET_PROFIT_PCT=20            # Take profit at 20%
LATE_BUY_AMOUNT_USDC=10         # $10 per late trade
```

### Independent Positions

**Key Feature:** Both strategies can hold positions on the **same market simultaneously**!

**Example Scenario:**
```
Market: "Will BTC be above $45,000?"

10:15 AM (Early):
  - Side 0 hits 85% → Early buys Side 1 at 15% for $3
  - Position: early_contrarian, Side 1, cost $3

10:50 AM (Late):
  - Side 0 at 90% → Late buys Side 0 at 90% for $10
  - Position: default, Side 0, cost $10

Result:
  - Both positions tracked independently
  - Different profit targets
  - Different capital allocation
  - Hedge against each other if needed
```

---

## ⚙️ Configuration

### Essential Settings

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `RPC_URL` | Base RPC endpoint | - | `https://mainnet.base.org` |
| `PRIVATE_KEYS` | Wallet private keys (comma-separated) | - | `0xabc...,0xdef...` |
| `PRICE_ORACLE_ID` | Oracle IDs to trade | - | `58,59,60` |
| `BUY_AMOUNT_USDC` | Default position size | `5` | `10` |

### Per-Strategy Buy Amounts

Allocate different capital to each strategy:

| Variable | Description | Default |
|----------|-------------|---------|
| `BUY_AMOUNT_USDC` | Universal fallback | `5` |
| `EARLY_BUY_AMOUNT_USDC` | Early contrarian amount | Uses `BUY_AMOUNT_USDC` |
| `LATE_BUY_AMOUNT_USDC` | Late window amount | Uses `BUY_AMOUNT_USDC` |

**Example:**
```env
BUY_AMOUNT_USDC=5              # Default
EARLY_BUY_AMOUNT_USDC=2        # Small early bets
LATE_BUY_AMOUNT_USDC=15        # Big late bets
```

### Early Contrarian Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `EARLY_STRATEGY_ENABLED` | Enable early strategy | `true` |
| `EARLY_WINDOW_MINUTES` | Active window (0-N mins) | `30` |
| `MIN_MARKET_AGE_MINUTES` | Ignore markets younger than | `10` |
| `EARLY_TRIGGER_ODDS` | Buy opposite when side hits | `70` |
| `EARLY_PROFIT_TARGET_PCT` | Sell at profit % | `20` |

### Late Window Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `BUY_WINDOW_MINUTES` | Last N minutes to buy | `13` |
| `NO_BUY_FINAL_MINUTES` | Don't buy in last N mins | `2` |
| `MIN_ODDS` | Minimum odds to buy | `75` |
| `MAX_ODDS` | Maximum odds to buy | `95` |
| `TARGET_PROFIT_PCT` | Take profit % | `20` |
| `STOP_LOSS_MINUTES` | Stop loss active last N mins | `2` |
| `STOP_LOSS_ODDS_THRESHOLD` | Sell if odds drop below | `40` |

### Partial Sell Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `PARTIAL_SELL_ENABLED` | Enable partial sells | `true` |
| `PARTIAL_SELL_PCT` | Percentage to sell at profit | `90` |

**Example:**
```env
PARTIAL_SELL_ENABLED=true
PARTIAL_SELL_PCT=90            # Sell 90%, keep 10%
```

Set `PARTIAL_SELL_PCT=100` for full sells (old behavior).

### Redemption Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `AUTO_REDEEM_ENABLED` | Enable auto-redemption | `true` |
| `REDEEM_WINDOW_START` | Start minute (0-59) | `6` |
| `REDEEM_WINDOW_END` | End minute (0-59) | `10` |

Markets close at :00, settle by :06, redeem during :06-:10.

---

## 🎭 Advanced Features

### Simulation Mode

Test strategies without spending real money!

#### Global Simulation (All Strategies)

```env
SIMULATION_MODE=true
```

All trades simulated, logs saved to `simulation/` directory.

#### Per-Strategy Simulation (Mix Live & Simulated)

```env
SIMULATION_MODE=false
SIMULATE_STRATEGIES=early      # Only simulate early, late runs live
```

**Options:**
- `early` - Simulate early contrarian only
- `late` - Simulate late window only
- `early,late` - Simulate both
- `` (empty) - All live

**Use Cases:**

**Test New Parameters:**
```env
EARLY_TRIGGER_ODDS=80          # More aggressive
SIMULATE_STRATEGIES=early      # Test without risk
```

**Gradual Rollout:**
```env
# Week 1: Simulate early
SIMULATE_STRATEGIES=early

# Week 2: If profitable, go live
SIMULATE_STRATEGIES=
```

**Separate Log Files:**
- Live: `data/trades.jsonl`, `data/state.json`
- Simulated: `simulation/sim-trades.jsonl`, `simulation/sim-state.json`

### Multi-Wallet Trading

Run multiple accounts simultaneously:

```env
PRIVATE_KEYS=0xkey1,0xkey2,0xkey3
```

Each wallet:
- Trades independently
- Has its own state tracking
- Logs trades separately
- Can use different strategies

### Intelligent Sleep Mode

Bot automatically:
- **Stays awake** when positions are open (monitors profit targets)
- **Sleeps** during inactive periods to save RPC calls
- **Wakes up** for redemption, early, and late windows

**Active Periods:**
```
Minutes 00-30: Early contrarian active (or awake if positions open)
Minutes 06-10: Redemption window
Minutes 47-60: Late window active
```

---

## 📊 Trade Logging & Analytics

### Trade Logs

Every trade logged to `data/trades.jsonl`:

```json
{
  "timestamp": "2025-10-15T12:47:23.456Z",
  "type": "BUY",
  "wallet": "0x742d35Cc...",
  "marketAddress": "0x1234...",
  "marketTitle": "Will ETH be above $3,500 at 1:00 PM?",
  "outcome": 0,
  "investmentUSDC": "5.0",
  "strategy": "early_contrarian",
  "entryPrice": "18",
  "txHash": "0xabc...",
  "blockNumber": 12345678
}
```

**Trade Types:**
- `BUY` - Opened position
- `SELL_PROFIT` - Full sell at profit target
- `SELL_PROFIT_PARTIAL` - Partial sell (90%), keeping runner
- `SELL_STOP_LOSS` - Stop loss triggered

### Real-Time Statistics

Saved to `data/stats.json`:

```json
{
  "totalTrades": 42,
  "profitableTrades": 31,
  "losingTrades": 11,
  "totalProfitUSDC": 187.45,
  "totalLossUSDC": 52.30,
  "netProfitUSDC": 135.15,
  "winRate": 73.81,
  "startTime": "2025-10-15T06:00:00.000Z",
  "lastUpdated": "2025-10-15T18:30:00.000Z"
}
```

### Console Output

```
2025-10-15T12:15:23.456Z 🔄 [0x967e...] Early contrarian: Side 0 at 85% (>= 80%), buying opposite side 1 at 15% with $3 USDC
2025-10-15T12:15:30.567Z ✅ [0x967e...] Buy completed in block 12345678
2025-10-15T12:25:45.123Z 🎯 Profit target reached! PnL=30.5% >= 30% (early_contrarian strategy). Initiating 90% sell (keeping 10% riding)...
2025-10-15T12:25:52.789Z ✅ [0x967e...] 90% sell completed. PnL on sold portion: 🔺0.8190 USDC (30.50%)
2025-10-15T12:25:52.790Z 💎 [0x967e...] Keeping 10% position (keeping 10% riding) - letting it ride!
```

### View Analytics

```bash
# Real-time statistics
cat data/stats.json | jq .

# All trades
cat data/trades.jsonl | jq .

# Current positions
cat data/state.json | jq .

# Only profitable trades
grep "SELL_PROFIT" data/trades.jsonl | jq .

# Only early contrarian trades
grep "early_contrarian" data/trades.jsonl | jq .

# Simulated trades
cat simulation/sim-trades.jsonl | jq .
```

---

## 💡 Strategy Examples

### Conservative (High Win Rate)

```env
# Small positions, high confidence only
BUY_AMOUNT_USDC=2
EARLY_BUY_AMOUNT_USDC=1
LATE_BUY_AMOUNT_USDC=5

# Early: Only extreme dominance
EARLY_TRIGGER_ODDS=85
EARLY_PROFIT_TARGET_PCT=20

# Late: Very high odds only
MIN_ODDS=85
MAX_ODDS=95
BUY_WINDOW_MINUTES=10
```

### Balanced (Default)

```env
# Moderate positions
BUY_AMOUNT_USDC=5
EARLY_BUY_AMOUNT_USDC=3
LATE_BUY_AMOUNT_USDC=10

# Early: Standard contrarian
EARLY_TRIGGER_ODDS=80
EARLY_PROFIT_TARGET_PCT=30

# Late: Wide range
MIN_ODDS=75
MAX_ODDS=95
BUY_WINDOW_MINUTES=13
```

### Aggressive (Higher Risk/Reward)

```env
# Larger positions
BUY_AMOUNT_USDC=10
EARLY_BUY_AMOUNT_USDC=5
LATE_BUY_AMOUNT_USDC=20

# Early: Earlier triggers
EARLY_TRIGGER_ODDS=70
EARLY_PROFIT_TARGET_PCT=40

# Late: Wider odds
MIN_ODDS=70
MAX_ODDS=98
BUY_WINDOW_MINUTES=15
```

### Early Only (Test Contrarian)

```env
# Only trade early contrarian
EARLY_STRATEGY_ENABLED=true
EARLY_BUY_AMOUNT_USDC=5

# Disable late by setting impossible odds
MIN_ODDS=99
MAX_ODDS=100
```

### Late Only (High Confidence)

```env
# Disable early
EARLY_STRATEGY_ENABLED=false

# Only late window
LATE_BUY_AMOUNT_USDC=10
MIN_ODDS=80
MAX_ODDS=95
BUY_WINDOW_MINUTES=10
```

---

## 🐛 Troubleshooting

### Common Issues

**"Early/Late strategy already has a position - skipping buy"**
- Normal - each strategy only takes one position per market
- Other strategy can still buy independently

**"Holding remaining 10% position - PnL=X% (profit already taken)"**
- Normal - partial sell executed, keeping 10% runner
- Will hold until market close or redemption

**"Bot in sleep mode - not in active trading/redemption window"**
- Normal - saves RPC calls during inactive periods
- Will wake up when positions exist or active window starts

**"Insufficient USDC balance"**
- Add more USDC to your wallet
- Reduce `BUY_AMOUNT_USDC` or strategy-specific amounts

**"Gas estimate failed"**
- Check ETH balance for gas
- Increase `GAS_PRICE_GWEI`

**"No tokens found on-chain - position was likely already sold"**
- Normal - auto-cleanup of stale state
- Position was redeemed or sold elsewhere

### Debug Mode

Monitor logs in real-time:

```bash
# Follow all logs
npm start 2>&1 | tee bot.log

# Follow specific wallet
npm start 2>&1 | grep "0x967e"

# Watch trades only
tail -f data/trades.jsonl
```

### Reset State

```bash
# Remove all state (careful!)
rm -rf data/ simulation/

# Start fresh
npm start
```

---

## ⚠️ Important Notes

### Risk Warnings

1. **Partial sells not guaranteed** - Requires blockchain confirmation
2. **Stop loss depends on price updates** - May not trigger if prices don't update
3. **Gas costs** - Factor in ~$0.001-0.01 per transaction
4. **Independent positions** - Can hold opposite sides (hedge or double exposure)
5. **Market expiry** - Losing positions = total loss

### Pro Tips

1. ✅ **Start with simulation mode** - Test before going live
2. ✅ **Use per-strategy amounts** - Smaller early, larger late
3. ✅ **Monitor both positions** - Check `data/state.json` regularly
4. ✅ **Review partial sells** - Are 10% runners profitable?
5. ✅ **Test different trigger odds** - Find optimal for your markets
6. ✅ **Compare strategies** - Early vs late performance in logs
7. ✅ **Use multiple wallets** - Diversify across accounts

### Performance Optimization

**Reduce RPC Calls:**
- Sleep mode automatically enabled
- Only polls during active windows + when positions exist

**Save on Gas:**
- Combines approval checks
- Uses intelligent gas estimation
- Waits for 1 confirmation (configurable)

---

## 📜 License

MIT License - See LICENSE file for details

---

## ⚠️ Disclaimer

**THIS SOFTWARE IS FOR EDUCATIONAL PURPOSES ONLY.**

By using this bot, you acknowledge and agree that:

1. **No Guarantees**: This bot is experimental software with no guarantees of profitability or correct operation
2. **Risk of Loss**: You may lose ALL funds used with this bot
3. **Your Responsibility**: You are solely responsible for any losses, damages, or issues that arise from using this software
4. **Not Financial Advice**: This is not financial, investment, or trading advice
5. **Use at Your Own Risk**: The author(s) and contributors are NOT responsible for any financial losses or damages
6. **Security Risks**: Storing private keys carries inherent security risks
7. **No Liability**: Under no circumstances shall the author(s) be liable for any direct, indirect, incidental, special, or consequential damages

**STRONGLY RECOMMENDED:**
- Create a dedicated wallet with only test funds
- Start with simulation mode
- Use minimal amounts you can afford to lose completely
- Thoroughly test and understand the bot before risking real money
- Never use your main wallet or significant funds

**YOU HAVE BEEN WARNED. USE AT YOUR OWN RISK.**

---

## 💝 Support the Project

If this bot helped you or you found it useful, consider supporting the development:

### Donate

**ETH/USDC (Base Network):**
```
0x967ee892abEbD0953b1C50EFA25b9b17df96d867
```

### Other Ways to Support

- ⭐ Star this repository
- 🔗 Use referral code: [7EWN40FT4N](https://limitless.exchange/?r=7EWN40FT4N)
- 🐛 Report bugs and suggest features
- 📢 Share with others who might find it useful

Your support helps maintain and improve this project. Thank you! 🙏

---

## 🙏 Credits

Built with:
- [ethers.js](https://docs.ethers.org/) - Ethereum library
- [axios](https://axios-http.com/) - HTTP client
- [Limitless Exchange](https://limitless.exchange/) - Prediction market platform

---

**Happy Trading! 🚀**

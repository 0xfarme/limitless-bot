# 🤖 Limitless Trading Bot

> **New to Limitless?** Please consider joining via this referral to support the development:
>
> ### 👉 [https://limitless.exchange/?r=7EWN40FT4N](https://limitless.exchange/?r=7EWN40FT4N) 👈

Automated trading bot for Limitless prediction markets on Base. Trade hourly crypto price predictions or experiment with custom strategies on daily/weekly markets.

---

## 📋 Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
- [Configuration](#-configuration)
- [Bot Modes](#-bot-modes)
- [Strategy Examples](#-strategy-examples)
- [Advanced Usage](#-advanced-usage)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)

---

## ✨ Features

- 🎯 **Fixed profit targets** - No stop losses, only take profits
- 📊 **Multiple strategies** - Dominant side, opposite side, or custom
- 💰 **Multi-wallet support** - Run multiple accounts simultaneously
- 💾 **Persistent state** - Survives restarts without losing positions
- 📈 **Analytics & logging** - Track performance with detailed metrics
- ⚡ **Pre-approval system** - Faster trades with USDC pre-approval
- 🔄 **Automatic retries** - Handles temporary RPC/network issues
- 🎨 **Beautiful logs** - Easy-to-read emoji-based status updates

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18 or higher
- Base network wallet with ETH for gas
- USDC on Base for trading

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

# Hourly bot (recommended to start)
PRICE_ORACLE_IDS=58,59  # ETH and SOL hourly predictions
FREQUENCY=hourly
```

### Run the Bot

```bash
npm start
```

---

## ⚙️ Configuration

### Essential Settings

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `RPC_URL` | Base RPC endpoint | Required | `https://mainnet.base.org` |
| `PRIVATE_KEYS` | Wallet private keys (comma-separated) | Required | `0xabc...,0xdef...` |
| `PRICE_ORACLE_IDS` | Oracle IDs to trade (comma-separated) | Required | `58,59,60` |
| `FREQUENCY` | Market frequency | `hourly` | `hourly`, `daily`, `weekly` |

### Trading Parameters

| Variable | Description | Default |
|----------|-------------|---------|
| `BUY_AMOUNT_USDC` | Position size in USDC | `2` |
| `TARGET_PROFIT_PCT` | Take profit percentage | `12` |
| `SLIPPAGE_BPS` | Slippage tolerance (basis points) | `150` (1.5%) |
| `POLL_INTERVAL_MS` | Check interval (milliseconds) | `10000` (10s) |

### Strategy Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `STRATEGY_MODE` | `dominant` or `opposite` | `dominant` |
| `TRIGGER_PCT` | Entry trigger percentage | `55` |
| `TRIGGER_BAND` | Band around trigger for opposite mode | `5` |

### Risk Management

| Variable | Description | Default |
|----------|-------------|---------|
| `MIN_TIME_TO_ENTER_MINUTES` | Don't enter if < X min remaining | `20` |
| `MIN_TIME_TO_EXIT_MINUTES` | Exit profitable positions if < X min | `5` |
| `TIME_DECAY_THRESHOLD_MINUTES` | Reduce position size if < X min | `15` |

### Pre-Approval (Faster Trading)

| Variable | Description | Default |
|----------|-------------|---------|
| `PRE_APPROVE_USDC` | Enable pre-approval | `true` |
| `PRE_APPROVAL_AMOUNT_USDC` | Amount to pre-approve | `100` |
| `PRE_APPROVAL_INTERVAL_MS` | Re-approval interval | `3600000` (1h) |

---

## 🎮 Bot Modes

### Hourly Bot (Default)

Perfect for beginners - trades hourly crypto price predictions.

```bash
# .env
FREQUENCY=hourly
PRICE_ORACLE_IDS=58,59  # ETH, SOL
BUY_AMOUNT_USDC=2
TARGET_PROFIT_PCT=12
```

**Strategy:**
- Enters when one side reaches 55%+ probability
- Exits at 12% profit OR 10 minutes before deadline (if profitable)
- No stop losses - holds losing positions until deadline

### Long-Term Bot

For daily/weekly markets - requires more capital and patience.

```bash
# .env for long-term
FREQUENCY=daily  # or weekly
BUY_AMOUNT_USDC=10
TARGET_PROFIT_PCT=15
```

**Strategy:**
- Exits at 15% profit
- Final phase exit: Last 2h (daily) or 12h (weekly) if profitable
- No stop losses

---

## 💡 Strategy Examples

### Conservative (Recommended for Beginners)

```bash
STRATEGY_MODE=dominant
TRIGGER_PCT=60
BUY_AMOUNT_USDC=2
TARGET_PROFIT_PCT=12
```

**Logic:** Only buy when probability is 60%+, take 12% profit

### Aggressive High-Confidence

```bash
STRATEGY_MODE=dominant
TRIGGER_PCT=70
BUY_AMOUNT_USDC=5
TARGET_PROFIT_PCT=20
```

**Logic:** Wait for 70%+ probability, target 20% gains

### Contrarian

```bash
STRATEGY_MODE=opposite
TRIGGER_PCT=60
TRIGGER_BAND=5
BUY_AMOUNT_USDC=3
TARGET_PROFIT_PCT=15
```

**Logic:** Buy opposite side when price is 55-65% (mean reversion)

### Last-Minute Sniper

```bash
TRIGGER_PCT=80
MIN_TIME_TO_ENTER_MINUTES=10
BUY_AMOUNT_USDC=2
TARGET_PROFIT_PCT=5
```

**Logic:** Only enter in last 10 min if probability is 80%+, quick 5% profit

---

## 🔧 Advanced Usage

### Multi-Wallet Trading

Run multiple accounts simultaneously:

```bash
PRIVATE_KEYS=0xkey1,0xkey2,0xkey3
```

Each wallet trades independently with its own state.

### Custom Oracle Selection

Find oracle IDs at `https://limitless.exchange/markets`:

```bash
# Trade specific hourly predictions
PRICE_ORACLE_IDS=58,59,60,61,62
# 58 = ETH hourly
# 59 = SOL hourly
# 60 = BTC hourly
# etc.
```

### Performance Analytics

Check your stats:

```bash
# View summary
cat data/summary.json

# Detailed analytics
cat data/analytics.json

# Trade history CSV
cat data/trades.csv
```

### State Management

```bash
# View current positions
cat data/state.json

# View failed exits (markets with issues)
cat data/failed_exits.json

# Clear state (fresh start)
rm -rf data/
```

---

## 🐛 Troubleshooting

### Common Issues

**"calcSellAmount failed"**
- Market likely expired - bot will auto-mark as completed after 5 retries
- Check `data/failed_exits.json` for details

**"Insufficient USDC"**
- Add more USDC to your wallet
- Reduce `BUY_AMOUNT_USDC`

**"Only X.Xm left < 20m - too risky to enter"**
- Normal - bot won't enter new positions near deadline
- Will still manage existing positions

**"Gas estimate failed"**
- Increase `GAS_PRICE_GWEI` (default: 0.005)
- Check your ETH balance for gas

**Transactions too slow**
- Increase `GAS_PRICE_GWEI` to 0.01 or higher
- Enable pre-approval: `PRE_APPROVE_USDC=true`

### Debug Mode

```bash
# Add to .env for verbose logging
DEBUG=*
```

---

## 🎯 Gotchas & Tips

### ⚠️ Important Warnings

1. **No stop losses** - Bot NEVER sells at a loss automatically
2. **Holds until deadline** - Losing positions are held hoping for recovery
3. **Gas costs** - Factor in ~$0.001-0.01 per trade in gas fees
4. **Liquidity** - Large positions may have slippage beyond `SLIPPAGE_BPS`
5. **Market expiry** - Expired positions with losing outcomes = total loss

### 💎 Pro Tips

1. **Start small** - Test with `BUY_AMOUNT_USDC=1` first
2. **Use pre-approval** - Saves ~30% on transaction costs
3. **Monitor analytics** - Check `data/analytics.json` regularly
4. **Track by outcome** - See which outcomes (0 or 1) perform better
5. **Price range analysis** - Analytics show which entry prices are most profitable
6. **Multiple wallets** - Diversify across accounts to reduce risk
7. **Experiment** - Try different strategies on different oracles

### 📊 Reading the Logs

```
✅ [0x967e...d867] BUY completed at 62.3%
📈 [0x967e...d867] Value: 2.18 | PnL: 9.2% | Time left: 42m
🎯 [0x967e...d867] Target profit reached: TARGET_PROFIT (12.1%)
✅ [0x967e...d867] SOLD at 12.1% (TARGET_PROFIT)
```

- 🎯 = Buy signal triggered
- 📈 = Winning position
- 📉 = Losing position
- 🎯 = Target profit reached
- ⏰ = Deadline approaching
- 💥 = Error occurred

---

## 🤝 Contributing

### Share Your Strategies

Found a profitable strategy? Share it! Create an issue with:

1. Your config settings
2. Oracle IDs used
3. Performance stats (win rate, avg PnL)
4. Any gotchas

### Report Bugs

Open an issue with:
- Error message
- Your config (remove private keys!)
- Log snippet
- Expected vs actual behavior

### Example Strategy Template

```markdown
## Strategy Name

**Config:**
```bash
STRATEGY_MODE=dominant
TRIGGER_PCT=65
BUY_AMOUNT_USDC=3
TARGET_PROFIT_PCT=15
```

**Performance:**
- Win rate: 72%
- Avg PnL: +8.2%
- Best for: ETH hourly (Oracle 58)

**Notes:**
- Works best during high volatility
- Avoid during low volume hours
```

---

## 📜 License

MIT License - See LICENSE file for details

---

## ⚠️ Disclaimer

**Use at your own risk.** This bot:
- Is experimental and may have bugs
- Does not guarantee profits
- Can lose money
- Requires you to understand the risks
- Is not financial advice

Always start with small amounts and test thoroughly.

---

## 🙏 Credits

Built with:
- [ethers.js](https://docs.ethers.org/) - Ethereum library
- [axios](https://axios-http.com/) - HTTP client
- [Limitless Exchange](https://limitless.exchange/) - Prediction market platform

**Support development:** Use referral code [7EWN40FT4N](https://limitless.exchange/?r=7EWN40FT4N)

---

**Happy Trading! 🚀**

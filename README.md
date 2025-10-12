# 🤖 Limitless Trading Bot

> ⚠️ **EDUCATIONAL USE ONLY - READ DISCLAIMER BELOW**
>
> This bot is for educational purposes only. Use at your own risk. The author is NOT responsible for any losses.
> **Always use a dedicated test wallet with minimal funds.**

---

> **New to Limitless?** Please consider joining via this referral to support the development:
>
> ### 👉 [https://limitless.exchange/?r=7EWN40FT4N](https://limitless.exchange/?r=7EWN40FT4N) 👈

Automated trading bot for Limitless prediction markets on Base. Trades hourly crypto price predictions with configurable strategy parameters and comprehensive PNL tracking.

---

## 📋 Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
- [How It Works](#-how-it-works)
- [Configuration](#-configuration)
- [Trade Logging & Analytics](#-trade-logging--analytics)
- [Strategy Guide](#-strategy-guide)
- [Troubleshooting](#-troubleshooting)

---

## ✨ Features

- 🎯 **Smart timing** - Only trades in the last few minutes before market closes
- 📊 **Odds-based strategy** - Configurable odds range for entry
- 💰 **Stop loss protection** - Automatic sell if odds drop below threshold
- 💾 **Comprehensive logging** - Every trade logged with full details
- 📈 **Real-time analytics** - Track win rate, profit/loss, and performance
- ⚡ **Multi-wallet support** - Run multiple accounts simultaneously
- 🔄 **Robust error handling** - Automatic retries for RPC/network issues
- 🎨 **Beautiful logs** - Timestamped, emoji-based status updates

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

## 🎯 How It Works

### Trading Strategy

The bot uses a **last-minute timing strategy** to maximize win probability:

1. **Wait for buy window** - Only buys in the last 13 minutes (configurable)
2. **Check odds** - Only buys if odds are 75-95% (configurable)
3. **Stop loss protection** - Sells in last 3 minutes if odds drop below 50%
4. **Hold to close** - Otherwise holds position until market closes

### Timeline Example

```
Market opens at 12:00 PM, closes at 1:00 PM

12:00 - 12:47 PM: ⏸️  Waiting (not in buy window)
12:47 - 12:58 PM: ✅  Buy window active (if odds 75-95%)
12:58 - 1:00 PM:  🚫  No new buys (too close to deadline)
12:57 - 1:00 PM:  🛡️  Stop loss active (sell if odds < 50%)
```

### Safety Features

- **Minimum market age**: Won't buy markets less than 10 minutes old
- **No last-minute buys**: Blocks purchases in final 2 minutes
- **One position per market**: Prevents duplicate trades
- **Completed market tracking**: Never re-enters a market after exiting

---

## ⚙️ Configuration

### Required Settings

| Variable | Description | Example |
|----------|-------------|---------|
| `RPC_URL` | Base RPC endpoint | `https://mainnet.base.org` |
| `PRIVATE_KEYS` | Wallet private keys (comma-separated) | `0xabc...,0xdef...` |
| `PRICE_ORACLE_ID` | Oracle IDs to trade (comma-separated) | `58,59,60` |

### Trading Parameters

| Variable | Description | Default |
|----------|-------------|---------|
| `BUY_AMOUNT_USDC` | Position size in USDC | `5` |
| `TARGET_PROFIT_PCT` | Take profit percentage | `20` |
| `SLIPPAGE_BPS` | Slippage tolerance (basis points) | `100` (1%) |
| `POLL_INTERVAL_MS` | Check interval in milliseconds | `10000` (10s) |

### Strategy Timing Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `BUY_WINDOW_MINUTES` | Last N minutes to allow buys | `13` |
| `NO_BUY_FINAL_MINUTES` | Don't buy in last N minutes | `2` |
| `STOP_LOSS_MINUTES` | Stop loss active in last N minutes | `3` |
| `MIN_MARKET_AGE_MINUTES` | Don't buy markets younger than N min | `10` |

### Odds Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `MIN_ODDS` | Minimum odds to buy (%) | `75` |
| `MAX_ODDS` | Maximum odds to buy (%) | `95` |
| `STOP_LOSS_ODDS_THRESHOLD` | Sell if odds drop below (%) | `50` |

### File Paths (Optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `STATE_FILE` | Position state file | `data/state.json` |
| `TRADES_LOG_FILE` | Trade log file | `data/trades.jsonl` |
| `STATS_FILE` | Statistics file | `data/stats.json` |

---

## 📊 Trade Logging & Analytics

### Trade Logs

Every trade is logged to `data/trades.jsonl` with complete details:

```json
{
  "timestamp": "2025-01-15T12:47:23.456Z",
  "type": "BUY",
  "wallet": "0x742d35Cc...",
  "marketAddress": "0x1234...",
  "marketTitle": "Will ETH be above $3,500 at 1:00 PM?",
  "outcome": 0,
  "investmentUSDC": "5.0",
  "txHash": "0xabc...",
  "blockNumber": 12345678,
  "gasUsed": "123456"
}
```

### Statistics Dashboard

Real-time stats saved to `data/stats.json` and displayed after each trade:

```
📊 ========= BOT STATISTICS =========
📈 Total Trades: 15
✅ Profitable: 11 | ❌ Losing: 4
💰 Total Profit: $47.2340 USDC
💸 Total Loss: $18.1200 USDC
📊 Net P&L: $29.1140 USDC
🎯 Win Rate: 73.33%
⏱️  Uptime: 8.5 hours
=====================================
```

### Console Logs

All logs include timestamps for easy tracking:

```
2025-01-15T12:47:23.456Z 🔄 [0x742d35Cc...] Polling market data...
2025-01-15T12:47:24.123Z 📰 [0x742d35Cc...] Market: Will ETH be above $3,500?
2025-01-15T12:47:24.234Z 💹 [0x742d35Cc...] Prices: [82, 18]
2025-01-15T12:47:24.345Z 🎯 [0x742d35Cc...] Last 13min strategy: Buying outcome 0 at 82%
2025-01-15T12:47:30.567Z ✅ [0x742d35Cc...] Buy completed in block 12345678
```

---

## 💡 Strategy Guide

### Conservative (Recommended for Beginners)

```bash
# Wait for high confidence, quick profit target
BUY_WINDOW_MINUTES=10
MIN_ODDS=80
MAX_ODDS=95
TARGET_PROFIT_PCT=15
BUY_AMOUNT_USDC=2
```

**Expected:** High win rate (~75%+), smaller profits

### Balanced (Default)

```bash
# Standard settings with good risk/reward
BUY_WINDOW_MINUTES=13
MIN_ODDS=75
MAX_ODDS=95
STOP_LOSS_ODDS_THRESHOLD=50
TARGET_PROFIT_PCT=20
BUY_AMOUNT_USDC=5
```

**Expected:** Moderate win rate (~65-70%), moderate profits

### Aggressive

```bash
# Wider odds range, higher targets
BUY_WINDOW_MINUTES=15
MIN_ODDS=70
MAX_ODDS=98
STOP_LOSS_ODDS_THRESHOLD=40
TARGET_PROFIT_PCT=30
BUY_AMOUNT_USDC=10
```

**Expected:** Lower win rate (~55-60%), higher profits when winning

### Last-Minute Sniper

```bash
# Only trade in final minutes with extreme confidence
BUY_WINDOW_MINUTES=5
NO_BUY_FINAL_MINUTES=1
MIN_ODDS=85
MAX_ODDS=98
TARGET_PROFIT_PCT=10
```

**Expected:** Very high win rate (~80%+), quick trades

---

## 🔧 Advanced Usage

### Multi-Wallet Trading

Run multiple accounts simultaneously:

```bash
PRIVATE_KEYS=0xkey1,0xkey2,0xkey3
```

Each wallet:
- Trades independently
- Has its own state tracking
- Logs trades separately

### Custom Oracle Selection

Find oracle IDs at [limitless.exchange/markets](https://limitless.exchange/markets):

```bash
# Hourly crypto predictions
PRICE_ORACLE_ID=58,59,60  # ETH, SOL, BTC

# Or trade specific markets
PRICE_ORACLE_ID=58  # ETH only
```

### Viewing Analytics

```bash
# Real-time statistics
cat data/stats.json

# All trades (one JSON per line)
cat data/trades.jsonl

# Current positions
cat data/state.json

# Filter profitable trades only
grep "SELL_PROFIT" data/trades.jsonl | jq .
```

---

## 🐛 Troubleshooting

### Common Issues

**"Buy already in progress for this market"**
- Normal - prevents duplicate trades
- Will retry next tick if conditions still met

**"Not in last N minutes - waiting for buy window"**
- Normal - bot only trades in configured window
- Adjust `BUY_WINDOW_MINUTES` if needed

**"No side in odds range"**
- Normal - waiting for odds to be in configured range
- Adjust `MIN_ODDS`/`MAX_ODDS` to trade more frequently

**"Insufficient USDC"**
- Add more USDC to your wallet
- Reduce `BUY_AMOUNT_USDC`

**"Gas estimate failed"**
- Check your ETH balance for gas
- Increase `GAS_PRICE_GWEI` (default: 0.005)

### Debug Tips

1. **Check logs** - All timestamps help you trace execution
2. **Review trades.jsonl** - See exactly what happened
3. **Monitor stats.json** - Track performance over time
4. **Start small** - Test with `BUY_AMOUNT_USDC=1` first

---

## ⚠️ Important Notes

### Risk Warnings

1. **Stop loss is not guaranteed** - Depends on odds updating in time
2. **Holding to close** - Most positions held until market closes
3. **Gas costs** - Factor in ~$0.001-0.01 per trade
4. **Liquidity** - Large positions may have slippage
5. **Market expiry** - Losing positions = total loss

### Pro Tips

1. ✅ Start with small amounts
2. ✅ Monitor `data/stats.json` regularly
3. ✅ Test different odds ranges for your markets
4. ✅ Use multiple wallets to diversify
5. ✅ Check trade logs to understand bot decisions
6. ✅ Adjust `BUY_WINDOW_MINUTES` based on market behavior

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
- Start with minimal amounts you can afford to lose completely
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

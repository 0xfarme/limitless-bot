
 - New to Limitless? Please consider joining via this referral to support the bot: https://limitless.exchange/?r=7EWN40FT4N 

DONOT USE THIS STILL IN TEST MODE

# Limitless AMM Bot (Base)

Automates buying/selling YES/NO outcome tokens on Limitless AMM markets on Base, following rules:

- Buy the opposite side when one side trades around 60% (55–65%).
- Poll market every 10 seconds.
- When profit exceeds 20%, sell the position.
- Do not buy if already holding a position (detected via ERC1155 position token balance).
- Supports multiple wallets (multi-user) via comma-separated private keys.
- Uses axios for API and ethers for onchain actions.
- Checks USDC balance before buying and logs human-readable balances.
- Gas price is fixed at 0.005 gwei as requested.
 - Persists state (holding + completed markets) to disk so restarts keep context.
 - Skips buying when market is younger than 10 minutes, within 5 minutes of deadline, or when `positionIds` are missing. Logs market title each tick.

## Setup

- Install Node.js 18+.
- Copy `.env.example` to `.env` and fill values:
  - `RPC_URL` (Base RPC)
  - `PRICE_ORACLE_ID` (e.g., 58)
  - `PRIVATE_KEYS` (comma-separated)
  - Optional: `POLL_INTERVAL_MS`, `BUY_AMOUNT_USDC`, `TARGET_PROFIT_PCT`, `SLIPPAGE_BPS`, `GAS_PRICE_GWEI`, `FREQUENCY`, `STRATEGY_MODE`, `TRIGGER_PCT`, `TRIGGER_BAND`, `CONFIRMATIONS`
  - Optional: `STATE_FILE` (default `data/state.json`)

```
cp .env.example .env
npm install
npm start
```

## Notes

- Market info is fetched from `https://api.limitless.exchange/markets/prophet?priceOracleId=...&frequency=...`.
- Collateral approval (USDC) is sent to the market contract before buy.
- Position detection uses the Conditional Tokens (ERC1155) contract and the `positionIds` from the API.
- Before selling, the bot calls `setApprovalForAll(marketAddress, true)` if needed.
- Sell uses `calcSellAmount(returnAmount, outcomeIndex)` to determine how many outcome tokens to sell for a chosen return. The bot estimates the maximum feasible `returnAmount` to exit fully using a bounded search and then executes `sell(returnAmount, outcomeIndex, maxOutcomeTokensToSell)`.
- The fixed gas price may be underpriced during network congestion; adjust `GAS_PRICE_GWEI` if needed.
 - All submitted transactions await confirmation (`wait(CONFIRMATIONS)`), default 1.


### Strategy
- `STRATEGY_MODE=dominant`: Buy the side whose probability is ≥ `TRIGGER_PCT` (if both are ≥, buy the higher one). Default: 60.
- `STRATEGY_MODE=opposite`: If a side is within `TRIGGER_BAND` of `TRIGGER_PCT` (e.g., within 5 of 60), buy the opposite side.

## Caveats

- Cost basis and PnL tracking are in-memory; restarting the bot will lose that context. The bot will then refrain from auto-selling on PnL without a known cost basis.
- The mapping of outcome indices to YES/NO is not required by the strategy, which buys the opposite side of the one priced around 60%.
- Ensure your wallets have enough ETH on Base for gas and USDC for buys.
- Logs include emojis for each step to make it easier to follow.

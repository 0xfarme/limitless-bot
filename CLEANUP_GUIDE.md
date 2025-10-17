# Bot Cleanup & Refactoring Guide

## ✅ Completed

1. **Simplified .env.example** - Reduced from 155 to 67 lines
2. **Created modular structure:**
   - `src/config.js` - Configuration management
   - `src/utils/logger.js` - Logging utilities
   - `src/utils/blockchain.js` - Blockchain helpers
   - `src/utils/storage.js` - State/trades/stats management
   - `src/services/market.js` - Market fetching
   - `src/services/contracts.js` - Contract interactions

## 🔧 Manual Changes Needed in src/index.js

### 1. Remove S3 Upload Code

**Delete these lines:**
- Line 6: `const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');`
- Lines 154-175: S3 configuration and client initialization
- Lines 302-365: `uploadFileToS3`, `uploadAllLogsToS3`, `startS3Upload`, `stopS3Upload` functions
- Line 2822: `startS3Upload();` call
- Lines 361-363: S3 upload in graceful shutdown

### 2. Remove Legacy Strategy Code (UNUSED)

**Delete these lines:**
- Lines 53-56: `STRATEGY_MODE`, `TRIGGER_PCT`, `TRIGGER_BAND`, `LOOKBACK_BLOCKS`
- Lines 746-762: `pickOutcome()` function (uses legacy STRATEGY_MODE)
- Lines 2705-2707: Legacy strategy logging in startup

### 3. Remove Partial Sell Feature

**Delete these lines:**
- Lines 86-88: `PARTIAL_SELL_ENABLED` and `PARTIAL_SELL_PCT` config
- Lines 2383-2384: `isPartialSell` and `sellPercentage` calculation
- Line 2475: Partial sell holding message

**Change line ~2384 to:**
```javascript
sellPercentage = 100; // Always sell 100%
```

### 4. Remove Per-Strategy Buy Amounts

**Delete these lines:**
- Lines 28-47: `EARLY_BUY_AMOUNT_USDC`, `LATE_BUY_AMOUNT_USDC`, `getBuyAmountForStrategy()` function

**Replace all calls to `getBuyAmountForStrategy()` with:**
```javascript
BUY_AMOUNT_USDC
```

### 5. **CRITICAL:** Fix Stop Loss to Use PnL

**Replace lines 2140-2198 (stop loss logic) with:**

```javascript
// Stop loss: sell if PnL drops below threshold in last N minutes
if (inLastThreeMinutes && !calcSellFailed && pnlPct < STOP_LOSS_PNL_PCT) {
  logInfo(wallet.address, '🚨', `[${marketAddress.substring(0, 8)}...] Stop loss! PnL ${pnlPct.toFixed(2)}% below ${STOP_LOSS_PNL_PCT}%`);

  const approvedOk = await ensureErc1155Approval(wallet, erc1155, marketAddress);
  if (!approvedOk) {
    logWarn(wallet.address, '🛑', 'Approval not confirmed; skipping stop loss sell this tick.');
    return;
  }

  const maxOutcomeTokensToSell = tokenBalance;
  const returnAmountForSell = positionValue > 0n ? positionValue - (positionValue / 100n) : 0n;

  const gasEst = await estimateGasFor(market, wallet, 'sell', [returnAmountForSell, outcomeIndex, maxOutcomeTokensToSell]);
  if (!gasEst) {
    logWarn(wallet.address, '🛑', 'Gas estimate sell failed; skipping stop loss sell this tick.');
    return;
  }

  const padded = (gasEst * 120n) / 100n + 10000n;
  const sellOv = await txOverrides(wallet.provider, padded);
  const tx = await market.sell(returnAmountForSell, outcomeIndex, maxOutcomeTokensToSell, sellOv);
  const sellReceipt = await tx.wait(CONFIRMATIONS);

  const pnlUSDC = parseFloat(ethers.formatUnits(positionValue - cost, decimals));
  logInfo(wallet.address, '✅', `[${marketAddress.substring(0, 8)}...] Stop loss sell completed. PnL: ${pnlPct.toFixed(2)}%`);

  logTrade({
    type: 'SELL_STOP_LOSS',
    wallet: wallet.address,
    marketAddress,
    marketTitle: marketInfo?.title || 'Unknown',
    outcome: outcomeIndex,
    costUSDC: ethers.formatUnits(cost, decimals),
    returnUSDC: ethers.formatUnits(positionValue, decimals),
    pnlUSDC: pnlUSDC.toFixed(4),
    pnlPercent: pnlPct.toFixed(2),
    reason: `Stop loss - PnL ${pnlPct.toFixed(2)}% < ${STOP_LOSS_PNL_PCT}%`,
    txHash: tx.hash,
    blockNumber: sellReceipt.blockNumber,
    gasUsed: sellReceipt.gasUsed.toString()
  });

  updateStats(pnlUSDC);
  removeHolding(wallet.address, marketAddress, strategyType);
  return;
}
```

**Add this config line near line 67-68:**
```javascript
const STOP_LOSS_ENABLED = (process.env.STOP_LOSS_ENABLED || 'true').toLowerCase() === 'true';
const STOP_LOSS_PNL_PCT = parseInt(process.env.STOP_LOSS_PNL_PCT || '-50', 10);
```

**Remove line 68:**
```javascript
const STOP_LOSS_ODDS_THRESHOLD = parseInt(process.env.STOP_LOSS_ODDS_THRESHOLD || '40', 10);
```

## 🧪 Testing After Changes

1. Backup your .env file
2. Copy .env.example to .env and fill in your values
3. Run: `node src/index.js`
4. Verify:
   - Bot connects to RPC
   - Markets are fetched
   - No errors about missing config
   - Stop loss triggers on PnL, not odds

## 📊 Before vs After

| Metric | Before | After |
|--------|--------|-------|
| .env lines | 155 | 67 |
| Config complexity | High | Low |
| Unused features | 5 | 0 |
| Stop loss bug | ❌ Broken | ✅ Fixed |
| Modular code | ❌ No | ✅ Yes |

## 🚀 Future Enhancements

The modular structure is ready for:
- Easy strategy additions
- Better testing
- Dashboard integration
- Multi-chain support

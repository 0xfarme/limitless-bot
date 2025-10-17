import { ethers } from 'ethers';
import { CONFIRMATIONS } from '../config.js';
import { logInfo, logWarn, logError } from '../utils/logger.js';
import { txOverrides } from '../utils/blockchain.js';
import MARKET_ABI from '../abis/Market.json' assert { type: 'json' };
import ERC20_ABI from '../abis/ERC20.json' assert { type: 'json' };
import ERC1155_ABI from '../abis/ERC1155.json' assert { type: 'json' };
import CONDITIONAL_TOKENS_ABI from '../abis/ConditionalTokens.json' assert { type: 'json' };

// Transaction lock to prevent nonce conflicts
const pendingTransactions = new Map();

async function withTransactionLock(walletAddress, transactionFn) {
  const pending = pendingTransactions.get(walletAddress);
  if (pending) {
    try {
      await pending;
    } catch (e) {
      // Ignore errors from previous transaction
    }
  }

  const promise = transactionFn();
  pendingTransactions.set(walletAddress, promise);

  try {
    return await promise;
  } finally {
    if (pendingTransactions.get(walletAddress) === promise) {
      pendingTransactions.delete(walletAddress);
    }
  }
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function retryRpcCall(fn, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isRpcError = e?.code === 'CALL_EXCEPTION' ||
        e?.message?.includes('missing revert data') ||
        e?.message?.includes('rate limit') ||
        e?.message?.includes('connection');

      if (attempt === maxRetries - 1 || !isRpcError) {
        throw e;
      }

      const delayMs = 2000 * Math.pow(2, attempt);
      logWarn(null, '⚠️', `RPC call failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms`);
      await delay(delayMs);
    }
  }
}

export function getContract(address, abi, signerOrProvider) {
  return new ethers.Contract(address, abi, signerOrProvider);
}

export function getMarketContract(address, wallet) {
  return new ethers.Contract(address, MARKET_ABI, wallet);
}

export function getERC20Contract(address, wallet) {
  return new ethers.Contract(address, ERC20_ABI, wallet);
}

export function getERC1155Contract(address, wallet) {
  return new ethers.Contract(address, ERC1155_ABI, wallet);
}

export function getConditionalTokensContract(address, wallet) {
  return new ethers.Contract(address, CONDITIONAL_TOKENS_ABI, wallet);
}

export async function readAllowance(usdc, owner, spender) {
  return retryRpcCall(async () => {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), 10000)
    );
    const allowancePromise = usdc.allowance(owner, spender);
    return await Promise.race([allowancePromise, timeoutPromise]);
  });
}

export async function readBalance(erc1155, owner, tokenId) {
  return retryRpcCall(() => erc1155.balanceOf(owner, tokenId));
}

export async function estimateGasFor(contract, wallet, fnName, args) {
  try {
    const fn = contract[fnName];
    if (!fn || !fn.estimateGas) {
      logWarn(wallet.address, '⚠️', `Function ${fnName} not found or no estimateGas`);
      return null;
    }
    const estimate = await fn.estimateGas(...args);
    return estimate;
  } catch (e) {
    logWarn(wallet.address, '⚠️', `Gas estimate failed for ${fnName}: ${e?.message || e}`);
    return null;
  }
}

export async function ensureUsdcApproval(wallet, usdc, marketAddress, needed) {
  return withTransactionLock(wallet.address, async () => {
    logInfo(wallet.address, '🔎', `Checking USDC allowance...`);
    const current = await readAllowance(usdc, wallet.address, marketAddress);

    if (current >= needed) return true;

    logInfo(wallet.address, '🔓', `Approving USDC ${needed} to ${marketAddress}...`);

    // Reset to 0 if current > 0 (some tokens require this)
    if (current > 0n) {
      const gasEst0 = await estimateGasFor(usdc, wallet, 'approve', [marketAddress, 0n]);
      if (!gasEst0) return false;

      const ov0 = await txOverrides(wallet.provider, (gasEst0 * 120n) / 100n + 10000n);
      const tx0 = await usdc.approve(marketAddress, 0n, ov0);
      await tx0.wait(CONFIRMATIONS);
    }

    const gasEst1 = await estimateGasFor(usdc, wallet, 'approve', [marketAddress, needed]);
    if (!gasEst1) return false;

    const ov1 = await txOverrides(wallet.provider, (gasEst1 * 120n) / 100n + 10000n);
    const tx = await usdc.approve(marketAddress, needed, ov1);
    await tx.wait(CONFIRMATIONS);

    const after = await readAllowance(usdc, wallet.address, marketAddress);
    return after >= needed;
  });
}

export async function ensureErc1155Approval(wallet, erc1155, operator) {
  return withTransactionLock(wallet.address, async () => {
    logInfo(wallet.address, '🔎', `Checking ERC1155 approval...`);

    try {
      const approved = await erc1155.isApprovedForAll(wallet.address, operator);
      if (approved) return true;
    } catch (e) {
      logWarn(wallet.address, '⚠️', `Failed to check approval: ${e?.message || e}`);
    }

    const gasEst = await estimateGasFor(erc1155, wallet, 'setApprovalForAll', [operator, true]);
    if (!gasEst) return false;

    logInfo(wallet.address, '🔓', `Setting ERC1155 approval...`);
    const ov = await txOverrides(wallet.provider, (gasEst * 120n) / 100n + 10000n);
    const tx = await erc1155.setApprovalForAll(operator, true, ov);
    await tx.wait(CONFIRMATIONS);

    return true;
  });
}

export async function estimateReturnForSellAll(market, outcomeIndex, tokenBalance, collateralDecimals) {
  const unit = 10n ** BigInt(collateralDecimals);
  let low = 0n;
  let high = unit;

  const need = async (ret) => {
    try {
      return await market.calcSellAmount(ret, outcomeIndex);
    } catch {
      return null;
    }
  };

  // Exponential search for upper bound
  for (let i = 0; i < 40; i++) {
    const needed = await need(high);
    if (needed === null || needed > tokenBalance) break;
    low = high;
    high = high * 2n;
  }

  // Binary search
  for (let i = 0; i < 50; i++) {
    const mid = (low + high) / 2n;
    if (mid === low || mid === high) break;

    const needed = await need(mid);
    if (needed === null) break;

    if (needed <= tokenBalance) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return low;
}

require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const MARKET_ABI = require('./abis/Market.json');
const ERC20_ABI = require('./abis/ERC20.json');
const ERC1155_ABI = require('./abis/ERC1155.json');

// ========= Config =========
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '8453', 10);
const PRICE_ORACLE_ID = process.env.PRICE_ORACLE_ID;
const FREQUENCY = process.env.FREQUENCY || 'hourly';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);
const BUY_AMOUNT_USDC = process.env.BUY_AMOUNT_USDC ? Number(process.env.BUY_AMOUNT_USDC) : 5; // human units
const TARGET_PROFIT_PCT = process.env.TARGET_PROFIT_PCT ? Number(process.env.TARGET_PROFIT_PCT) : 20; // 20%
const STOP_LOSS_ENABLED = process.env.STOP_LOSS_ENABLED !== 'false'; // Default enabled
const STOP_LOSS_TRIGGER_MINUTES = process.env.STOP_LOSS_TRIGGER_MINUTES ? Number(process.env.STOP_LOSS_TRIGGER_MINUTES) : 13;
const STOP_LOSS_PCT = process.env.STOP_LOSS_PCT ? Number(process.env.STOP_LOSS_PCT) : -30; // -30% loss
const SLIPPAGE_BPS = process.env.SLIPPAGE_BPS ? Number(process.env.SLIPPAGE_BPS) : 100; // 1%
const GAS_PRICE_GWEI = process.env.GAS_PRICE_GWEI ? String(process.env.GAS_PRICE_GWEI) : '0.005';
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || '1', 10);
const STRATEGY_MODE = (process.env.STRATEGY_MODE || 'dominant').toLowerCase();
const TRIGGER_PCT = process.env.TRIGGER_PCT ? Number(process.env.TRIGGER_PCT) : 60;
const TRIGGER_BAND = process.env.TRIGGER_BAND ? Number(process.env.TRIGGER_BAND) : 5;
const LOOKBACK_BLOCKS = parseInt(process.env.LOOKBACK_BLOCKS || '500000', 10);

const PRIVATE_KEYS = (process.env.PRIVATE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const CALC_SELL_DECIMALS = 8; // calcSellAmount returns values scaled by 1e8 per spec
const STATE_FILE = process.env.STATE_FILE || path.join('data', 'state.json');

// Logging files
const LOG_DIR = process.env.LOG_DIR || path.join('data', 'logs');
const TRADES_LOG = path.join(LOG_DIR, 'trades.jsonl');
const ACTIONS_LOG = path.join(LOG_DIR, 'actions.jsonl');
const ERRORS_LOG = path.join(LOG_DIR, 'errors.jsonl');
const ANALYTICS_FILE = path.join('data', 'analytics.json');

if (!RPC_URL) {
  console.error('RPC_URL is required');
  process.exit(1);
}
if (!PRICE_ORACLE_ID) {
  console.error('PRICE_ORACLE_ID is required');
  process.exit(1);
}
if (PRIVATE_KEYS.length === 0) {
  console.error('PRIVATE_KEYS is required (comma separated)');
  process.exit(1);
}

const MAX_GAS_ETH = process.env.MAX_GAS_ETH ? Number(process.env.MAX_GAS_ETH) : 0.015;
const MAX_GAS_WEI = (() => { try { return ethers.parseEther(String(MAX_GAS_ETH)); } catch { return ethers.parseEther('0.015'); } })();

// Dynamic gas overrides: caps total fee per tx to MAX_GAS_ETH by capping per-gas price
async function txOverrides(provider, gasLimit) {
  const ov = {};
  let gl = null;
  if (gasLimit != null) {
    try { gl = BigInt(gasLimit); ov.gasLimit = gl; } catch { gl = null; }
  }
  const fee = await provider.getFeeData();
  let suggested = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits(GAS_PRICE_GWEI, 'gwei');
  let priority = fee.maxPriorityFeePerGas ?? ethers.parseUnits('0.1', 'gwei');
  if (gl && gl > 0n) {
    const capPerGas = MAX_GAS_WEI / gl;
    if (suggested > capPerGas) suggested = capPerGas;
    if (priority > suggested) priority = suggested;
  }
  // Prefer EIP-1559 fields
  ov.maxFeePerGas = suggested;
  ov.maxPriorityFeePerGas = priority;
  return ov;
}

// In-memory state: per-user cost basis to compute PnL
const userState = new Map(); // key: wallet.address, value: { holding: { marketAddress, outcomeIndex, tokenId: bigint, amount: bigint, cost: bigint } | null, completedMarkets: Set<string> }

// ========= Enhanced Logging System =========
function appendLog(file, data) {
  try {
    ensureDirSync(path.dirname(file));
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...data
    }) + '\n';
    fs.appendFileSync(file, line);
  } catch (e) {
    console.error('Failed to write log:', e.message);
  }
}

function logTrade(wallet, market, action, data) {
  const entry = {
    wallet,
    market,
    action, // BUY, SELL
    ...data
  };
  appendLog(TRADES_LOG, entry);
  console.log(`💱 [${wallet.slice(0,8)}] TRADE ${action}:`, JSON.stringify(data));
}

function logAction(wallet, action, data) {
  const entry = {
    wallet,
    action, // APPROVAL, BALANCE_CHECK, TRIGGER_CHECK, etc.
    ...data
  };
  appendLog(ACTIONS_LOG, entry);
}

function logError(wallet, error, context) {
  const entry = {
    wallet,
    error: error.message || String(error),
    context,
    stack: error.stack
  };
  appendLog(ERRORS_LOG, entry);
  console.error(`❌ [${wallet.slice(0,8)}] ERROR:`, error.message || error);
}

// ========= Logging helpers with emojis =========
function logInfo(addr, emoji, msg) {
  console.log(`${emoji} [${addr}] ${msg}`);
}
function logWarn(addr, emoji, msg) {
  console.warn(`${emoji} [${addr}] ${msg}`);
}
function logErr(addr, emoji, msg, err) {
  const base = `${emoji} [${addr}] ${msg}`;
  if (err) console.error(base, err);
  else console.error(base);
}

function setHolding(addr, holding) {
  const prev = userState.get(addr) || {};
  userState.set(addr, { ...prev, holding });
  scheduleSave();
}
function getHolding(addr) {
  const st = userState.get(addr);
  return st ? st.holding : null;
}

function getCompletedMarkets(addr) {
  const st = userState.get(addr);
  return st && st.completedMarkets ? st.completedMarkets : new Set();
}
function markMarketCompleted(addr, marketAddress) {
  const prev = userState.get(addr) || {};
  const set = prev.completedMarkets || new Set();
  set.add(marketAddress.toLowerCase());
  userState.set(addr, { ...prev, completedMarkets: set });
  scheduleSave();
}

// ========= Persistence =========
function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function serializeState() {
  const out = {};
  for (const [addr, val] of userState.entries()) {
    out[addr] = {
      holding: val.holding ? {
        marketAddress: val.holding.marketAddress,
        outcomeIndex: val.holding.outcomeIndex,
        tokenId: val.holding.tokenId != null ? String(val.holding.tokenId) : null,
        amount: val.holding.amount != null ? String(val.holding.amount) : null,
        cost: val.holding.cost != null ? String(val.holding.cost) : null,
      } : null,
      completedMarkets: Array.from(val.completedMarkets || new Set())
    };
  }
  return out;
}

function deserializeState(obj) {
  const map = new Map();
  if (!obj || typeof obj !== 'object') return map;
  for (const addr of Object.keys(obj)) {
    const entry = obj[addr] || {};
    const holding = entry.holding ? {
      marketAddress: entry.holding.marketAddress,
      outcomeIndex: entry.holding.outcomeIndex,
      tokenId: entry.holding.tokenId != null ? BigInt(entry.holding.tokenId) : null,
      amount: entry.holding.amount != null ? BigInt(entry.holding.amount) : null,
      cost: entry.holding.cost != null ? BigInt(entry.holding.cost) : null,
    } : null;
    const completedMarkets = new Set((entry.completedMarkets || []).map(s => String(s).toLowerCase()))
    map.set(addr, { holding, completedMarkets });
  }
  return map;
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    try {
      ensureDirSync(path.dirname(STATE_FILE));
      const data = serializeState();
      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
      console.log(`💾 [STATE] Saved to ${STATE_FILE}`);
    } catch (e) {
      console.warn('⚠️ [STATE] Failed to save state:', e && e.message ? e.message : e);
    } finally {
      saveTimer = null;
    }
  }, 100);
}

function loadStateSync() {
  try {
    if (!fs.existsSync(STATE_FILE)) return new Map();
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    console.log(`📂 [STATE] Loaded from ${STATE_FILE}`);
    return deserializeState(obj);
  } catch (e) {
    console.warn('⚠️ [STATE] Failed to load state:', e && e.message ? e.message : e);
    return new Map();
  }
}

async function isContract(provider, address) {
  const code = await provider.getCode(address);
  return code && code !== '0x';
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function safeBalanceOf(erc1155, owner, tokenId) {
  try {
    return await erc1155.balanceOf(owner, tokenId);
  } catch (e) {
    return 0n;
  }
}

function fmtUnitsPrec(amount, decimals, precision = 4) {
  try {
    const s = ethers.formatUnits(amount, decimals);
    const n = parseFloat(s);
    if (Number.isNaN(n)) return s;
    return n.toFixed(precision);
  } catch (_) {
    return String(amount);
  }
}

async function fetchMarket() {
  const url = `https://api.limitless.exchange/markets/prophet?priceOracleId=${PRICE_ORACLE_ID}&frequency=${FREQUENCY}`;
  const res = await axios.get(url, { timeout: 15000 });

  // Debug logging
  console.log('📡 API Response:', {
    isActive: res.data.isActive,
    hasMarket: !!res.data.market,
    marketAddress: res.data.market?.address,
    marketTitle: res.data.market?.title
  });

  return res.data;
}

async function readAllowance(usdc, owner, spender) {
  // Try normal call, then staticCall as fallback
  try {
    return await usdc.allowance(owner, spender);
  } catch (e) {
    try {
      const fn = usdc.getFunction ? usdc.getFunction('allowance') : null;
      if (fn && fn.staticCall) {
        return await fn.staticCall(owner, spender);
      }
    } catch (_) {}
    throw e;
  }
}

function pickOutcome(prices) {
  // prices: [p0, p1]
  if (STRATEGY_MODE === 'dominant') {
    // Buy the side that is >= TRIGGER_PCT (choose the higher if both)
    const p0ok = prices[0] >= TRIGGER_PCT;
    const p1ok = prices[1] >= TRIGGER_PCT;
    if (p0ok || p1ok) return prices[0] >= prices[1] ? 0 : 1;
    return null;
  } else {
    // opposite mode: if a side is around TRIGGER_PCT within band, buy the opposite side
    const low = TRIGGER_PCT - TRIGGER_BAND;
    const high = TRIGGER_PCT + TRIGGER_BAND;
    if (prices[0] >= low && prices[0] <= high) return 1;
    if (prices[1] >= low && prices[1] <= high) return 0;
    return null;
  }
}

async function ensureUsdcApproval(wallet, usdc, marketAddress, needed) {
  // Always require a confirmed allowance read before buying
  let current;
  try {
    logInfo(wallet.address, '🔎', `Checking USDC allowance to market ${marketAddress} ...`);
    current = await readAllowance(usdc, wallet.address, marketAddress);
  } catch (e) {
    logWarn(wallet.address, '⚠️', `Allowance read failed. Will try to approve, then re-check. Details: ${(e && e.message) ? e.message : e}`);
    current = 0n;
  }
  if (current >= needed) return true;
  logInfo(wallet.address, '🔓', `Approving USDC ${needed} to ${marketAddress} ...`);
  // Some tokens require setting to 0 before non-zero
  if (current > 0n) {
    try {
      const gasEst0 = await estimateGasFor(usdc, wallet, 'approve', [marketAddress, 0n]);
      if (!gasEst0) { logWarn(wallet.address, '🛑', 'Gas estimate approve(0) failed; skipping approval.'); return false; }
      const pad0 = (gasEst0 * 120n) / 100n + 10000n;
      const ov0 = await txOverrides(wallet.provider, pad0);
      const tx0 = await usdc.approve(marketAddress, 0n, ov0);
      logInfo(wallet.address, '🧾', `approve(0) tx: ${tx0.hash}`);
      await tx0.wait(CONFIRMATIONS);
    } catch (e) {
      logErr(wallet.address, '💥', 'approve(0) failed', (e && e.message) ? e.message : e);
      return false;
    }
  }
  try {
    const gasEst1 = await estimateGasFor(usdc, wallet, 'approve', [marketAddress, needed]);
    if (!gasEst1) { logWarn(wallet.address, '🛑', 'Gas estimate approve failed; skipping approval.'); return false; }
    const pad1 = (gasEst1 * 120n) / 100n + 10000n;
    const ov1 = await txOverrides(wallet.provider, pad1);
    const tx = await usdc.approve(marketAddress, needed, ov1);
    logInfo(wallet.address, '🧾', `approve tx: ${tx.hash}`);
    await tx.wait(CONFIRMATIONS);
  } catch (e) {
    // Fallback: try increaseAllowance if approve fails (some tokens prefer increasing)
    logWarn(wallet.address, '⚠️', `approve failed, trying increaseAllowance. Details: ${(e && e.message) ? e.message : e}`);
    try {
      const gasEst2 = await estimateGasFor(usdc, wallet, 'increaseAllowance', [marketAddress, needed]);
      if (!gasEst2) { logWarn(wallet.address, '🛑', 'Gas estimate increaseAllowance failed; skipping approval.'); return false; }
      const pad2 = (gasEst2 * 120n) / 100n + 10000n;
      const ov2 = await txOverrides(wallet.provider, pad2);
      const tx2 = await usdc.increaseAllowance(marketAddress, needed, ov2);
      logInfo(wallet.address, '🧾', `increaseAllowance tx: ${tx2.hash}`);
      await tx2.wait(CONFIRMATIONS);
    } catch (e2) {
      logErr(wallet.address, '💥', 'increaseAllowance also failed', (e2 && e2.message) ? e2.message : e2);
      return false;
    }
  }
  // Re-check allowance to confirm
  try {
    const after = await readAllowance(usdc, wallet.address, marketAddress);
    const ok = after >= needed;
    logInfo(wallet.address, ok ? '✅' : '⚠️', `Allowance after approve: ${after.toString()} (need ${needed.toString()})`);
    return ok;
  } catch (e) {
    logWarn(wallet.address, '⚠️', `Allowance re-check failed. Skipping buy this tick. Details: ${(e && e.message) ? e.message : e}`);
    return false;
  }
}

async function ensureErc1155Approval(wallet, erc1155, operator) {
  // Try to read approval state up to 3 times
  for (let i = 0; i < 3; i++) {
    try {
      logInfo(wallet.address, '🔎', `Checking ERC1155 isApprovedForAll(${wallet.address}, ${operator}) ...`);
      const approved = await erc1155.isApprovedForAll(wallet.address, operator);
      if (approved) return true; // already approved
      break; // definite false -> proceed to approve
    } catch (e) {
      logWarn(wallet.address, '⚠️', `isApprovedForAll read failed (attempt ${i + 1}/3): ${(e && e.message) ? e.message : e}`);
      await delay(400);
    }
  }
  // Estimate gas for setApprovalForAll; if estimate fails, skip
  const gasEst = await estimateGasFor(erc1155, wallet, 'setApprovalForAll', [operator, true]);
  if (!gasEst) {
    logWarn(wallet.address, '🛑', 'Gas estimate setApprovalForAll failed; skipping approval this tick.');
    return false;
  }
  logInfo(wallet.address, '⛽', `Gas estimate setApprovalForAll: ${gasEst}`);
  const padded = (gasEst * 120n) / 100n + 10000n;
  try {
    logInfo(wallet.address, '🔓', `Setting ERC1155 setApprovalForAll(${operator}, true) ...`);
    const ov = await txOverrides(wallet.provider, padded);
    const tx = await erc1155.setApprovalForAll(operator, true, ov);
    logInfo(wallet.address, '🧾', `setApprovalForAll tx: ${tx.hash}`);
    await tx.wait(CONFIRMATIONS);
  } catch (e) {
    logWarn(wallet.address, '🛑', `setApprovalForAll send failed; skipping approval this tick. Details: ${(e && e.message) ? e.message : e}`);
    return false;
  }
  // Confirm state once after tx
  try {
    const ok = await erc1155.isApprovedForAll(wallet.address, operator);
    return !!ok;
  } catch (_) {
    // Best-effort
    return true;
  }
}

async function estimateReturnForSellAll(market, outcomeIndex, tokenBalance, collateralDecimals) {
  // We need to find max returnAmount s.t. calcSellAmount(returnAmount, outcomeIndex, maxOutcomeTokensToSell=tokenBalance) <= tokenBalance.
  // Exponential search for upper bound, then binary search.
  const one = 1n;
  const unit = 10n ** BigInt(collateralDecimals);
  let low = 0n;
  let high = unit; // start with 1 unit of collateral

  const need = async (ret) => {
    try {
      return await market.calcSellAmount(ret, outcomeIndex);
    } catch (e) {
      return null;
    }
  };

  // grow high until tokens needed exceed our balance, or cap at some large value
  for (let i = 0; i < 40; i++) {
    const needed = await need(high);
    if (needed === null) break;
    if (needed > tokenBalance) break;
    low = high;
    high = high * 2n;
  }

  // binary search between low and high
  for (let i = 0; i < 50; i++) {
    const mid = (low + high) / 2n;
    const needed = await need(mid);
    if (needed !== null && needed <= tokenBalance) {
      low = mid + one;
    } else {
      high = mid - one;
    }
    if (high < low) break;
  }
  // 'high' is the last value that failed, so best feasible is high
  // But after loop condition, best feasible is low-1
  const best = low - 1n;
  return best < 0n ? 0n : best;
}

// Note: We removed event-based cost reconstruction to avoid RPC filter errors.

async function estimateGasFor(contract, wallet, fnName, args) {
  try {
    const data = contract.interface.encodeFunctionData(fnName, args);
    const gas = await wallet.provider.estimateGas({
      from: wallet.address,
      to: contract.target,
      data
    });
    return gas;
  } catch (e) {
    console.error(e)
    return null;
  }
}

async function runForWallet(wallet, provider) {
  logInfo(wallet.address, '🚀', 'Worker started');
  logAction(wallet.address, 'WORKER_START', {});
  let lastMarketAddr = null;
  let cachedContracts = null;

  async function tick() {
    try {
      logAction(wallet.address, 'TICK_START', {});

      const data = await fetchMarket();

      // Debug: Log full response
      console.log('🔍 Full API response:', JSON.stringify(data, null, 2));

      // Check for various failure conditions
      if (!data || !data.market) {
        logWarn(wallet.address, '⏸️', 'No market data returned from API');
        logAction(wallet.address, 'MARKET_MISSING', { data });
        return;
      }

      if (!data.isActive) {
        logWarn(wallet.address, '⏸️', `Market inactive: ${data.market.title || 'Unknown'}`);
        logAction(wallet.address, 'MARKET_INACTIVE', { marketTitle: data.market.title });
        return;
      }

      if (!data.market.address) {
        logWarn(wallet.address, '⏳', `Market not yet deployed on-chain: ${data.market.title || 'Unknown'} - address is: ${data.market.address}`);
        logAction(wallet.address, 'MARKET_NOT_DEPLOYED', { marketTitle: data.market.title, address: data.market.address });
        return;
      }

      const marketInfo = data.market;
      // Log market title to console for visibility
      if (marketInfo && marketInfo.title) {
        logInfo(wallet.address, '📰', `Market: ${marketInfo.title}`);
      }
      const marketAddress = ethers.getAddress(marketInfo.address);

      logAction(wallet.address, 'MARKET_FETCH', {
        market: marketAddress,
        title: marketInfo.title,
        isActive: data.isActive,
        prices: marketInfo.prices
      });
      const prices = marketInfo.prices || [];
      const positionIds = marketInfo.positionIds || [];
      const collateralTokenAddress = ethers.getAddress(marketInfo.collateralToken.address);

      // Pre-compute timing guardrails for buying
      const nowMs = Date.now();
      let tooNewForBet = false;
      let nearDeadlineForBet = false;
      if (marketInfo.createdAt) {
        const createdMs = new Date(marketInfo.createdAt).getTime();
        if (!Number.isNaN(createdMs)) {
          const ageMs = nowMs - createdMs;
          const ageMin = Math.max(0, Math.floor(ageMs / 60000));
          if (ageMs < 10 * 60 * 1000) {
            tooNewForBet = true;
            logInfo(wallet.address, '⏳', `Market age ${ageMin}m < 10m — skip betting`);
            logAction(wallet.address, 'SKIP_TOO_NEW', { market: marketAddress, ageMinutes: ageMin });
          }
        }
      }
      if (marketInfo.deadline) {
        const deadlineMs = new Date(marketInfo.deadline).getTime();
        if (!Number.isNaN(deadlineMs)) {
          const remainingMs = deadlineMs - nowMs;
          const remainingMin = Math.max(0, Math.floor(remainingMs / 60000));
          if (remainingMs < 5 * 60 * 1000) {
            nearDeadlineForBet = true;
            logAction(wallet.address, 'SKIP_NEAR_DEADLINE', { market: marketAddress, remainingMinutes: remainingMin });
            const remMin = Math.max(0, Math.floor(remainingMs / 60000));
            logInfo(wallet.address, '⏳', `Time to deadline ${remMin}m < 5m — skip betting`);
          }
        }
      }

      if (lastMarketAddr !== marketAddress || !cachedContracts) {
        // Attach contracts directly to the wallet (signer) for ethers v6 compatibility
        const market = new ethers.Contract(marketAddress, MARKET_ABI, wallet);
        const usdc = new ethers.Contract(collateralTokenAddress, ERC20_ABI, wallet);
        // Use market.conditionalTokens() to get ERC1155 address
        const conditionalTokensAddress = await market.conditionalTokens();
        const erc1155 = new ethers.Contract(ethers.getAddress(conditionalTokensAddress), ERC1155_ABI, wallet);
        const decimals = Number(await usdc.decimals());
        // Sanity: verify contracts have code
        const [marketHasCode, usdcHasCode] = await Promise.all([
          isContract(provider, marketAddress),
          isContract(provider, collateralTokenAddress)
        ]);
        if (!marketHasCode) {
          logErr(wallet.address, '❌', `Market address has no code on this chain: ${marketAddress}`);
          return;
        }
        if (!usdcHasCode) {
          logErr(wallet.address, '❌', `USDC address has no code on this chain: ${collateralTokenAddress}. Check RPC/network.`);
          return;
        }
        cachedContracts = { market, usdc, erc1155, decimals };
        lastMarketAddr = marketAddress;
        logInfo(wallet.address, '🧩', `Loaded contracts: market=${marketAddress}, usdc=${collateralTokenAddress}, erc1155=${conditionalTokensAddress}, usdcDecimals=${decimals}`);
      }

      const { market, usdc, erc1155, decimals } = cachedContracts;

      // Check if user already holds any position (either outcome token)
      const localHolding = getHolding(wallet.address);
      const localHoldingThisMarket = localHolding && localHolding.marketAddress === marketAddress ? localHolding : null;
      const pid0 = positionIds[0] ? BigInt(positionIds[0]) : null;
      const pid1 = positionIds[1] ? BigInt(positionIds[1]) : null;

      let bal0 = 0n, bal1 = 0n;
      if (pid0 !== null) {
        bal0 = await safeBalanceOf(erc1155, wallet.address, pid0);
      }
      if (pid1 !== null) {
        bal1 = await safeBalanceOf(erc1155, wallet.address, pid1);
      }
      logInfo(wallet.address, '🎟️', `Positions: pid0=${pid0 ?? 'null'} bal0=${bal0} | pid1=${pid1 ?? 'null'} bal1=${bal1}`);
      const hasOnchain = (bal0 > 0n) || (bal1 > 0n);
      const hasAny = hasOnchain || !!localHoldingThisMarket;
      if (hasAny) {
        // Determine which outcome is held, then ensure we have cost basis
        let outcomeIndex = null;
        let tokenId = null;
        let tokenBalance = 0n;
        if (bal0 > 0n) { outcomeIndex = 0; tokenId = pid0; tokenBalance = bal0; }
        if (bal1 > 0n) { outcomeIndex = 1; tokenId = pid1; tokenBalance = bal1; }

        // Initialize cost basis from env if missing
        let holding = localHoldingThisMarket;
        if (!holding || holding.tokenId !== tokenId) {
          const assumedCost = ethers.parseUnits(BUY_AMOUNT_USDC.toString(), decimals);
          holding = { marketAddress, outcomeIndex, tokenId, amount: tokenBalance, cost: assumedCost };
          setHolding(wallet.address, holding);
          logInfo(wallet.address, '💾', `Initialized cost basis from env: ${BUY_AMOUNT_USDC} USDC (tokenId=${tokenId})`);
        }

        // Position value per provided formula:
        // tokensNeededForCost = calcSellAmount(initialInvestment, outcomeIndex)
        // positionValue = (balance / tokensNeededForCost) * initialInvestment
        const cost = holding.cost; // initial investment in collateral units
        let tokensNeededForCost;
        try {
          tokensNeededForCost = await market.calcSellAmount(cost, outcomeIndex);
        } catch (e) {
          logErr(wallet.address, '💥', 'calcSellAmount(cost) failed for value calc', e && e.message ? e.message : e);
          return;
        }
        if (tokensNeededForCost === 0n) {
          logWarn(wallet.address, '⚠️', 'calcSellAmount returned 0 for cost; skipping PnL calc this tick.');
          return;
        }
        const positionValue = (tokenBalance * cost) / tokensNeededForCost; // floor
        const pnlAbs = positionValue - cost; // signed
        const pnlPct = cost > 0n ? Number((pnlAbs * 10000n) / cost) / 100 : 0;
        const signEmoji = pnlAbs >= 0n ? '🔺' : '🔻';
        const valueHuman = fmtUnitsPrec(positionValue, decimals, 4);
        const costHuman = fmtUnitsPrec(cost, decimals, 4);
        const pnlAbsHuman = fmtUnitsPrec(pnlAbs >= 0n ? pnlAbs : -pnlAbs, decimals, 4);
        logInfo(wallet.address, '📈', `Holding tokenId=${tokenId} balance=${tokenBalance} positionValue=${valueHuman} USDC cost=${costHuman} USDC PnL≈${pnlPct.toFixed(2)}% ${signEmoji} ${pnlAbsHuman} USDC`);

        logAction(wallet.address, 'POSITION_VALUE', {
          market: marketAddress,
          outcomeIndex,
          tokenBalance: tokenBalance.toString(),
          positionValue: positionValue.toString(),
          cost: cost.toString(),
          pnlPct,
          pnlUSDC: Number(ethers.formatUnits(pnlAbs >= 0n ? pnlAbs : -pnlAbs, decimals))
        });

        // Calculate time remaining for stop loss check
        let shouldSellStopLoss = false;
        if (STOP_LOSS_ENABLED && marketInfo.deadline) {
          const deadlineMs = new Date(marketInfo.deadline).getTime();
          if (!Number.isNaN(deadlineMs)) {
            const remainingMs = deadlineMs - nowMs;
            const remainingMin = Math.max(0, Math.floor(remainingMs / 60000));

            // Stop loss: activate in last X minutes if losing money
            if (remainingMin <= STOP_LOSS_TRIGGER_MINUTES && pnlPct <= STOP_LOSS_PCT) {
              shouldSellStopLoss = true;
              logAction(wallet.address, 'STOP_LOSS_TRIGGER', {
                market: marketAddress,
                reason: 'STOP_LOSS',
                pnlPct,
                stopLossPct: STOP_LOSS_PCT,
                remainingMinutes: remainingMin,
                triggerMinutes: STOP_LOSS_TRIGGER_MINUTES
              });
              logWarn(wallet.address, '🛑', `STOP LOSS: ${remainingMin}m left, ${pnlPct.toFixed(2)}% loss - selling to preserve capital`);
            }
          }
        }

        if (shouldSellStopLoss || (pnlAbs > 0n && pnlPct >= TARGET_PROFIT_PCT)) {
          if (!shouldSellStopLoss) {
            logAction(wallet.address, 'SELL_TRIGGER', {
              market: marketAddress,
              reason: 'TARGET_PROFIT',
              pnlPct,
              targetPct: TARGET_PROFIT_PCT
            });
          }
          const approvedOk = await ensureErc1155Approval(wallet, erc1155, marketAddress);
          if (!approvedOk) {
            logWarn(wallet.address, '🛑', 'Approval not confirmed; skipping sell this tick.');
            return;
          }
          // Only proceed if gas estimation works
          // Per spec: sell with maxOutcomeTokensToSell == balance; returnAmount reduced by 1% fee safety
          const maxOutcomeTokensToSell = tokenBalance;
          const returnAmountForSell = positionValue - (positionValue / 100n); // minus 1% safety
          const gasEst = await estimateGasFor(market, wallet, 'sell', [returnAmountForSell, outcomeIndex, maxOutcomeTokensToSell]);
          if (!gasEst) {
            logWarn(wallet.address, '🛑', 'Gas estimate sell failed; skipping sell this tick.');
            return;
          }
          logInfo(wallet.address, '⛽', `Gas estimate sell: ${gasEst}`);
          const padded = (gasEst * 120n) / 100n + 10000n;
          const sellOv = await txOverrides(wallet.provider, padded);
          const tx = await market.sell(returnAmountForSell, outcomeIndex, maxOutcomeTokensToSell, sellOv);
          logInfo(wallet.address, '🧾', `Sell tx: ${tx.hash}`);
          await tx.wait(CONFIRMATIONS);
          logInfo(wallet.address, '✅', 'Sell completed.');

          logTrade(wallet.address, marketAddress, 'SELL', {
            outcomeIndex,
            tokensSold: maxOutcomeTokensToSell.toString(),
            returnAmount: returnAmountForSell.toString(),
            cost: cost.toString(),
            positionValue: positionValue.toString(),
            pnlPct,
            pnlUSDC: Number(ethers.formatUnits(pnlAbs, decimals)),
            reason: shouldSellStopLoss ? 'STOP_LOSS' : 'TARGET_PROFIT',
            txHash: tx.hash
          });

          setHolding(wallet.address, null);
          markMarketCompleted(wallet.address, marketAddress);
          logInfo(wallet.address, '🧭', `Market ${marketAddress} marked as completed; will not buy again in this run.`);
          return;
        }

        // Already holding; do not buy more
        logInfo(wallet.address, '🛑', 'Already holding a position. Skipping buy.');
        return;
      }

      // Not holding any position -> maybe buy per strategy
      if (!Array.isArray(prices) || prices.length < 2) {
        logWarn(wallet.address, '⚠️', 'Prices unavailable; skipping.');
        return;
      }

      // Do not re-enter a market once completed (bought & sold) in this run
      const completed = getCompletedMarkets(wallet.address);
      if (completed.has(marketAddress.toLowerCase())) {
        logInfo(wallet.address, '🧭', `Market ${marketAddress} previously completed; skipping buy.`);
        return;
      }

      // Additional guardrails for betting:
      const positionIdsValid = Array.isArray(positionIds) && positionIds.length >= 2 && positionIds[0] && positionIds[1];
      if (!positionIdsValid) {
        logWarn(wallet.address, '🛑', 'Position IDs missing/invalid — skip betting');
        return;
      }
      if (tooNewForBet || nearDeadlineForBet) {
        // Reasons already logged above
        return;
      }

      const outcomeToBuy = pickOutcome(prices);
      if (outcomeToBuy === null) {
        logInfo(wallet.address, '🔎', `No trigger (mode=${STRATEGY_MODE}, prices=${prices.join(', ')}).`);
        logAction(wallet.address, 'NO_TRIGGER', {
          market: marketAddress,
          mode: STRATEGY_MODE,
          prices,
          triggerPct: TRIGGER_PCT,
          triggerBand: TRIGGER_BAND
        });
        return;
      }

      logAction(wallet.address, 'BUY_TRIGGER', {
        market: marketAddress,
        outcomeIndex: outcomeToBuy,
        price: prices[outcomeToBuy],
        mode: STRATEGY_MODE
      });

      const investmentHuman = BUY_AMOUNT_USDC;
      const investment = ethers.parseUnits(investmentHuman.toString(), decimals);

      // Check USDC balance sufficient for bet
      const usdcBal = await usdc.balanceOf(wallet.address);
      const usdcBalHuman = ethers.formatUnits(usdcBal, decimals);
      const needHuman = ethers.formatUnits(investment, decimals);
      logInfo(wallet.address, '💰', `USDC balance=${usdcBalHuman}, need=${needHuman} for buy`);
      if (usdcBal < investment) {
        logWarn(wallet.address, '⚠️', `Saldo USDC tidak cukup untuk bet. Dibutuhkan ${needHuman}, saldo ${usdcBalHuman}.`);
        return;
      }

      // Ensure USDC allowance
      const allowanceOk = await ensureUsdcApproval(wallet, usdc, marketAddress, investment);
      if (!allowanceOk) {
        logWarn(wallet.address, '🛑', 'Allowance not confirmed. Skip buy this tick.');
        return;
      }

      // Compute minOutcomeTokensToBuy via calcBuyAmount and slippage
      const expectedTokens = await market.calcBuyAmount(investment, outcomeToBuy);
      const minOutcomeTokensToBuy = expectedTokens - (expectedTokens * BigInt(SLIPPAGE_BPS)) / 10000n;
      logInfo(wallet.address, '🛒', `Trigger hit (mode=${STRATEGY_MODE}). Buying outcome=${outcomeToBuy} invest=${investment} minTokens=${minOutcomeTokensToBuy}`);

      // Estimate gas then buy
      const gasEst = await estimateGasFor(market, wallet, 'buy', [investment, outcomeToBuy, minOutcomeTokensToBuy]);
      if (!gasEst) {
        logWarn(wallet.address, '🛑', 'Gas estimate buy failed; skipping buy this tick.');
        return;
      }
      logInfo(wallet.address, '⛽', `Gas estimate buy: ${gasEst}`);
      const padded = (gasEst * 120n) / 100n + 10000n;
      const buyOv = await txOverrides(wallet.provider, padded);
      const buyTx = await market.buy(investment, outcomeToBuy, minOutcomeTokensToBuy, buyOv);
      logInfo(wallet.address, '🧾', `Buy tx: ${buyTx.hash}`);
      const receipt = await buyTx.wait(CONFIRMATIONS);
      logInfo(wallet.address, '✅', `Buy completed in block ${receipt.blockNumber}`);

      const tokenId = outcomeToBuy === 0 ? pid0 : pid1;

      logTrade(wallet.address, marketAddress, 'BUY', {
        outcomeIndex: outcomeToBuy,
        investment: investment.toString(),
        investmentUSDC: Number(ethers.formatUnits(investment, decimals)),
        expectedTokens: expectedTokens.toString(),
        minTokens: minOutcomeTokensToBuy.toString(),
        price: prices[outcomeToBuy],
        txHash: buyTx.hash,
        blockNumber: receipt.blockNumber
      });

      // After buy, record cost basis
      setHolding(wallet.address, {
        marketAddress,
        outcomeIndex: outcomeToBuy,
        tokenId,
        amount: investment,
        cost: investment
      });
      // Try to confirm on-chain ERC1155 balance right away (best-effort)
      // Try to confirm on-chain ERC1155 balance right away (best-effort with retries)
      try {
        let balNow = 0n;
        for (let i = 0; i < 3; i++) {
          balNow = await safeBalanceOf(erc1155, wallet.address, tokenId);
          if (balNow > 0n) break;
          await delay(1000);
        }
        logInfo(wallet.address, '🎟️', `Position balance after buy: ${balNow}`);
      } catch (e) {
        logWarn(wallet.address, '⚠️', `Failed to read position balance after buy: ${(e && e.message) ? e.message : e}`);
      }
    } catch (err) {
      logErr(wallet.address, '💥', 'Error in tick:', err && err.message ? err.message : err);
      logError(wallet.address, err, { action: 'TICK_ERROR' });
    }
  }

  // initial tick immediately, then interval
  await tick();
  return setInterval(tick, POLL_INTERVAL_MS);
}

async function main() {
  console.log('🚀 Starting Limitless bot on Base...');
  console.log('');
  console.log('⚙️  Configuration:');
  console.log(`   💰 Buy amount: ${BUY_AMOUNT_USDC} USDC`);
  console.log(`   📈 Target profit: ${TARGET_PROFIT_PCT}%`);
  console.log(`   🛑 Stop loss: ${STOP_LOSS_ENABLED ? `Enabled (${STOP_LOSS_PCT}% loss in last ${STOP_LOSS_TRIGGER_MINUTES} min)` : 'Disabled'}`);
  console.log(`   🎯 Strategy: ${STRATEGY_MODE} (trigger: ${TRIGGER_PCT}%)`);
  console.log('');
  console.log('📁 Logging to:');
  console.log(`   📊 Trades: ${TRADES_LOG}`);
  console.log(`   🔄 Actions: ${ACTIONS_LOG}`);
  console.log(`   ❌ Errors: ${ERRORS_LOG}`);
  console.log(`   📈 Analytics: ${ANALYTICS_FILE}`);
  console.log('');

  // Ensure log directories exist
  ensureDirSync(LOG_DIR);

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // Verify connected chain
  try {
    const net = await provider.getNetwork();
    logInfo('GLOBAL', '🌐', `Connected to chainId=${net.chainId} (${net.name || 'unknown'})`);
    if (Number(net.chainId) !== CHAIN_ID) {
      logErr('GLOBAL', '❌', `Wrong network. Expected chainId=${CHAIN_ID} but connected to ${net.chainId}. Update RPC_URL/CHAIN_ID.`);
      process.exit(1);
    }
  } catch (e) {
    logErr('GLOBAL', '💥', 'Failed to fetch network from RPC_URL', e && e.message ? e.message : e);
    process.exit(1);
  }

  const wallets = PRIVATE_KEYS.map(pkRaw => {
    const pk = pkRaw.startsWith('0x') ? pkRaw : '0x' + pkRaw;
    const wallet = new ethers.Wallet(pk, provider);
    return wallet;
  });

  // Load persisted state (if any) before initializing wallets
  const persisted = loadStateSync();

  for (const w of wallets) {
    logInfo(w.address, '🔑', `Loaded wallet`);
    // init user state
    const existing = persisted.get(w.address);
    if (existing) {
      userState.set(w.address, {
        holding: existing.holding || null,
        completedMarkets: existing.completedMarkets || new Set()
      });
      logInfo(w.address, '📂', `State restored: holding=${existing.holding ? 'yes' : 'no'}, completedMarkets=${(existing.completedMarkets || new Set()).size}`);
    } else {
      userState.set(w.address, { holding: null, completedMarkets: new Set() });
    }
  }

  const timers = [];
  for (const w of wallets) {
    const timer = await runForWallet(w, provider);
    timers.push(timer);
  }

  process.on('SIGINT', () => {
    console.log('👋 Shutting down...');
    timers.forEach(t => clearInterval(t));
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
function scaleToCalcSell(amount, tokenDecimals) {
  const d = BigInt(tokenDecimals);
  const target = BigInt(CALC_SELL_DECIMALS);
  if (d === target) return amount;
  if (d < target) return amount * (10n ** (target - d));
  return amount / (10n ** (d - target));
}

// ========= Analytics Generation =========
function generateAnalytics() {
  try {
    ensureDirSync(path.dirname(ANALYTICS_FILE));

    // Read trades log
    const trades = [];
    if (fs.existsSync(TRADES_LOG)) {
      const lines = fs.readFileSync(TRADES_LOG, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          trades.push(JSON.parse(line));
        } catch (e) {}
      }
    }

    const buys = trades.filter(t => t.action === 'BUY');
    const sells = trades.filter(t => t.action === 'SELL');

    const analytics = {
      generatedAt: new Date().toISOString(),
      summary: {
        totalBuys: buys.length,
        totalSells: sells.length,
        totalPnL: sells.reduce((sum, s) => sum + (s.pnlUSDC || 0), 0),
        avgPnLPct: sells.length > 0 ? sells.reduce((sum, s) => sum + (s.pnlPct || 0), 0) / sells.length : 0,
        winRate: sells.length > 0 ? (sells.filter(s => s.pnlUSDC > 0).length / sells.length * 100).toFixed(2) + '%' : '0%'
      },
      recentTrades: trades.slice(-20).reverse(),
      sellsByOutcome: {
        outcome0: sells.filter(s => s.outcomeIndex === 0).length,
        outcome1: sells.filter(s => s.outcomeIndex === 1).length
      }
    };

    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analytics, null, 2));
    console.log('📊 Analytics generated:', ANALYTICS_FILE);
  } catch (e) {
    console.error('Failed to generate analytics:', e.message);
  }
}

// Run analytics every 5 minutes
setInterval(generateAnalytics, 5 * 60 * 1000);
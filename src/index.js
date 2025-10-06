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
const PRICE_ORACLE_IDS = (process.env.PRICE_ORACLE_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const FREQUENCY = process.env.FREQUENCY || 'hourly';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);
const BUY_AMOUNT_USDC = process.env.BUY_AMOUNT_USDC ? Number(process.env.BUY_AMOUNT_USDC) : 5; // human units
const TARGET_PROFIT_PCT = process.env.TARGET_PROFIT_PCT ? Number(process.env.TARGET_PROFIT_PCT) : 20; // 20%
const SLIPPAGE_BPS = process.env.SLIPPAGE_BPS ? Number(process.env.SLIPPAGE_BPS) : 100; // 1%
const GAS_PRICE_GWEI = process.env.GAS_PRICE_GWEI ? String(process.env.GAS_PRICE_GWEI) : '0.005';
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || '1', 10);
const STRATEGY_MODE = (process.env.STRATEGY_MODE || 'dominant').toLowerCase();
const TRIGGER_PCT = process.env.TRIGGER_PCT ? Number(process.env.TRIGGER_PCT) : 60;
const TRIGGER_BAND = process.env.TRIGGER_BAND ? Number(process.env.TRIGGER_BAND) : 5;
const LOOKBACK_BLOCKS = parseInt(process.env.LOOKBACK_BLOCKS || '500000', 10);

const PRIVATE_KEYS = (process.env.PRIVATE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const STATE_FILE = process.env.STATE_FILE || path.join('data', 'state.json');

if (!RPC_URL) {
  console.error('RPC_URL is required');
  process.exit(1);
}
if (PRICE_ORACLE_IDS.length === 0) {
  console.error('PRICE_ORACLE_ID is required (comma separated for multiple markets)');
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
// Updated for multi-market: holdings is now an array of positions
const userState = new Map(); // key: wallet.address, value: { holdings: [{ marketAddress, outcomeIndex, tokenId: bigint, amount: bigint, cost: bigint }], completedMarkets: Set<string> }

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

function addHolding(addr, holding) {
  const prev = userState.get(addr) || { holdings: [], completedMarkets: new Set() };
  const holdings = prev.holdings || [];
  // Remove any existing holding for same market before adding new one
  const filtered = holdings.filter(h => h.marketAddress.toLowerCase() !== holding.marketAddress.toLowerCase());
  filtered.push(holding);
  userState.set(addr, { ...prev, holdings: filtered });
  scheduleSave();
}
function removeHolding(addr, marketAddress) {
  const prev = userState.get(addr) || { holdings: [], completedMarkets: new Set() };
  const holdings = prev.holdings || [];
  const filtered = holdings.filter(h => h.marketAddress.toLowerCase() !== marketAddress.toLowerCase());
  userState.set(addr, { ...prev, holdings: filtered });
  scheduleSave();
}
function getHolding(addr, marketAddress) {
  const st = userState.get(addr);
  if (!st || !st.holdings) return null;
  return st.holdings.find(h => h.marketAddress.toLowerCase() === marketAddress.toLowerCase()) || null;
}
function getAllHoldings(addr) {
  const st = userState.get(addr);
  return st && st.holdings ? st.holdings : [];
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
      holdings: (val.holdings || []).map(h => ({
        marketAddress: h.marketAddress,
        outcomeIndex: h.outcomeIndex,
        tokenId: h.tokenId != null ? String(h.tokenId) : null,
        amount: h.amount != null ? String(h.amount) : null,
        cost: h.cost != null ? String(h.cost) : null,
      })),
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
    // Support both old format (single holding) and new format (multiple holdings array)
    let holdings = [];
    if (entry.holdings && Array.isArray(entry.holdings)) {
      holdings = entry.holdings.map(h => ({
        marketAddress: h.marketAddress,
        outcomeIndex: h.outcomeIndex,
        tokenId: h.tokenId != null ? BigInt(h.tokenId) : null,
        amount: h.amount != null ? BigInt(h.amount) : null,
        cost: h.cost != null ? BigInt(h.cost) : null,
      }));
    } else if (entry.holding) {
      // Backward compatibility: convert old single holding to array
      holdings = [{
        marketAddress: entry.holding.marketAddress,
        outcomeIndex: entry.holding.outcomeIndex,
        tokenId: entry.holding.tokenId != null ? BigInt(entry.holding.tokenId) : null,
        amount: entry.holding.amount != null ? BigInt(entry.holding.amount) : null,
        cost: entry.holding.cost != null ? BigInt(entry.holding.cost) : null,
      }];
    }
    const completedMarkets = new Set((entry.completedMarkets || []).map(s => String(s).toLowerCase()));
    map.set(addr, { holdings, completedMarkets });
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
  try {
    const code = await provider.getCode(address);
    return code && code !== '0x';
  } catch (e) {
    console.warn(`⚠️ Failed to check if ${address} is contract:`, e?.message || e);
    return false;
  }
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// Retry helper for RPC calls with exponential backoff
async function retryRpcCall(fn, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isLastAttempt = attempt === maxRetries - 1;
      const isRpcError = e?.code === 'CALL_EXCEPTION' || e?.message?.includes('missing revert data') || e?.message?.includes('rate limit');

      if (isLastAttempt || !isRpcError) {
        throw e;
      }

      const delayMs = baseDelay * Math.pow(2, attempt);
      console.warn(`⚠️ RPC call failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms:`, e?.message || e);
      await delay(delayMs);
    }
  }
}

async function safeBalanceOf(erc1155, owner, tokenId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await erc1155.balanceOf(owner, tokenId);
    } catch (e) {
      if (attempt === 2) {
        console.warn(`⚠️ Failed to read balance after 3 attempts:`, e?.message || e);
        return 0n;
      }
      await delay(500 * (attempt + 1)); // Exponential backoff: 500ms, 1000ms, 1500ms
    }
  }
  return 0n;
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

async function fetchMarkets() {
  // Fetch all markets for all oracle IDs in parallel
  const promises = PRICE_ORACLE_IDS.map(async (oracleId) => {
    try {
      const url = `https://api.limitless.exchange/markets/prophet?priceOracleId=${oracleId}&frequency=${FREQUENCY}`;
      const res = await axios.get(url, { timeout: 15000 });
      return res.data;
    } catch (e) {
      console.warn(`⚠️ Failed to fetch market for oracle ${oracleId}:`, e?.message || e);
      return null;
    }
  });
  const results = await Promise.all(promises);
  const markets = results.filter(Boolean); // Filter out failed fetches

  // Deduplicate by market address (in case same market comes from multiple oracles)
  const seen = new Map();
  const unique = [];
  for (const market of markets) {
    if (market && market.market && market.market.address) {
      const addr = market.market.address.toLowerCase();
      if (!seen.has(addr)) {
        seen.set(addr, true);
        unique.push(market);
      }
    } else {
      unique.push(market); // Keep markets without address
    }
  }
  return unique;
}

async function readAllowance(usdc, owner, spender) {
  // Try with retry and fallback
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await usdc.allowance(owner, spender);
    } catch (e) {
      if (attempt < 2) {
        await delay(1000 * (attempt + 1));
        continue;
      }
      // Last attempt: try staticCall fallback
      try {
        const fn = usdc.getFunction ? usdc.getFunction('allowance') : null;
        if (fn && fn.staticCall) {
          return await fn.staticCall(owner, spender);
        }
      } catch (_) {}
      throw e;
    }
  }
  return 0n; // Fallback
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
  let cachedContracts = new Map(); // marketAddress -> { market, usdc, erc1155, decimals }
  let lastApprovalHour = -1; // Track which hour we last pre-approved
  let buyingInProgress = new Set(); // Track markets currently being bought in this tick to prevent duplicates

  async function tick() {
    buyingInProgress.clear(); // Clear at start of each tick
    try {
      logInfo(wallet.address, '🔄', `Polling market data (oracles=[${PRICE_ORACLE_IDS.join(', ')}], freq=${FREQUENCY})...`);
      const allMarketsData = await fetchMarkets();

      if (!allMarketsData || allMarketsData.length === 0) {
        logWarn(wallet.address, '⏸️', `No active markets found`);
        return;
      }

      logInfo(wallet.address, '📡', `Fetched ${allMarketsData.length} market(s)`);

      // Process each market with delay between them to avoid rate limits
      for (let i = 0; i < allMarketsData.length; i++) {
        const data = allMarketsData[i];
        if (!data || !data.market || !data.market.address || !data.isActive) {
          continue; // Skip inactive markets
        }

        await processMarket(wallet, provider, data);

        // Add delay between markets to avoid rate limiting (except after last market)
        if (i < allMarketsData.length - 1) {
          await delay(500); // 500ms between markets
        }
      }
    } catch (err) {
      logErr(wallet.address, '💥', 'Error in tick:', err && err.message ? err.message : err);
      if (err.stack) {
        console.error(`Stack trace for ${wallet.address}:`, err.stack);
      }
    }
  }

  // Helper function to execute buy transaction
  async function executeBuy(wallet, market, usdc, marketAddress, investment, outcomeToBuy, decimals, pid0, pid1, erc1155) {
    // Check if USDC allowance is sufficient
    logInfo(wallet.address, '🔐', `Checking USDC allowance for market ${marketAddress}...`);
    let currentAllowance;
    try {
      currentAllowance = await readAllowance(usdc, wallet.address, marketAddress);
      logInfo(wallet.address, '🔍', `Current allowance: ${ethers.formatUnits(currentAllowance, decimals)} USDC`);
    } catch (e) {
      logWarn(wallet.address, '⚠️', `Failed to read allowance: ${e?.message || e}`);
      currentAllowance = 0n;
    }

    // Only run approval if needed
    if (currentAllowance < investment) {
      logInfo(wallet.address, '🔐', `Insufficient allowance, requesting approval now...`);
      const allowanceOk = await ensureUsdcApproval(wallet, usdc, marketAddress, investment);
      if (!allowanceOk) {
        logWarn(wallet.address, '🛑', 'Allowance not confirmed. Skip buy this tick.');
        return;
      }
    } else {
      logInfo(wallet.address, '✅', `Allowance already sufficient (pre-approved), proceeding to buy`);
    }

    // Compute minOutcomeTokensToBuy via calcBuyAmount and slippage
    logInfo(wallet.address, '🧮', `[${marketAddress.substring(0, 8)}...] Calculating expected tokens for investment=${investment}...`);
    const expectedTokens = await retryRpcCall(async () => await market.calcBuyAmount(investment, outcomeToBuy));
    const minOutcomeTokensToBuy = expectedTokens - (expectedTokens * BigInt(SLIPPAGE_BPS)) / 10000n;
    logInfo(wallet.address, '🛒', `Buying outcome=${outcomeToBuy} invest=${investment} expectedTokens=${expectedTokens} minTokens=${minOutcomeTokensToBuy} slippage=${SLIPPAGE_BPS}bps`);

    // Mark this market as being bought to prevent duplicates in this tick
    buyingInProgress.add(marketAddress.toLowerCase());

    // Estimate gas then buy
    logInfo(wallet.address, '⚡', `Estimating gas for buy transaction...`);
    const gasEst = await estimateGasFor(market, wallet, 'buy', [investment, outcomeToBuy, minOutcomeTokensToBuy]);
    if (!gasEst) {
      logWarn(wallet.address, '🛑', 'Gas estimate buy failed; skipping buy this tick.');
      buyingInProgress.delete(marketAddress.toLowerCase());
      return;
    }
    logInfo(wallet.address, '⛽', `Gas estimate buy: ${gasEst}`);
    const padded = (gasEst * 120n) / 100n + 10000n;
    logInfo(wallet.address, '🔧', `Gas with 20% padding: ${padded}`);
    const buyOv = await txOverrides(wallet.provider, padded);
    logInfo(wallet.address, '💸', `Sending buy transaction: investment=${investment}, outcome=${outcomeToBuy}, minTokens=${minOutcomeTokensToBuy}`);
    const buyTx = await market.buy(investment, outcomeToBuy, minOutcomeTokensToBuy, buyOv);
    logInfo(wallet.address, '🧾', `Buy tx: ${buyTx.hash}`);
    logInfo(wallet.address, '⏳', `Waiting for ${CONFIRMATIONS} confirmation(s)...`);
    const receipt = await buyTx.wait(CONFIRMATIONS);
    logInfo(wallet.address, '✅', `Buy completed in block ${receipt.blockNumber}, gasUsed=${receipt.gasUsed}`);

    const tokenId = outcomeToBuy === 0 ? pid0 : pid1;
    // After buy, record cost basis
    logInfo(wallet.address, '💾', `[${marketAddress.substring(0, 8)}...] Recording position: outcome=${outcomeToBuy}, tokenId=${tokenId}, cost=${investment}`);
    addHolding(wallet.address, {
      marketAddress,
      outcomeIndex: outcomeToBuy,
      tokenId,
      amount: investment,
      cost: investment
    });

    // Try to confirm on-chain ERC1155 balance
    try {
      let balNow = 0n;
      logInfo(wallet.address, '🔎', `Verifying position balance (tokenId=${tokenId})...`);
      for (let i = 0; i < 3; i++) {
        balNow = await safeBalanceOf(erc1155, wallet.address, tokenId);
        if (balNow > 0n) {
          logInfo(wallet.address, '🎟️', `Position balance confirmed: ${balNow} (attempt ${i + 1}/3)`);
          break;
        }
        logInfo(wallet.address, '⏳', `Position balance not yet updated, retrying in 1s (attempt ${i + 1}/3)...`);
        await delay(1000);
      }
      if (balNow === 0n) {
        logWarn(wallet.address, '⚠️', `Position balance still 0 after 3 attempts (may update later)`);
      }
    } catch (e) {
      logWarn(wallet.address, '⚠️', `[${marketAddress.substring(0, 8)}...] Failed to read position balance after buy: ${(e && e.message) ? e.message : e}`);
    }
  }

  async function processMarket(wallet, provider, data) {
    try {

      const marketInfo = data.market;
      const marketAddress = ethers.getAddress(marketInfo.address);

      // Log market title to console for visibility
      if (marketInfo && marketInfo.title) {
        logInfo(wallet.address, '📰', `[${marketAddress.substring(0, 8)}...] Market: ${marketInfo.title}`);
      }

      const prices = marketInfo.prices || [];
      const positionIds = marketInfo.positionIds || [];
      const collateralTokenAddress = ethers.getAddress(marketInfo.collateralToken.address);

      logInfo(wallet.address, '💹', `[${marketAddress.substring(0, 8)}...] Prices: [${prices.join(', ')}]`);
      logInfo(wallet.address, '🎫', `[${marketAddress.substring(0, 8)}...] Position IDs: [${positionIds.join(', ')}]`);

      // Pre-compute timing guardrails for buying
      const nowMs = Date.now();
      let tooNewForBet = false;
      let nearDeadlineForBet = false;
      let inLastNineMinutes = false;

      if (marketInfo.createdAt) {
        const createdMs = new Date(marketInfo.createdAt).getTime();
        if (!Number.isNaN(createdMs)) {
          const ageMs = nowMs - createdMs;
          const ageMin = Math.max(0, Math.floor(ageMs / 60000));
          if (ageMs < 10 * 60 * 1000) {
            tooNewForBet = true;
            logInfo(wallet.address, '⏳', `[${marketAddress.substring(0, 8)}...] Market age ${ageMin}m < 10m — skip betting`);
          }
        }
      }
      if (marketInfo.deadline) {
        const deadlineMs = new Date(marketInfo.deadline).getTime();
        if (!Number.isNaN(deadlineMs)) {
          const remainingMs = deadlineMs - nowMs;
          const remMin = Math.max(0, Math.floor(remainingMs / 60000));

          // NEW LOGIC: Check if in last 9 minutes
          if (remainingMs <= 9 * 60 * 1000 && remainingMs > 0) {
            inLastNineMinutes = true;
            logInfo(wallet.address, '🕐', `[${marketAddress.substring(0, 8)}...] In last 9 minutes (${remMin}m remaining) - can buy if >75%`);
          }

          if (remainingMs < 5 * 60 * 1000) {
            nearDeadlineForBet = true;
            logInfo(wallet.address, '⏳', `[${marketAddress.substring(0, 8)}...] Time to deadline ${remMin}m < 5m — skip betting`);
          }
        }
      }

      if (!cachedContracts.has(marketAddress)) {
        try {
          // Attach contracts directly to the wallet (signer) for ethers v6 compatibility
          const market = new ethers.Contract(marketAddress, MARKET_ABI, wallet);
          const usdc = new ethers.Contract(collateralTokenAddress, ERC20_ABI, wallet);

          // Use market.conditionalTokens() to get ERC1155 address with retry
          const conditionalTokensAddress = await retryRpcCall(async () => await market.conditionalTokens());
          const erc1155 = new ethers.Contract(ethers.getAddress(conditionalTokensAddress), ERC1155_ABI, wallet);

          // Get decimals with retry
          const decimals = Number(await retryRpcCall(async () => await usdc.decimals()));

          // Sanity: verify contracts have code
          const [marketHasCode, usdcHasCode] = await Promise.all([
            isContract(provider, marketAddress),
            isContract(provider, collateralTokenAddress)
          ]);
          if (!marketHasCode) {
            logErr(wallet.address, '❌', `[${marketAddress.substring(0, 8)}...] Market address has no code on this chain`);
            return;
          }
          if (!usdcHasCode) {
            logErr(wallet.address, '❌', `[${marketAddress.substring(0, 8)}...] USDC address has no code on this chain`);
            return;
          }
          cachedContracts.set(marketAddress, { market, usdc, erc1155, decimals });
          logInfo(wallet.address, '🧩', `[${marketAddress.substring(0, 8)}...] Loaded contracts (decimals=${decimals})`);
        } catch (e) {
          logErr(wallet.address, '💥', `[${marketAddress.substring(0, 8)}...] Failed to load contracts: ${e?.message || e}`);
          return;
        }
      }

      const { market, usdc, erc1155, decimals } = cachedContracts.get(marketAddress);

      // Pre-approve USDC during first 10 minutes of each hour to save time during buy
      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();

      if (currentMinute < 10 && lastApprovalHour !== currentHour) {
        logInfo(wallet.address, '⏰', `[${marketAddress.substring(0, 8)}...] First 10 minutes of hour ${currentHour} - pre-approving USDC`);
        const maxApproval = ethers.parseUnits('1000000', decimals); // Large approval amount
        try {
          const currentAllowance = await readAllowance(usdc, wallet.address, marketAddress);
          if (currentAllowance < ethers.parseUnits('100', decimals)) { // Only approve if allowance is low
            logInfo(wallet.address, '🔓', `[${marketAddress.substring(0, 8)}...] Pre-approving USDC (current: ${ethers.formatUnits(currentAllowance, decimals)})`);
            const approved = await ensureUsdcApproval(wallet, usdc, marketAddress, maxApproval);
            if (approved) {
              logInfo(wallet.address, '✅', `[${marketAddress.substring(0, 8)}...] Pre-approval successful`);
            }
          } else {
            logInfo(wallet.address, '✓', `[${marketAddress.substring(0, 8)}...] Allowance sufficient (${ethers.formatUnits(currentAllowance, decimals)})`);
          }
        } catch (e) {
          logWarn(wallet.address, '⚠️', `[${marketAddress.substring(0, 8)}...] Pre-approval failed: ${e?.message || e}`);
        }
        lastApprovalHour = currentHour; // Mark hour as done after processing all markets
      }

      // Check if user already holds any position for this market
      const localHoldingThisMarket = getHolding(wallet.address, marketAddress);
      const pid0 = positionIds[0] ? BigInt(positionIds[0]) : null;
      const pid1 = positionIds[1] ? BigInt(positionIds[1]) : null;

      let bal0 = 0n, bal1 = 0n;
      if (pid0 !== null) {
        bal0 = await safeBalanceOf(erc1155, wallet.address, pid0);
      }
      if (pid1 !== null) {
        bal1 = await safeBalanceOf(erc1155, wallet.address, pid1);
      }
      logInfo(wallet.address, '🎟️', `[${marketAddress.substring(0, 8)}...] Balances: pid0=${pid0 ?? 'null'} (${bal0}) | pid1=${pid1 ?? 'null'} (${bal1})`);
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
          addHolding(wallet.address, holding);
          logInfo(wallet.address, '💾', `[${marketAddress.substring(0, 8)}...] Initialized cost basis: ${BUY_AMOUNT_USDC} USDC`);
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
        logInfo(wallet.address, '📈', `[${marketAddress.substring(0, 8)}...] Position: value=${valueHuman} cost=${costHuman} PnL=${pnlPct.toFixed(2)}% ${signEmoji}${pnlAbsHuman} USDC`);

        // NEW LOGIC: Don't sell if in last 9 minutes strategy - hold until close
        if (inLastNineMinutes) {
          logInfo(wallet.address, '💎', `[${marketAddress.substring(0, 8)}...] Holding position until market closes (last 9min strategy)`);
          return;
        }

        if (pnlAbs > 0n && pnlPct >= TARGET_PROFIT_PCT) {
          logInfo(wallet.address, '🎯', `Profit target reached! PnL=${pnlPct.toFixed(2)}% >= ${TARGET_PROFIT_PCT}%. Initiating sell...`);
          const approvedOk = await ensureErc1155Approval(wallet, erc1155, marketAddress);
          if (!approvedOk) {
            logWarn(wallet.address, '🛑', 'Approval not confirmed; skipping sell this tick.');
            return;
          }
          // Only proceed if gas estimation works
          // Per spec: sell with maxOutcomeTokensToSell == balance; returnAmount reduced by 1% fee safety
          const maxOutcomeTokensToSell = tokenBalance;
          const returnAmountForSell = positionValue - (positionValue / 100n); // minus 1% safety
          logInfo(wallet.address, '🧮', `Calculating sell: maxTokens=${maxOutcomeTokensToSell}, returnAmount=${returnAmountForSell} (positionValue=${positionValue} - 1% safety)`);
          const gasEst = await estimateGasFor(market, wallet, 'sell', [returnAmountForSell, outcomeIndex, maxOutcomeTokensToSell]);
          if (!gasEst) {
            logWarn(wallet.address, '🛑', 'Gas estimate sell failed; skipping sell this tick.');
            return;
          }
          logInfo(wallet.address, '⛽', `Gas estimate sell: ${gasEst}`);
          const padded = (gasEst * 120n) / 100n + 10000n;
          logInfo(wallet.address, '🔧', `Gas with 20% padding: ${padded}`);
          const sellOv = await txOverrides(wallet.provider, padded);
          logInfo(wallet.address, '💸', `Sending sell transaction: returnAmount=${returnAmountForSell}, outcome=${outcomeIndex}, maxTokens=${maxOutcomeTokensToSell}`);
          const tx = await market.sell(returnAmountForSell, outcomeIndex, maxOutcomeTokensToSell, sellOv);
          logInfo(wallet.address, '🧾', `Sell tx: ${tx.hash}`);
          logInfo(wallet.address, '⏳', `Waiting for ${CONFIRMATIONS} confirmation(s)...`);
          await tx.wait(CONFIRMATIONS);
          logInfo(wallet.address, '✅', `[${marketAddress.substring(0, 8)}...] Sell completed. Final PnL: ${signEmoji}${pnlAbsHuman} USDC (${pnlPct.toFixed(2)}%)`);
          removeHolding(wallet.address, marketAddress);
          markMarketCompleted(wallet.address, marketAddress);
          logInfo(wallet.address, '🧭', `[${marketAddress.substring(0, 8)}...] Market completed, won't re-enter`);
          return;
        } else {
          logInfo(wallet.address, '📊', `[${marketAddress.substring(0, 8)}...] Not profitable yet: PnL=${pnlPct.toFixed(2)}% < ${TARGET_PROFIT_PCT}%`);
        }

        // Already holding; do not buy more
        logInfo(wallet.address, '🛑', `[${marketAddress.substring(0, 8)}...] Already holding a position. Skipping buy.`);
        return;
      }

      // Not holding any position -> maybe buy per strategy
      if (!Array.isArray(prices) || prices.length < 2) {
        logWarn(wallet.address, '⚠️', `[${marketAddress.substring(0, 8)}...] Prices unavailable; skipping.`);
        return;
      }

      // Do not re-enter a market once completed (bought & sold) in this run
      const completed = getCompletedMarkets(wallet.address);
      if (completed.has(marketAddress.toLowerCase())) {
        logInfo(wallet.address, '🧭', `[${marketAddress.substring(0, 8)}...] Previously completed; skipping buy.`);
        return;
      }

      // Prevent duplicate buys in the same tick cycle
      if (buyingInProgress.has(marketAddress.toLowerCase())) {
        logInfo(wallet.address, '🔒', `[${marketAddress.substring(0, 8)}...] Buy already in progress for this market in current tick; skipping.`);
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

      // NEW LOGIC: Check if we should use last 9 minutes strategy
      if (inLastNineMinutes) {
        // Only buy if one side is > 75%
        const maxPrice = Math.max(...prices);
        if (maxPrice <= 75) {
          logInfo(wallet.address, '⏸️', `[${marketAddress.substring(0, 8)}...] In last 9min but no side >75% (prices: [${prices.join(', ')}]) - skipping`);
          return;
        }

        // Buy the side that is > 75%
        const outcomeToBuy = prices[0] > 75 ? 0 : 1;
        logInfo(wallet.address, '🎯', `[${marketAddress.substring(0, 8)}...] Last 9min strategy: Buying outcome ${outcomeToBuy} at ${prices[outcomeToBuy]}%`);

        // Continue to buy logic below with this outcome
        const investmentHuman = BUY_AMOUNT_USDC;
        const investment = ethers.parseUnits(investmentHuman.toString(), decimals);

        // Check USDC balance sufficient for bet
        logInfo(wallet.address, '🔍', `[${marketAddress.substring(0, 8)}...] Checking USDC balance...`);
        const usdcBal = await retryRpcCall(async () => await usdc.balanceOf(wallet.address));
        const usdcBalHuman = ethers.formatUnits(usdcBal, decimals);
        const needHuman = ethers.formatUnits(investment, decimals);
        logInfo(wallet.address, '💰', `USDC balance=${usdcBalHuman}, need=${needHuman} for buy`);
        if (usdcBal < investment) {
          logWarn(wallet.address, '⚠️', `Insufficient USDC balance. Need ${needHuman}, have ${usdcBalHuman}.`);
          return;
        }

        // Check allowance and execute buy (same as normal flow)
        await executeBuy(wallet, market, usdc, marketAddress, investment, outcomeToBuy, decimals, pid0, pid1, erc1155);
        return;
      }

      // Regular buy logic is DISABLED - only using last 9 minutes strategy
      logInfo(wallet.address, '⏸️', `[${marketAddress.substring(0, 8)}...] Not in last 9 minutes - regular buying disabled. Waiting for last 9min window.`);
      return;
    } catch (err) {
      logErr(wallet.address, '💥', `Error processing market: ${err && err.message ? err.message : err}`);
      if (err.stack) {
        console.error(`Stack trace for ${wallet.address}:`, err.stack);
      }
    }
  }

  // initial tick immediately, then interval
  await tick();
  return setInterval(tick, POLL_INTERVAL_MS);
}

async function main() {
  console.log('🚀 Starting Limitless bot on Base...');
  console.log(`📋 Configuration:`);
  console.log(`   RPC_URL: ${RPC_URL}`);
  console.log(`   CHAIN_ID: ${CHAIN_ID}`);
  console.log(`   PRICE_ORACLE_IDS: [${PRICE_ORACLE_IDS.join(', ')}] (${PRICE_ORACLE_IDS.length} market(s))`);
  console.log(`   FREQUENCY: ${FREQUENCY}`);
  console.log(`   POLL_INTERVAL_MS: ${POLL_INTERVAL_MS}`);
  console.log(`   BUY_AMOUNT_USDC: ${BUY_AMOUNT_USDC}`);
  console.log(`   TARGET_PROFIT_PCT: ${TARGET_PROFIT_PCT}%`);
  console.log(`   SLIPPAGE_BPS: ${SLIPPAGE_BPS}`);
  console.log(`   STRATEGY_MODE: ${STRATEGY_MODE}`);
  console.log(`   TRIGGER_PCT: ${TRIGGER_PCT}%`);
  console.log(`   TRIGGER_BAND: ${TRIGGER_BAND}%`);
  console.log(`   WALLETS: ${PRIVATE_KEYS.length}`);

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
    logInfo(w.address, '🔑', `Loaded wallet: ${w.address}`);
    // init user state
    const existing = persisted.get(w.address);
    if (existing) {
      userState.set(w.address, {
        holdings: existing.holdings || [],
        completedMarkets: existing.completedMarkets || new Set()
      });
      const holdingsCount = (existing.holdings || []).length;
      logInfo(w.address, '📂', `State restored: ${holdingsCount} holding(s), ${(existing.completedMarkets || new Set()).size} completed market(s)`);
    } else {
      userState.set(w.address, { holdings: [], completedMarkets: new Set() });
      logInfo(w.address, '🆕', `Initialized new state for wallet`);
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
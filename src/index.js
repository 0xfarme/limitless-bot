require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const MARKET_ABI = require('./abis/Market.json');
const ERC20_ABI = require('./abis/ERC20.json');
const ERC1155_ABI = require('./abis/ERC1155.json');
const CONDITIONAL_TOKENS_ABI = require('./abis/ConditionalTokens.json');

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
const TRADES_LOG_FILE = process.env.TRADES_LOG_FILE || path.join('data', 'trades.jsonl');
const STATS_FILE = process.env.STATS_FILE || path.join('data', 'stats.json');
const REDEMPTION_LOG_FILE = process.env.REDEMPTION_LOG_FILE || path.join('data', 'redemptions.jsonl');

// ========= Trading Strategy Config =========
const BUY_WINDOW_MINUTES = parseInt(process.env.BUY_WINDOW_MINUTES || '13', 10); // Last N minutes to buy
const NO_BUY_FINAL_MINUTES = parseInt(process.env.NO_BUY_FINAL_MINUTES || '2', 10); // Don't buy in last N minutes
const STOP_LOSS_MINUTES = parseInt(process.env.STOP_LOSS_MINUTES || '2', 10); // Stop loss active in last N minutes
const STOP_LOSS_ODDS_THRESHOLD = parseInt(process.env.STOP_LOSS_ODDS_THRESHOLD || '40', 10); // Sell if odds below N%
const MIN_ODDS = parseInt(process.env.MIN_ODDS || '75', 10); // Minimum odds to buy
const MAX_ODDS = parseInt(process.env.MAX_ODDS || '95', 10); // Maximum odds to buy
const MIN_MARKET_AGE_MINUTES = parseInt(process.env.MIN_MARKET_AGE_MINUTES || '10', 10); // Don't buy markets younger than N minutes

// ========= Early Contrarian Strategy Config =========
const EARLY_STRATEGY_ENABLED = (process.env.EARLY_STRATEGY_ENABLED || 'true').toLowerCase() === 'true'; // Enable early contrarian strategy
const EARLY_WINDOW_MINUTES = parseInt(process.env.EARLY_WINDOW_MINUTES || '30', 10); // First N minutes for contrarian buys
const EARLY_TRIGGER_ODDS = parseInt(process.env.EARLY_TRIGGER_ODDS || '70', 10); // Buy opposite side if one side reaches N%
const EARLY_PROFIT_TARGET_PCT = parseInt(process.env.EARLY_PROFIT_TARGET_PCT || '20', 10); // Sell at N% profit

// ========= Redemption Config =========
const AUTO_REDEEM_ENABLED = (process.env.AUTO_REDEEM_ENABLED || 'true').toLowerCase() === 'true'; // Enable automatic redemption
const REDEEM_WINDOW_START = parseInt(process.env.REDEEM_WINDOW_START || '6', 10); // Redemption window start minute (0-59)
const REDEEM_WINDOW_END = parseInt(process.env.REDEEM_WINDOW_END || '10', 10); // Redemption window end minute (0-59)

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

// Global statistics tracking
const botStats = {
  totalTrades: 0,
  profitableTrades: 0,
  losingTrades: 0,
  totalProfitUSDC: 0,
  totalLossUSDC: 0,
  startTime: Date.now(),
  lastUpdated: Date.now()
};

// ========= Logging helpers with emojis =========
function logInfo(addr, emoji, msg) {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} ${emoji} [${addr}] ${msg}`);
}
function logWarn(addr, emoji, msg) {
  const timestamp = new Date().toISOString();
  console.warn(`${timestamp} ${emoji} [${addr}] ${msg}`);
}
function logErr(addr, emoji, msg, err) {
  const timestamp = new Date().toISOString();
  const base = `${timestamp} ${emoji} [${addr}] ${msg}`;
  if (err) console.error(base, err);
  else console.error(base);
}

// ========= Trade Logging =========
function logTrade(tradeData) {
  try {
    ensureDirSync(path.dirname(TRADES_LOG_FILE));
    const logEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...tradeData
    }) + '\n';
    fs.appendFileSync(TRADES_LOG_FILE, logEntry);
  } catch (e) {
    console.error('⚠️ Failed to log trade:', e?.message || e);
  }
}

// ========= Redemption Logging =========
function logRedemption(redemptionData) {
  try {
    ensureDirSync(path.dirname(REDEMPTION_LOG_FILE));
    const logEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...redemptionData
    }) + '\n';
    fs.appendFileSync(REDEMPTION_LOG_FILE, logEntry);
  } catch (e) {
    console.error('⚠️ Failed to log redemption:', e?.message || e);
  }
}

function updateStats(pnlUSDC) {
  botStats.totalTrades++;
  botStats.lastUpdated = Date.now();

  if (pnlUSDC > 0) {
    botStats.profitableTrades++;
    botStats.totalProfitUSDC += pnlUSDC;
  } else if (pnlUSDC < 0) {
    botStats.losingTrades++;
    botStats.totalLossUSDC += Math.abs(pnlUSDC);
  }

  // Save stats to file
  try {
    ensureDirSync(path.dirname(STATS_FILE));
    const statsData = {
      ...botStats,
      netProfitUSDC: botStats.totalProfitUSDC - botStats.totalLossUSDC,
      winRate: botStats.totalTrades > 0 ? ((botStats.profitableTrades / botStats.totalTrades) * 100).toFixed(2) + '%' : '0%',
      uptimeHours: ((Date.now() - botStats.startTime) / (1000 * 60 * 60)).toFixed(2)
    };
    fs.writeFileSync(STATS_FILE, JSON.stringify(statsData, null, 2));

    // Log summary to console
    console.log('\n📊 ========= BOT STATISTICS =========');
    console.log(`📈 Total Trades: ${botStats.totalTrades}`);
    console.log(`✅ Profitable: ${botStats.profitableTrades} | ❌ Losing: ${botStats.losingTrades}`);
    console.log(`💰 Total Profit: $${botStats.totalProfitUSDC.toFixed(4)} USDC`);
    console.log(`💸 Total Loss: $${botStats.totalLossUSDC.toFixed(4)} USDC`);
    console.log(`📊 Net P&L: $${statsData.netProfitUSDC.toFixed(4)} USDC`);
    console.log(`🎯 Win Rate: ${statsData.winRate}`);
    console.log(`⏱️  Uptime: ${statsData.uptimeHours} hours`);
    console.log('=====================================\n');
  } catch (e) {
    console.error('⚠️ Failed to save stats:', e?.message || e);
  }
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

// ========= Position Summary Report =========
function logPositionsSummary(addr) {
  const holdings = getAllHoldings(addr);

  if (holdings.length === 0) {
    logInfo(addr, '📋', 'No active positions');
    return;
  }

  console.log(`\n📋 ========= ACTIVE POSITIONS (${addr}) =========`);
  holdings.forEach((holding, idx) => {
    const shortAddr = holding.marketAddress.substring(0, 8);
    const costUSDC = holding.cost ? ethers.formatUnits(holding.cost, 6) : 'Unknown';
    const deadline = holding.marketDeadline ? new Date(holding.marketDeadline).toLocaleString() : 'Unknown';

    console.log(`\n${idx + 1}. Market: ${shortAddr}...`);
    console.log(`   Title: ${holding.marketTitle || 'Unknown'}`);
    console.log(`   Outcome: ${holding.outcomeIndex} @ ${holding.entryPrice}%`);
    console.log(`   Cost: $${costUSDC} USDC`);
    console.log(`   Strategy: ${holding.strategy || 'default'}`);
    console.log(`   Buy Time: ${holding.buyTimestamp || 'Unknown'}`);
    console.log(`   Deadline: ${deadline}`);
    console.log(`   Buy Tx: ${holding.buyTxHash || 'N/A'}`);
  });
  console.log('=============================================\n');
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
async function retryRpcCall(fn, maxRetries = 5, baseDelay = 2000) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const isLastAttempt = attempt === maxRetries - 1;
      const isRpcError = e?.code === 'CALL_EXCEPTION'
        || e?.code === 'ECONNRESET'
        || e?.code === 'ETIMEDOUT'
        || e?.code === 'ENOTFOUND'
        || e?.code === 'ECONNREFUSED'
        || e?.message?.includes('missing revert data')
        || e?.message?.includes('rate limit')
        || e?.message?.includes('ECONNRESET')
        || e?.message?.includes('connection');

      if (isLastAttempt) {
        throw e;
      }

      if (!isRpcError) {
        throw e; // Don't retry non-RPC errors
      }

      const delayMs = baseDelay * Math.pow(2, attempt);
      console.warn(`⚠️ RPC call failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms:`, e?.code || e?.message || e);
      await delay(delayMs);
    }
  }
}

async function safeBalanceOf(erc1155, owner, tokenId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await erc1155.balanceOf(owner, tokenId);
    } catch (e) {
      if (attempt === 4) {
        console.warn(`⚠️ Failed to read balance after 5 attempts:`, e?.message || e);
        return 0n;
      }
      await delay(1000 * (attempt + 1)); // Exponential backoff: 1s, 2s, 3s, 4s
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

// ========= Redemption Logic =========
async function checkAndRedeemPosition(wallet, marketData, holding, conditionalTokensContract, collateralTokenAddress, usdc, decimals) {
  const marketAddress = holding.marketAddress;
  const marketInfo = marketData.market;

  try {
    logInfo(wallet.address, '🔍', `[${marketAddress.substring(0, 8)}...] Checking if market is resolved for redemption...`);

    logRedemption({
      event: 'CHECK_RESOLUTION_START',
      wallet: wallet.address,
      marketAddress: marketAddress,
      marketStatus: marketInfo?.status,
      marketResolved: marketData.resolved,
      marketTitle: marketInfo?.title || 'Unknown'
    });

    // Check if market is resolved via API data
    // Note: API returns status field and isActive flag
    const isResolved = marketData.resolved === true || marketInfo.status === 'RESOLVED';

    if (!isResolved) {
      logInfo(wallet.address, '⏳', `[${marketAddress.substring(0, 8)}...] Market not yet resolved (status: ${marketInfo.status}, resolved: ${marketData.resolved}), skipping redemption`);
      logRedemption({
        event: 'MARKET_NOT_RESOLVED',
        wallet: wallet.address,
        marketAddress: marketAddress,
        status: marketInfo.status,
        resolved: marketData.resolved
      });
      return false;
    }

    logInfo(wallet.address, '✅', `[${marketAddress.substring(0, 8)}...] Market is resolved in API (status: ${marketInfo.status})`);

    logRedemption({
      event: 'MARKET_RESOLVED_API',
      wallet: wallet.address,
      marketAddress: marketAddress,
      status: marketInfo.status
    });

    // Get conditionId from market data (API returns singular conditionId, not plural)
    const conditionId = marketInfo.conditionId;

    if (!conditionId) {
      logWarn(wallet.address, '⚠️', `[${marketAddress.substring(0, 8)}...] No conditionId found, cannot redeem`);
      logRedemption({
        event: 'NO_CONDITION_ID',
        wallet: wallet.address,
        marketAddress: marketAddress,
        marketInfo: marketInfo
      });
      return false;
    }

    logRedemption({
      event: 'CONDITION_ID_FOUND',
      wallet: wallet.address,
      marketAddress: marketAddress,
      conditionId: conditionId
    });

    // Check if condition is resolved by checking if payoutDenominator > 0
    const payoutDenom = await retryRpcCall(async () => await conditionalTokensContract.payoutDenominator(conditionId));

    logRedemption({
      event: 'PAYOUT_DENOM_CHECK',
      wallet: wallet.address,
      marketAddress: marketAddress,
      conditionId: conditionId,
      payoutDenominator: payoutDenom ? payoutDenom.toString() : '0'
    });

    if (!payoutDenom || payoutDenom === 0n) {
      logInfo(wallet.address, '⏳', `[${marketAddress.substring(0, 8)}...] Market resolved in API but condition not yet resolved on-chain, waiting...`);
      logRedemption({
        event: 'CONDITION_NOT_RESOLVED_ONCHAIN',
        wallet: wallet.address,
        marketAddress: marketAddress,
        conditionId: conditionId
      });
      return false;
    }

    logInfo(wallet.address, '✅', `[${marketAddress.substring(0, 8)}...] Market is resolved on-chain! PayoutDenom: ${payoutDenom}`);

    // Check which outcome won by reading payout numerators
    const payout0 = await retryRpcCall(async () => await conditionalTokensContract.payoutNumerators(conditionId, 0));
    const payout1 = await retryRpcCall(async () => await conditionalTokensContract.payoutNumerators(conditionId, 1));

    logInfo(wallet.address, '🎲', `[${marketAddress.substring(0, 8)}...] Payouts: Outcome 0 = ${payout0}, Outcome 1 = ${payout1}`);

    // Determine winning outcome (higher payout numerator wins)
    let winningOutcome = -1;
    if (payout0 > payout1) {
      winningOutcome = 0;
    } else if (payout1 > payout0) {
      winningOutcome = 1;
    }

    // Check if we won
    const ourOutcome = holding.outcomeIndex;
    const didWeWin = winningOutcome === ourOutcome;
    const winStatus = didWeWin ? '🎉 WON' : '😢 LOST';

    logInfo(wallet.address, didWeWin ? '🎉' : '😢',
      `[${marketAddress.substring(0, 8)}...] We held outcome ${ourOutcome}, winning outcome is ${winningOutcome} - ${winStatus}`);

    // Check balance before redemption to estimate winnings
    const balanceBefore = await retryRpcCall(async () => await usdc.balanceOf(wallet.address));

    // Get parent collection ID (usually 0x0 for simple markets)
    const parentCollectionId = '0x0000000000000000000000000000000000000000000000000000000000000000';

    // Index sets: [1, 2] represents both outcomes [outcome 0, outcome 1]
    // We redeem both to get back winnings
    const indexSets = [1, 2];

    logInfo(wallet.address, '💰', `[${marketAddress.substring(0, 8)}...] Redeeming position...`);
    logInfo(wallet.address, '🔧', `Parameters: collateral=${collateralTokenAddress}, conditionId=${conditionId}, indexSets=[${indexSets.join(', ')}]`);

    // Estimate gas for redemption
    const gasEst = await estimateGasFor(
      conditionalTokensContract,
      wallet,
      'redeemPositions',
      [collateralTokenAddress, parentCollectionId, conditionId, indexSets]
    );

    if (!gasEst) {
      logWarn(wallet.address, '🛑', 'Gas estimate for redeemPositions failed; skipping redemption this tick.');
      return false;
    }

    logInfo(wallet.address, '⛽', `Gas estimate redeemPositions: ${gasEst}`);
    const padded = (gasEst * 120n) / 100n + 10000n;
    const redeemOv = await txOverrides(wallet.provider, padded);

    logInfo(wallet.address, '📤', `Sending redeemPositions transaction...`);
    const redeemTx = await conditionalTokensContract.redeemPositions(
      collateralTokenAddress,
      parentCollectionId,
      conditionId,
      indexSets,
      redeemOv
    );

    logInfo(wallet.address, '🧾', `Redemption tx: ${redeemTx.hash}`);
    logInfo(wallet.address, '⏳', `Waiting for ${CONFIRMATIONS} confirmation(s)...`);
    const receipt = await redeemTx.wait(CONFIRMATIONS);

    logInfo(wallet.address, '🎉', `[${marketAddress.substring(0, 8)}...] Successfully redeemed position! Block: ${receipt.blockNumber}`);

    // Check balance after redemption to see actual amount received
    const balanceAfter = await retryRpcCall(async () => await usdc.balanceOf(wallet.address));
    const amountRedeemed = balanceAfter - balanceBefore;
    const amountRedeemedUSDC = parseFloat(ethers.formatUnits(amountRedeemed, decimals));
    const costUSDC = parseFloat(ethers.formatUnits(holding.cost || 0n, decimals));
    const pnlUSDC = amountRedeemedUSDC - costUSDC;

    logInfo(wallet.address, '💵',
      `[${marketAddress.substring(0, 8)}...] Redeemed: $${amountRedeemedUSDC.toFixed(4)} USDC | Cost: $${costUSDC.toFixed(4)} | PnL: ${pnlUSDC >= 0 ? '+' : ''}$${pnlUSDC.toFixed(4)}`);

    // Log redemption trade with full details
    logTrade({
      type: 'REDEEM',
      wallet: wallet.address,
      marketAddress,
      marketTitle: marketInfo?.title || 'Unknown',
      ourOutcome: ourOutcome,
      winningOutcome: winningOutcome,
      result: didWeWin ? 'WON' : 'LOST',
      costUSDC: costUSDC.toFixed(4),
      redeemedUSDC: amountRedeemedUSDC.toFixed(4),
      pnlUSDC: pnlUSDC.toFixed(4),
      pnlPercent: costUSDC > 0 ? ((pnlUSDC / costUSDC) * 100).toFixed(2) : '0.00',
      conditionId,
      payout0: payout0.toString(),
      payout1: payout1.toString(),
      txHash: redeemTx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString()
    });

    // Update stats
    if (didWeWin) {
      updateStats(pnlUSDC);
    } else {
      updateStats(pnlUSDC);
    }

    // Log successful redemption
    logRedemption({
      event: 'REDEMPTION_SUCCESS',
      wallet: wallet.address,
      marketAddress: marketAddress,
      ourOutcome: ourOutcome,
      winningOutcome: winningOutcome,
      didWeWin: didWeWin,
      amountRedeemed: amountRedeemed.toString(),
      amountRedeemedUSDC: amountRedeemedUSDC.toFixed(4),
      pnlUSDC: pnlUSDC.toFixed(4),
      txHash: redeemTx.hash
    });

    // Remove holding after successful redemption
    removeHolding(wallet.address, marketAddress);

    // Mark as completed so we don't try to redeem again
    markMarketCompleted(wallet.address, marketAddress);

    return true;
  } catch (err) {
    logErr(wallet.address, '💥', `[${marketAddress.substring(0, 8)}...] Redemption failed: ${err?.message || err}`);
    logRedemption({
      event: 'REDEMPTION_ERROR',
      wallet: wallet.address,
      marketAddress: marketAddress,
      error: err?.message || String(err),
      errorCode: err?.code,
      errorStack: err?.stack
    });
    if (err.stack) {
      console.error(`Stack trace for ${wallet.address}:`, err.stack);
    }
    return false;
  }
}

async function runForWallet(wallet, provider) {
  logInfo(wallet.address, '🚀', 'Worker started');
  let cachedContracts = new Map(); // marketAddress -> { market, usdc, erc1155, decimals }
  let inactiveMarketsThisHour = new Set(); // Track inactive markets this hour to avoid re-checking
  let currentHourForInactive = -1; // Track which hour for inactive markets
  let buyingInProgress = new Set(); // Track markets currently being bought in this tick to prevent duplicates
  let approvedMarkets = new Set(); // Track markets we've already approved USDC for

  // Pre-approve USDC for active markets (once per market)
  async function preApproveMarketsIfNeeded(wallet, activeMarkets) {
    for (const data of activeMarkets) {
      const marketAddress = ethers.getAddress(data.market.address);

      // Skip if already approved this session
      if (approvedMarkets.has(marketAddress.toLowerCase())) {
        continue;
      }

      try {
        // Get or create contracts
        if (!cachedContracts.has(marketAddress)) {
          const collateralTokenAddress = ethers.getAddress(data.market.collateralToken.address);
          const market = new ethers.Contract(marketAddress, MARKET_ABI, wallet);
          const usdc = new ethers.Contract(collateralTokenAddress, ERC20_ABI, wallet);
          const conditionalTokensAddress = await retryRpcCall(async () => await market.conditionalTokens());
          const erc1155 = new ethers.Contract(ethers.getAddress(conditionalTokensAddress), ERC1155_ABI, wallet);
          const decimals = Number(await retryRpcCall(async () => await usdc.decimals()));

          cachedContracts.set(marketAddress, { market, usdc, erc1155, decimals, conditionalTokensAddress });
        }

        const { usdc, decimals } = cachedContracts.get(marketAddress);
        const maxApproval = ethers.parseUnits('1000000', decimals); // Large approval

        logInfo(wallet.address, '🔐', `[${marketAddress.substring(0, 8)}...] Pre-approving USDC...`);
        const currentAllowance = await readAllowance(usdc, wallet.address, marketAddress);

        if (currentAllowance < ethers.parseUnits('100', decimals)) {
          const approved = await ensureUsdcApproval(wallet, usdc, marketAddress, maxApproval);
          if (approved) {
            approvedMarkets.add(marketAddress.toLowerCase());
            logInfo(wallet.address, '✅', `[${marketAddress.substring(0, 8)}...] USDC pre-approved`);
          }
        } else {
          approvedMarkets.add(marketAddress.toLowerCase());
          logInfo(wallet.address, '✓', `[${marketAddress.substring(0, 8)}...] USDC already approved`);
        }
      } catch (e) {
        logWarn(wallet.address, '⚠️', `[${marketAddress.substring(0, 8)}...] Pre-approval failed: ${e?.message || e}`);
      }
    }
  }

  // Helper function to check if bot should be active based on current time
  function shouldBeActive() {
    const now = new Date();
    const nowMinutes = now.getMinutes();

    // Redemption window: minutes 6-10
    const inRedemptionWindow = AUTO_REDEEM_ENABLED && nowMinutes >= REDEEM_WINDOW_START && nowMinutes <= REDEEM_WINDOW_END;

    // Early contrarian window: first 30 minutes of each hour (if enabled)
    const inEarlyWindow = EARLY_STRATEGY_ENABLED && nowMinutes <= EARLY_WINDOW_MINUTES;

    // Last 13 minutes trading window: minutes 47-60
    const inLateWindow = nowMinutes >= (60 - BUY_WINDOW_MINUTES);

    return inRedemptionWindow || inEarlyWindow || inLateWindow;
  }

  // Calculate next wake time
  function getNextWakeTime() {
    const now = new Date();
    const nowMinutes = now.getMinutes();
    const nowSeconds = now.getSeconds();

    let nextWakeMinute;

    // Determine next active window
    if (AUTO_REDEEM_ENABLED && nowMinutes < REDEEM_WINDOW_START) {
      nextWakeMinute = REDEEM_WINDOW_START;
    } else if (EARLY_STRATEGY_ENABLED && nowMinutes <= EARLY_WINDOW_MINUTES) {
      return null; // Already in early window, stay active
    } else if (nowMinutes < (60 - BUY_WINDOW_MINUTES)) {
      nextWakeMinute = 60 - BUY_WINDOW_MINUTES;
    } else {
      // Next window is in the next hour
      if (AUTO_REDEEM_ENABLED) {
        nextWakeMinute = REDEEM_WINDOW_START + 60;
      } else if (EARLY_STRATEGY_ENABLED) {
        nextWakeMinute = 0 + 60;
      } else {
        nextWakeMinute = (60 - BUY_WINDOW_MINUTES) + 60;
      }
    }

    // Calculate seconds until next wake time
    const minutesUntilWake = nextWakeMinute - nowMinutes;
    const secondsUntilWake = (minutesUntilWake * 60) - nowSeconds;

    return secondsUntilWake * 1000; // Convert to milliseconds
  }

  async function tick() {
    // Clear buyingInProgress at start of each tick - it's just for preventing concurrent buys within same tick
    buyingInProgress.clear();

    // Clear inactive markets set every hour and show position summary
    const nowHour = new Date().getHours();
    if (currentHourForInactive !== nowHour) {
      inactiveMarketsThisHour.clear();
      currentHourForInactive = nowHour;
      logInfo(wallet.address, '🔄', `New hour started - cleared inactive markets cache`);

      // Show positions summary at the start of each hour
      logPositionsSummary(wallet.address);
    }

    // Check if bot should be active right now
    if (!shouldBeActive()) {
      const nextWakeMs = getNextWakeTime();
      const nextWakeMinutes = Math.floor(nextWakeMs / 60000);
      const nextWakeSeconds = Math.floor((nextWakeMs % 60000) / 1000);
      logInfo(wallet.address, '💤', `Bot in sleep mode - not in active trading/redemption window. Next wake in ${nextWakeMinutes}m ${nextWakeSeconds}s`);
      return;
    }

    try {
      logInfo(wallet.address, '🔄', `Polling market data (oracles=[${PRICE_ORACLE_IDS.join(', ')}], freq=${FREQUENCY})...`);
      const allMarketsData = await fetchMarkets();

      // Redemption window: Only check for redemptions during configured time window
      // This allows time for market settlement after closing at :00
      const nowMinutes = new Date().getMinutes();
      const inRedemptionWindow = AUTO_REDEEM_ENABLED && nowMinutes >= REDEEM_WINDOW_START && nowMinutes <= REDEEM_WINDOW_END;

      if (inRedemptionWindow) {
        // First, check for positions that need redemption
        const myHoldings = getAllHoldings(wallet.address);
        if (myHoldings.length > 0) {
          logInfo(wallet.address, '🕐', `Redemption window active (minutes ${REDEEM_WINDOW_START}-${REDEEM_WINDOW_END}) - checking ${myHoldings.length} position(s)...`);

          // Log redemption check start
          logRedemption({
            event: 'REDEMPTION_CHECK_START',
            wallet: wallet.address,
            holdingsCount: myHoldings.length,
            holdings: myHoldings.map(h => ({
              marketAddress: h.marketAddress,
              outcomeIndex: h.outcomeIndex,
              cost: h.cost ? h.cost.toString() : null
            }))
          });

        for (const holding of myHoldings) {
          try {
            logRedemption({
              event: 'CHECKING_HOLDING',
              wallet: wallet.address,
              marketAddress: holding.marketAddress,
              outcomeIndex: holding.outcomeIndex
            });

            // Check if already redeemed/completed
            const completed = getCompletedMarkets(wallet.address);
            if (completed.has(holding.marketAddress.toLowerCase())) {
              logInfo(wallet.address, '✓', `[${holding.marketAddress.substring(0, 8)}...] Already redeemed, skipping`);
              logRedemption({
                event: 'ALREADY_REDEEMED',
                wallet: wallet.address,
                marketAddress: holding.marketAddress
              });
              continue;
            }

            // Find the market data for this holding - first check in oracle data
            let marketData = allMarketsData.find(m => m.market && m.market.address.toLowerCase() === holding.marketAddress.toLowerCase());

            // If not found in oracle data, fetch directly by market address
            if (!marketData) {
              logInfo(wallet.address, '🔍', `[${holding.marketAddress.substring(0, 8)}...] Market not in oracle data, fetching directly from API...`);
              logRedemption({
                event: 'FETCHING_MARKET_DIRECTLY',
                wallet: wallet.address,
                marketAddress: holding.marketAddress,
                reason: 'Market not in allMarketsData from oracle IDs',
                oracleMarkets: allMarketsData.map(m => m.market?.address || 'unknown')
              });

              try {
                const url = `https://api.limitless.exchange/markets/${holding.marketAddress}`;
                const res = await axios.get(url, { timeout: 15000 });
                marketData = res.data;
                logInfo(wallet.address, '✅', `[${holding.marketAddress.substring(0, 8)}...] Market data fetched successfully`);
                logRedemption({
                  event: 'MARKET_FETCHED_DIRECTLY',
                  wallet: wallet.address,
                  marketAddress: holding.marketAddress,
                  marketStatus: marketData.market?.status,
                  isResolved: marketData.resolved
                });
              } catch (e) {
                logWarn(wallet.address, '⚠️', `[${holding.marketAddress.substring(0, 8)}...] Failed to fetch market data: ${e?.message || e}, skipping redemption check`);
                logRedemption({
                  event: 'MARKET_FETCH_FAILED',
                  wallet: wallet.address,
                  marketAddress: holding.marketAddress,
                  error: e?.message || String(e)
                });
                continue;
              }
            }

            logRedemption({
              event: 'MARKET_FOUND',
              wallet: wallet.address,
              marketAddress: holding.marketAddress,
              marketStatus: marketData.market?.status,
              isResolved: marketData.resolved,
              isActive: marketData.isActive
            });

            // Get or create conditional tokens contract
            const marketAddress = ethers.getAddress(holding.marketAddress);
            if (!cachedContracts.has(marketAddress)) {
              // Initialize contracts for this market if not cached
              const collateralTokenAddress = ethers.getAddress(marketData.market.collateralToken.address);
              const market = new ethers.Contract(marketAddress, MARKET_ABI, wallet);
              const usdc = new ethers.Contract(collateralTokenAddress, ERC20_ABI, wallet);
              const conditionalTokensAddress = await retryRpcCall(async () => await market.conditionalTokens());
              const erc1155 = new ethers.Contract(ethers.getAddress(conditionalTokensAddress), ERC1155_ABI, wallet);
              const decimals = Number(await retryRpcCall(async () => await usdc.decimals()));
              cachedContracts.set(marketAddress, { market, usdc, erc1155, decimals, conditionalTokensAddress });
            }

            const { conditionalTokensAddress, usdc, decimals } = cachedContracts.get(marketAddress);
            const conditionalTokensContract = new ethers.Contract(
              conditionalTokensAddress,
              CONDITIONAL_TOKENS_ABI,
              wallet
            );

            const collateralTokenAddress = ethers.getAddress(marketData.market.collateralToken.address);

            // Check and redeem if possible
            logRedemption({
              event: 'CALLING_REDEEM_FUNCTION',
              wallet: wallet.address,
              marketAddress: holding.marketAddress
            });

            const redeemed = await checkAndRedeemPosition(
              wallet,
              marketData,
              holding,
              conditionalTokensContract,
              collateralTokenAddress,
              usdc,
              decimals
            );

            logRedemption({
              event: 'REDEEM_FUNCTION_RETURNED',
              wallet: wallet.address,
              marketAddress: holding.marketAddress,
              redeemed: redeemed
            });

            if (redeemed) {
              logInfo(wallet.address, '✅', `[${holding.marketAddress.substring(0, 8)}...] Position redeemed successfully`);
            } else {
              logInfo(wallet.address, '⏭️', `[${holding.marketAddress.substring(0, 8)}...] Position not redeemed (market not ready or already claimed)`);
            }

            // Add small delay between redemption checks to avoid rate limits
            await delay(500);
          } catch (err) {
            logErr(wallet.address, '💥', `Error checking redemption for ${holding.marketAddress}:`, err?.message || err);
            logRedemption({
              event: 'REDEMPTION_LOOP_ERROR',
              wallet: wallet.address,
              marketAddress: holding.marketAddress,
              error: err?.message || String(err)
            });
          }
        }
        } else {
          logInfo(wallet.address, '📭', `Redemption window active but no positions to check`);
        }
      } else if (!AUTO_REDEEM_ENABLED) {
        // Only log once per hour when redemption is disabled
        if (nowMinutes === 0) {
          logInfo(wallet.address, '🔕', `Auto-redemption is DISABLED (AUTO_REDEEM_ENABLED=false)`);
        }
      } else {
        logInfo(wallet.address, '⏸️', `Outside redemption window (current: ${nowMinutes} min, window: ${REDEEM_WINDOW_START}-${REDEEM_WINDOW_END} min) - skipping redemption checks`);
      }

      if (!allMarketsData || allMarketsData.length === 0) {
        logWarn(wallet.address, '⏸️', `No markets returned from API`);
        return;
      }

      // Filter out inactive markets and markets we've already seen as inactive this hour
      const activeMarkets = [];
      for (const data of allMarketsData) {
        if (!data || !data.market || !data.market.address) continue;

        const marketKey = data.market.address.toLowerCase();

        // Skip if we already know it's inactive this hour
        if (inactiveMarketsThisHour.has(marketKey)) {
          continue;
        }

        if (!data.isActive) {
          inactiveMarketsThisHour.add(marketKey);
          logInfo(wallet.address, '⏸️', `[${marketKey.substring(0, 8)}...] Market inactive - skipping this hour`);
          continue;
        }

        activeMarkets.push(data);
      }

      if (activeMarkets.length === 0) {
        logWarn(wallet.address, '⏸️', `No active markets found`);
        return;
      }

      logInfo(wallet.address, '📡', `Found ${activeMarkets.length} active market(s) (skipped ${inactiveMarketsThisHour.size} inactive)`);

      // Pre-approve USDC for all active markets upfront (once per session)
      await preApproveMarketsIfNeeded(wallet, activeMarkets);

      // Process each market with delay between them to avoid rate limits
      for (let i = 0; i < activeMarkets.length; i++) {
        const data = activeMarkets[i];

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
  async function executeBuy(wallet, market, usdc, marketAddress, investment, outcomeToBuy, decimals, pid0, pid1, erc1155, strategy = 'default') {
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

    // Estimate gas then buy
    logInfo(wallet.address, '⚡', `Estimating gas for buy transaction...`);
    const gasEst = await estimateGasFor(market, wallet, 'buy', [investment, outcomeToBuy, minOutcomeTokensToBuy]);
    if (!gasEst) {
      logWarn(wallet.address, '🛑', 'Gas estimate buy failed; skipping buy this tick.');
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
    // After buy, record cost basis with full metadata
    logInfo(wallet.address, '💾', `[${marketAddress.substring(0, 8)}...] Recording position: outcome=${outcomeToBuy}, tokenId=${tokenId}, cost=${investment}, strategy=${strategy}`);
    addHolding(wallet.address, {
      marketAddress,
      marketTitle: marketInfo?.title || 'Unknown',
      outcomeIndex: outcomeToBuy,
      tokenId,
      amount: investment,
      cost: investment,
      strategy: strategy, // 'default', 'early_contrarian', or other strategies
      entryPrice: prices[outcomeToBuy] || 'Unknown',
      buyTimestamp: new Date().toISOString(),
      marketDeadline: marketInfo?.deadline || null,
      buyTxHash: buyTx.hash
    });

    // Log buy trade with detailed information
    const marketDeadline = marketInfo?.deadline ? new Date(marketInfo.deadline).toISOString() : 'Unknown';
    const prices = marketInfo?.prices || [];

    logTrade({
      type: 'BUY',
      wallet: wallet.address,
      marketAddress,
      marketTitle: marketInfo?.title || 'Unknown',
      outcome: outcomeToBuy,
      outcomePrice: prices[outcomeToBuy] || 'Unknown',
      opponentPrice: prices[outcomeToBuy === 0 ? 1 : 0] || 'Unknown',
      investmentUSDC: ethers.formatUnits(investment, decimals),
      expectedTokens: expectedTokens.toString(),
      minTokens: minOutcomeTokensToBuy.toString(),
      strategy: strategy,
      marketDeadline: marketDeadline,
      txHash: buyTx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString()
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
      let inLastThirteenMinutes = false;
      let inLastTwoMinutes = false;
      let inLastThreeMinutes = false;
      let inEarlyWindow = false;

      if (marketInfo.createdAt) {
        const createdMs = new Date(marketInfo.createdAt).getTime();
        if (!Number.isNaN(createdMs)) {
          const ageMs = nowMs - createdMs;
          const ageMin = Math.max(0, Math.floor(ageMs / 60000));

          // Check if in early contrarian strategy window (first 30 minutes)
          if (EARLY_STRATEGY_ENABLED && ageMs <= EARLY_WINDOW_MINUTES * 60 * 1000) {
            inEarlyWindow = true;
            logInfo(wallet.address, '🌅', `[${marketAddress.substring(0, 8)}...] In early window (${ageMin}m old, <= ${EARLY_WINDOW_MINUTES}m) - contrarian strategy active`);
          }

          if (ageMs < MIN_MARKET_AGE_MINUTES * 60 * 1000) {
            tooNewForBet = true;
            logInfo(wallet.address, '⏳', `[${marketAddress.substring(0, 8)}...] Market age ${ageMin}m < ${MIN_MARKET_AGE_MINUTES}m — skip betting`);
          }
        }
      }
      if (marketInfo.deadline) {
        const deadlineMs = new Date(marketInfo.deadline).getTime();
        if (!Number.isNaN(deadlineMs)) {
          const remainingMs = deadlineMs - nowMs;
          const remMin = Math.max(0, Math.floor(remainingMs / 60000));

          // Check if in last N minutes - no buys allowed
          if (remainingMs <= NO_BUY_FINAL_MINUTES * 60 * 1000 && remainingMs > 0) {
            inLastTwoMinutes = true;
            logInfo(wallet.address, '🕐', `[${marketAddress.substring(0, 8)}...] In last ${NO_BUY_FINAL_MINUTES} minutes (${remMin}m remaining) - no buys allowed`);
          }

          // Check if in last N minutes - stop loss active
          if (remainingMs <= STOP_LOSS_MINUTES * 60 * 1000 && remainingMs > 0) {
            inLastThreeMinutes = true;
            logInfo(wallet.address, '🕐', `[${marketAddress.substring(0, 8)}...] In last ${STOP_LOSS_MINUTES} minutes (${remMin}m remaining) - stop loss active if below ${STOP_LOSS_ODDS_THRESHOLD}%`);
          }

          // Check if in buy window
          if (remainingMs <= BUY_WINDOW_MINUTES * 60 * 1000 && remainingMs > 0) {
            inLastThirteenMinutes = true;
            logInfo(wallet.address, '🕐', `[${marketAddress.substring(0, 8)}...] In last ${BUY_WINDOW_MINUTES} minutes (${remMin}m remaining) - can buy if ${MIN_ODDS}-${MAX_ODDS}%`);
          }

          if (remainingMs < 5 * 60 * 1000) {
            nearDeadlineForBet = true;
            logInfo(wallet.address, '⏳', `[${marketAddress.substring(0, 8)}...] Time to deadline ${remMin}m < 5m — skip betting`);
          }
        }
      }

      if (!cachedContracts.has(marketAddress)) {
        try {
          logInfo(wallet.address, '🔄', `[${marketAddress.substring(0, 8)}...] Loading contracts...`);

          // Attach contracts directly to the wallet (signer) for ethers v6 compatibility
          const market = new ethers.Contract(marketAddress, MARKET_ABI, wallet);
          const usdc = new ethers.Contract(collateralTokenAddress, ERC20_ABI, wallet);

          // Use market.conditionalTokens() to get ERC1155 address with retry
          logInfo(wallet.address, '🔍', `[${marketAddress.substring(0, 8)}...] Fetching conditionalTokens address...`);
          const conditionalTokensAddress = await retryRpcCall(async () => await market.conditionalTokens());
          const erc1155 = new ethers.Contract(ethers.getAddress(conditionalTokensAddress), ERC1155_ABI, wallet);

          // Get decimals with retry
          logInfo(wallet.address, '🔍', `[${marketAddress.substring(0, 8)}...] Fetching decimals...`);
          const decimals = Number(await retryRpcCall(async () => await usdc.decimals()));

          // Sanity: verify contracts have code
          logInfo(wallet.address, '🔍', `[${marketAddress.substring(0, 8)}...] Verifying contract code...`);
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
          cachedContracts.set(marketAddress, { market, usdc, erc1155, decimals, conditionalTokensAddress });
          logInfo(wallet.address, '✅', `[${marketAddress.substring(0, 8)}...] Contracts loaded successfully (decimals=${decimals})`);
        } catch (e) {
          logErr(wallet.address, '💥', `[${marketAddress.substring(0, 8)}...] Failed to load contracts (will retry next tick): ${e?.code || e?.message || e}`);
          // Don't cache the error - allow retry on next tick
          return;
        }
      }

      const { market, usdc, erc1155, decimals } = cachedContracts.get(marketAddress);

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

        // Stop loss: sell if our position's odds drop below threshold in last 2 minutes
        if (inLastThreeMinutes) {
          const ourPositionPrice = prices[outcomeIndex];

          if (ourPositionPrice < STOP_LOSS_ODDS_THRESHOLD) {
            logInfo(wallet.address, '🚨', `[${marketAddress.substring(0, 8)}...] Stop loss! Last ${STOP_LOSS_MINUTES} minutes - our outcome ${outcomeIndex} odds at ${ourPositionPrice}% (below ${STOP_LOSS_ODDS_THRESHOLD}%)`);
            const approvedOk = await ensureErc1155Approval(wallet, erc1155, marketAddress);
            if (!approvedOk) {
              logWarn(wallet.address, '🛑', 'Approval not confirmed; skipping stop loss sell this tick.');
              return;
            }
            const maxOutcomeTokensToSell = tokenBalance;
            const returnAmountForSell = positionValue > 0n ? positionValue - (positionValue / 100n) : 0n; // minus 1% safety
            logInfo(wallet.address, '🧮', `Stop loss sell: maxTokens=${maxOutcomeTokensToSell}, returnAmount=${returnAmountForSell}`);
            const gasEst = await estimateGasFor(market, wallet, 'sell', [returnAmountForSell, outcomeIndex, maxOutcomeTokensToSell]);
            if (!gasEst) {
              logWarn(wallet.address, '🛑', 'Gas estimate sell failed; skipping stop loss sell this tick.');
              return;
            }
            logInfo(wallet.address, '⛽', `Gas estimate sell: ${gasEst}`);
            const padded = (gasEst * 120n) / 100n + 10000n;
            const sellOv = await txOverrides(wallet.provider, padded);
            logInfo(wallet.address, '💸', `Sending stop loss sell transaction: returnAmount=${returnAmountForSell}, outcome=${outcomeIndex}, maxTokens=${maxOutcomeTokensToSell}`);
            const tx = await market.sell(returnAmountForSell, outcomeIndex, maxOutcomeTokensToSell, sellOv);
            logInfo(wallet.address, '🧾', `Stop loss sell tx: ${tx.hash}`);
            const sellReceipt = await tx.wait(CONFIRMATIONS);

            // Calculate PNL for stop loss
            const pnlUSDC = parseFloat(ethers.formatUnits(positionValue - cost, decimals));
            logInfo(wallet.address, '✅', `[${marketAddress.substring(0, 8)}...] Stop loss sell completed. Odds: ${ourPositionPrice}% (below ${STOP_LOSS_ODDS_THRESHOLD}%)`);

            // Log sell trade and update stats
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
              reason: `Stop loss - odds ${ourPositionPrice}% < ${STOP_LOSS_ODDS_THRESHOLD}%`,
              txHash: tx.hash,
              blockNumber: sellReceipt.blockNumber,
              gasUsed: sellReceipt.gasUsed.toString()
            });
            updateStats(pnlUSDC);

            removeHolding(wallet.address, marketAddress);
            markMarketCompleted(wallet.address, marketAddress);
            return;
          }
        }

        // Determine profit target based on strategy
        const strategyType = localHoldingThisMarket.strategy || 'default';
        const profitTarget = strategyType === 'early_contrarian' ? EARLY_PROFIT_TARGET_PCT : TARGET_PROFIT_PCT;

        // Hold positions during last 13 minutes if using last-minute strategy - don't take profits early
        if (inLastThirteenMinutes && strategyType === 'default') {
          logInfo(wallet.address, '💎', `[${marketAddress.substring(0, 8)}...] Holding position until market closes (last 13min strategy)`);
          return;
        }

        if (pnlAbs > 0n && pnlPct >= profitTarget) {
          logInfo(wallet.address, '🎯', `Profit target reached! PnL=${pnlPct.toFixed(2)}% >= ${profitTarget}% (${strategyType} strategy). Initiating sell...`);
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
          const profitSellReceipt = await tx.wait(CONFIRMATIONS);

          // Calculate PNL for profit taking
          const pnlUSDC = parseFloat(ethers.formatUnits(pnlAbs, decimals));
          logInfo(wallet.address, '✅', `[${marketAddress.substring(0, 8)}...] Sell completed. Final PnL: ${signEmoji}${pnlAbsHuman} USDC (${pnlPct.toFixed(2)}%)`);

          // Log sell trade and update stats
          logTrade({
            type: 'SELL_PROFIT',
            wallet: wallet.address,
            marketAddress,
            marketTitle: marketInfo?.title || 'Unknown',
            outcome: outcomeIndex,
            costUSDC: ethers.formatUnits(cost, decimals),
            returnUSDC: ethers.formatUnits(positionValue, decimals),
            pnlUSDC: pnlUSDC.toFixed(4),
            pnlPercent: pnlPct.toFixed(2),
            reason: `Profit target reached ${pnlPct.toFixed(2)}% >= ${TARGET_PROFIT_PCT}%`,
            txHash: tx.hash,
            blockNumber: profitSellReceipt.blockNumber,
            gasUsed: profitSellReceipt.gasUsed.toString()
          });
          updateStats(pnlUSDC);

          removeHolding(wallet.address, marketAddress);
          markMarketCompleted(wallet.address, marketAddress);
          logInfo(wallet.address, '🧭', `[${marketAddress.substring(0, 8)}...] Market completed, won't re-enter`);
          return;
        } else {
          logInfo(wallet.address, '📊', `[${marketAddress.substring(0, 8)}...] Not profitable yet: PnL=${pnlPct.toFixed(2)}% < ${profitTarget}% (${strategyType} strategy)`);
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

      // Prevent duplicate buys - check if buy is in progress or if we ever bought this market
      const marketKey = marketAddress.toLowerCase();
      if (buyingInProgress.has(marketKey)) {
        logInfo(wallet.address, '🔒', `[${marketAddress.substring(0, 8)}...] Buy already in progress for this market; skipping.`);
        return;
      }

      // Mark as buying NOW to prevent race conditions
      buyingInProgress.add(marketKey);

      // Additional guardrails for betting:
      const positionIdsValid = Array.isArray(positionIds) && positionIds.length >= 2 && positionIds[0] && positionIds[1];
      if (!positionIdsValid) {
        logWarn(wallet.address, '🛑', 'Position IDs missing/invalid — skip betting');
        return;
      }

      // NEW LOGIC: Check if we should use last 13 minutes strategy
      if (inLastThirteenMinutes) {
        // Check if in last 2 minutes - don't buy
        if (inLastTwoMinutes) {
          logInfo(wallet.address, '⏳', `[${marketAddress.substring(0, 8)}...] In last 2 minutes - not buying`);
          return;
        }

        // In last 13 minutes - IGNORE the "too new" check, only check if deadline is too close
        if (nearDeadlineForBet) {
          logWarn(wallet.address, '⏳', `[${marketAddress.substring(0, 8)}...] Too close to deadline - skipping`);
          return;
        }

        // Only buy if one side is in configured odds range
        const maxPrice = Math.max(...prices);
        if (maxPrice < MIN_ODDS || maxPrice > MAX_ODDS) {
          logInfo(wallet.address, '⏸️', `[${marketAddress.substring(0, 8)}...] In last ${BUY_WINDOW_MINUTES}min but no side in ${MIN_ODDS}-${MAX_ODDS}% range (prices: [${prices.join(', ')}]) - skipping`);
          return;
        }

        // Buy the side that is in odds range
        const outcomeToBuy = prices[0] >= MIN_ODDS && prices[0] <= MAX_ODDS ? 0 : 1;
        logInfo(wallet.address, '🎯', `[${marketAddress.substring(0, 8)}...] Last ${BUY_WINDOW_MINUTES}min strategy: Buying outcome ${outcomeToBuy} at ${prices[outcomeToBuy]}%`);

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

      // Early contrarian strategy: Buy opposite side if one side reaches 70%+ in first 30 minutes
      if (inEarlyWindow && !tooNewForBet && !nearDeadlineForBet) {
        // Check if either side has reached the trigger threshold
        const maxPrice = Math.max(...prices);

        if (maxPrice >= EARLY_TRIGGER_ODDS) {
          // Buy the opposite side (contrarian bet)
          const dominantSide = prices[0] >= EARLY_TRIGGER_ODDS ? 0 : 1;
          const outcomeToBuy = dominantSide === 0 ? 1 : 0;

          logInfo(wallet.address, '🔄', `[${marketAddress.substring(0, 8)}...] Early contrarian: Side ${dominantSide} at ${prices[dominantSide]}% (>= ${EARLY_TRIGGER_ODDS}%), buying opposite side ${outcomeToBuy} at ${prices[outcomeToBuy]}%`);

          const investmentHuman = BUY_AMOUNT_USDC;
          const investment = ethers.parseUnits(investmentHuman.toString(), decimals);

          // Check USDC balance
          logInfo(wallet.address, '🔍', `[${marketAddress.substring(0, 8)}...] Checking USDC balance...`);
          const usdcBal = await retryRpcCall(async () => await usdc.balanceOf(wallet.address));
          const usdcBalHuman = ethers.formatUnits(usdcBal, decimals);
          const needHuman = ethers.formatUnits(investment, decimals);
          logInfo(wallet.address, '💰', `USDC balance=${usdcBalHuman}, need=${needHuman} for buy`);
          if (usdcBal < investment) {
            logWarn(wallet.address, '⚠️', `Insufficient USDC balance. Need ${needHuman}, have ${usdcBalHuman}.`);
            return;
          }

          // Execute buy with early_contrarian strategy flag
          await executeBuy(wallet, market, usdc, marketAddress, investment, outcomeToBuy, decimals, pid0, pid1, erc1155, 'early_contrarian');
          return;
        } else {
          logInfo(wallet.address, '⏸️', `[${marketAddress.substring(0, 8)}...] In early window but max odds ${maxPrice}% < ${EARLY_TRIGGER_ODDS}% trigger - waiting`);
          return;
        }
      }

      // Not in last 13 minutes - check age/deadline restrictions
      if (tooNewForBet || nearDeadlineForBet) {
        // Market too new or too close to deadline - skip
        return;
      }

      // Regular buy logic is DISABLED - only using configured strategies (early contrarian + late timing)
      logInfo(wallet.address, '⏸️', `[${marketAddress.substring(0, 8)}...] Not in any strategy window - waiting`);
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
  console.log(`\n⏰ Active Time Windows:`);
  if (AUTO_REDEEM_ENABLED) {
    console.log(`   💰 Redemption: Minutes ${REDEEM_WINDOW_START}-${REDEEM_WINDOW_END} (claim resolved positions)`);
  }
  if (EARLY_STRATEGY_ENABLED) {
    console.log(`   🌅 Early Trading: Minutes 0-${EARLY_WINDOW_MINUTES} (contrarian buys)`);
  }
  console.log(`   🎯 Late Trading: Minutes ${60 - BUY_WINDOW_MINUTES}-60 (last minute strategy)`);

  // Calculate sleep periods
  const sleepPeriods = [];
  if (AUTO_REDEEM_ENABLED && REDEEM_WINDOW_END < (EARLY_STRATEGY_ENABLED ? EARLY_WINDOW_MINUTES : (60 - BUY_WINDOW_MINUTES))) {
    sleepPeriods.push(`${REDEEM_WINDOW_END + 1}-${EARLY_STRATEGY_ENABLED ? EARLY_WINDOW_MINUTES : (60 - BUY_WINDOW_MINUTES - 1)}`);
  }
  if (EARLY_STRATEGY_ENABLED && EARLY_WINDOW_MINUTES < (60 - BUY_WINDOW_MINUTES - 1)) {
    sleepPeriods.push(`${EARLY_WINDOW_MINUTES + 1}-${60 - BUY_WINDOW_MINUTES - 1}`);
  }
  if (sleepPeriods.length > 0) {
    console.log(`   💤 Sleep Mode: Minutes ${sleepPeriods.join(', ')} (saves RPC calls)`);
  }

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
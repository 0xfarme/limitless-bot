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

// NEW: Support multiple oracle IDs (comma-separated)
const PRICE_ORACLE_IDS = (process.env.PRICE_ORACLE_IDS || process.env.PRICE_ORACLE_ID || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const FREQUENCY = process.env.FREQUENCY || 'hourly';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);
const BUY_AMOUNT_USDC = process.env.BUY_AMOUNT_USDC ? Number(process.env.BUY_AMOUNT_USDC) : 1;
const TARGET_PROFIT_PCT = process.env.TARGET_PROFIT_PCT ? Number(process.env.TARGET_PROFIT_PCT) : 12;
const STOP_LOSS_PCT = process.env.STOP_LOSS_PCT ? Number(process.env.STOP_LOSS_PCT) : -8;
const SLIPPAGE_BPS = process.env.SLIPPAGE_BPS ? Number(process.env.SLIPPAGE_BPS) : 150;
const GAS_PRICE_GWEI = process.env.GAS_PRICE_GWEI ? String(process.env.GAS_PRICE_GWEI) : '0.005';
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || '1', 10);
const STRATEGY_MODE = (process.env.STRATEGY_MODE || 'dominant').toLowerCase();
const TRIGGER_PCT = process.env.TRIGGER_PCT ? Number(process.env.TRIGGER_PCT) : 55;
const TRIGGER_BAND = process.env.TRIGGER_BAND ? Number(process.env.TRIGGER_BAND) : 5;

const PRIVATE_KEYS = (process.env.PRIVATE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const STATE_FILE = process.env.STATE_FILE || path.join('data', 'state.json');
const TRADES_LOG_FILE = process.env.TRADES_LOG_FILE || path.join('data', 'trades.log');
const SUMMARY_FILE = process.env.SUMMARY_FILE || path.join('data', 'summary.json');

// Validation
if (!RPC_URL) {
  console.error('RPC_URL is required');
  process.exit(1);
}
if (PRICE_ORACLE_IDS.length === 0) {
  console.error('PRICE_ORACLE_IDS or PRICE_ORACLE_ID is required');
  process.exit(1);
}
if (PRIVATE_KEYS.length === 0) {
  console.error('PRIVATE_KEYS is required (comma separated)');
  process.exit(1);
}

const MAX_GAS_ETH = process.env.MAX_GAS_ETH ? Number(process.env.MAX_GAS_ETH) : 0.015;
const MAX_GAS_WEI = ethers.parseEther(String(MAX_GAS_ETH));

// ========= State Management =========
// Structure: Map<walletAddress, Map<marketAddress, { holding, completed }>>
const userState = new Map();

// Trade tracking for summary
const tradeHistory = []; // Array of trade records

function getWalletState(addr) {
  if (!userState.has(addr)) {
    userState.set(addr, new Map());
  }
  return userState.get(addr);
}

function setHolding(addr, marketAddress, holding) {
  const walletState = getWalletState(addr);
  const marketState = walletState.get(marketAddress) || { holding: null, completed: false };
  marketState.holding = holding;
  walletState.set(marketAddress, marketState);
  scheduleSave();
}

function getHolding(addr, marketAddress) {
  const walletState = getWalletState(addr);
  const marketState = walletState.get(marketAddress);
  return marketState ? marketState.holding : null;
}

function isMarketCompleted(addr, marketAddress) {
  const walletState = getWalletState(addr);
  const marketState = walletState.get(marketAddress);
  return marketState ? marketState.completed : false;
}

function markMarketCompleted(addr, marketAddress) {
  const walletState = getWalletState(addr);
  const marketState = walletState.get(marketAddress) || { holding: null, completed: false };
  marketState.completed = true;
  walletState.set(marketAddress, marketState);
  scheduleSave();
}

// ========= Trade Logging =========
function logTrade(walletAddress, marketAddress, marketTitle, outcome, action, amount, pnl = null, pnlPct = null) {
  const timestamp = new Date().toISOString();
  const record = {
    timestamp,
    wallet: walletAddress,
    market: marketAddress,
    marketTitle,
    outcome,
    action, // 'BUY' or 'SELL'
    amount,
    pnl: pnl !== null ? Number(pnl) : null,
    pnlPct: pnlPct !== null ? Number(pnlPct) : null
  };
  
  tradeHistory.push(record);
  
  // Append to log file
  try {
    ensureDirSync(path.dirname(TRADES_LOG_FILE));
    const logLine = `${timestamp} | ${walletAddress.slice(0, 8)} | ${action} | ${marketTitle} | Outcome ${outcome} | Amount: ${amount}${pnl !== null ? ` | PnL: ${pnlPct.toFixed(2)}%` : ''}\n`;
    fs.appendFileSync(TRADES_LOG_FILE, logLine);
  } catch (e) {
    console.warn('Failed to write trade log:', e.message);
  }
  
  // Update summary
  updateSummary();
}

function updateSummary() {
  try {
    ensureDirSync(path.dirname(SUMMARY_FILE));
    
    const completedTrades = tradeHistory.filter(t => t.action === 'SELL' && t.pnl !== null);
    const wins = completedTrades.filter(t => t.pnl > 0).length;
    const losses = completedTrades.filter(t => t.pnl < 0).length;
    const totalPnL = completedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalPnLPct = completedTrades.reduce((sum, t) => sum + (t.pnlPct || 0), 0);
    const avgPnLPct = completedTrades.length > 0 ? totalPnLPct / completedTrades.length : 0;
    
    const summary = {
      lastUpdated: new Date().toISOString(),
      totalTrades: completedTrades.length,
      wins,
      losses,
      winRate: completedTrades.length > 0 ? ((wins / completedTrades.length) * 100).toFixed(2) + '%' : '0%',
      totalPnL: totalPnL.toFixed(4),
      avgPnLPerTrade: (totalPnL / Math.max(completedTrades.length, 1)).toFixed(4),
      avgPnLPct: avgPnLPct.toFixed(2) + '%',
      recentTrades: completedTrades.slice(-10).reverse() // Last 10 trades
    };
    
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  } catch (e) {
    console.warn('Failed to update summary:', e.message);
  }
}

function loadTradeHistory() {
  // Trade history is ephemeral per session, but we could load from log file if needed
  // For now, just initialize empty
  return [];
}

// ========= Logging =========
function logInfo(addr, emoji, msg) {
  console.log(`${emoji} [${addr.slice(0, 6)}...${addr.slice(-4)}] ${msg}`);
}
function logWarn(addr, emoji, msg) {
  console.warn(`${emoji} [${addr.slice(0, 6)}...${addr.slice(-4)}] ${msg}`);
}
function logErr(addr, emoji, msg, err) {
  console.error(`${emoji} [${addr.slice(0, 6)}...${addr.slice(-4)}] ${msg}`, err || '');
}

// ========= Persistence =========
function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function serializeState() {
  const out = {};
  for (const [addr, marketMap] of userState.entries()) {
    out[addr] = {};
    for (const [marketAddr, state] of marketMap.entries()) {
      out[addr][marketAddr] = {
        holding: state.holding ? {
          outcomeIndex: state.holding.outcomeIndex,
          tokenId: state.holding.tokenId != null ? String(state.holding.tokenId) : null,
          amount: state.holding.amount != null ? String(state.holding.amount) : null,
          cost: state.holding.cost != null ? String(state.holding.cost) : null,
        } : null,
        completed: state.completed
      };
    }
  }
  return out;
}

function deserializeState(obj) {
  const map = new Map();
  if (!obj || typeof obj !== 'object') return map;
  for (const addr of Object.keys(obj)) {
    const marketMap = new Map();
    const markets = obj[addr] || {};
    for (const marketAddr of Object.keys(markets)) {
      const state = markets[marketAddr] || {};
      marketMap.set(marketAddr, {
        holding: state.holding ? {
          outcomeIndex: state.holding.outcomeIndex,
          tokenId: state.holding.tokenId != null ? BigInt(state.holding.tokenId) : null,
          amount: state.holding.amount != null ? BigInt(state.holding.amount) : null,
          cost: state.holding.cost != null ? BigInt(state.holding.cost) : null,
        } : null,
        completed: state.completed || false
      });
    }
    map.set(addr, marketMap);
  }
  return map;
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    try {
      ensureDirSync(path.dirname(STATE_FILE));
      fs.writeFileSync(STATE_FILE, JSON.stringify(serializeState(), null, 2));
      console.log(`💾 State saved`);
    } catch (e) {
      console.warn('⚠️ Save failed:', e.message);
    } finally {
      saveTimer = null;
    }
  }, 100);
}

function loadStateSync() {
  try {
    if (!fs.existsSync(STATE_FILE)) return new Map();
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    console.log(`📂 State loaded`);
    return deserializeState(JSON.parse(raw));
  } catch (e) {
    console.warn('⚠️ Load failed:', e.message);
    return new Map();
  }
}

// ========= Utilities =========
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
    return Number.isNaN(n) ? s : n.toFixed(precision);
  } catch (_) {
    return String(amount);
  }
}

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
  ov.maxFeePerGas = suggested;
  ov.maxPriorityFeePerGas = priority;
  return ov;
}

async function estimateGasFor(contract, wallet, fnName, args) {
  try {
    const data = contract.interface.encodeFunctionData(fnName, args);
    return await wallet.provider.estimateGas({
      from: wallet.address,
      to: contract.target,
      data
    });
  } catch (e) {
    return null;
  }
}

// ========= Market Fetching =========
async function fetchMarket(oracleId) {
  const url = `https://api.limitless.exchange/markets/prophet?priceOracleId=${oracleId}&frequency=${FREQUENCY}`;
  try {
    const res = await axios.get(url, { timeout: 15000 });
    
    // Log the response for debugging
    if (res.data && res.data.market) {
      console.log(`📡 Oracle ${oracleId}: ${res.data.market.title || 'Untitled'} | Active: ${res.data.isActive} | Address: ${res.data.market.address}`);
    }
    
    return res.data;
  } catch (e) {
    console.warn(`Failed to fetch oracle ${oracleId}: ${e.message}`);
    return null;
  }
}

async function fetchAllMarkets() {
  const promises = PRICE_ORACLE_IDS.map(id => fetchMarket(id));
  const results = await Promise.allSettled(promises);
  
  const markets = [];
  results.forEach((result, idx) => {
    if (result.status === 'fulfilled' && result.value) {
      markets.push({
        oracleId: PRICE_ORACLE_IDS[idx],
        data: result.value
      });
    }
  });
  
  return markets;
}

// ========= Strategy =========
function pickOutcome(prices) {
  if (STRATEGY_MODE === 'dominant') {
    const p0ok = prices[0] >= TRIGGER_PCT;
    const p1ok = prices[1] >= TRIGGER_PCT;
    if (p0ok || p1ok) return prices[0] >= prices[1] ? 0 : 1;
    return null;
  } else {
    const low = TRIGGER_PCT - TRIGGER_BAND;
    const high = TRIGGER_PCT + TRIGGER_BAND;
    if (prices[0] >= low && prices[0] <= high) return 1;
    if (prices[1] >= low && prices[1] <= high) return 0;
    return null;
  }
}

function validateMarketTiming(marketInfo, wallet) {
  const nowMs = Date.now();
  
  if (marketInfo.createdAt) {
    const createdMs = new Date(marketInfo.createdAt).getTime();
    if (!Number.isNaN(createdMs)) {
      const ageMs = nowMs - createdMs;
      if (ageMs < 10 * 60 * 1000) {
        const ageMin = Math.floor(ageMs / 60000);
        logInfo(wallet.address, '⏳', `Market age ${ageMin}m < 10m - skip`);
        return false;
      }
    }
  }
  
  if (marketInfo.deadline) {
    const deadlineMs = new Date(marketInfo.deadline).getTime();
    if (!Number.isNaN(deadlineMs)) {
      const remainingMs = deadlineMs - nowMs;
      if (remainingMs < 5 * 60 * 1000) {
        const remMin = Math.floor(remainingMs / 60000);
        logInfo(wallet.address, '⏰', `Deadline in ${remMin}m < 5m - skip`);
        return false;
      }
    }
  }
  
  return true;
}

// ========= Approval Functions =========
async function readAllowance(usdc, owner, spender) {
  try {
    // Try direct call first
    const allowance = await usdc.allowance(owner, spender);
    return allowance;
  } catch (e) {
    // Fallback 1: Try staticCall
    try {
      const allowance = await usdc.allowance.staticCall(owner, spender);
      return allowance;
    } catch (e2) {
      // Fallback 2: Manual call encoding
      try {
        const iface = usdc.interface;
        const data = iface.encodeFunctionData('allowance', [owner, spender]);
        const result = await usdc.runner.provider.call({
          to: await usdc.getAddress(),
          data: data
        });
        const decoded = iface.decodeFunctionResult('allowance', result);
        return decoded[0];
      } catch (e3) {
        // If all methods fail, assume zero allowance and log warning
        console.warn(`Warning: Could not read allowance, assuming 0. Error: ${e3.message}`);
        return 0n;
      }
    }
  }
}

async function ensureUsdcApproval(wallet, usdc, marketAddress, needed) {
  let current;
  try {
    current = await readAllowance(usdc, wallet.address, marketAddress);
    logInfo(wallet.address, '🔍', `Current allowance: ${ethers.formatUnits(current, 6)} USDC`);
  } catch (e) {
    logWarn(wallet.address, '⚠️', `Allowance read failed, assuming 0`);
    current = 0n;
  }
  
  if (current >= needed) {
    logInfo(wallet.address, '✅', `Sufficient allowance already set`);
    return true;
  }
  
  logInfo(wallet.address, '🔓', `Approving ${ethers.formatUnits(needed, 6)} USDC...`);
  
  // Some tokens require resetting to 0 first (like USDT)
  if (current > 0n) {
    try {
      logInfo(wallet.address, '🔄', `Resetting allowance to 0 first...`);
      const gasEst0 = await estimateGasFor(usdc, wallet, 'approve', [marketAddress, 0n]);
      if (!gasEst0) {
        logWarn(wallet.address, '⚠️', 'Skipping reset, proceeding to approve');
      } else {
        const pad0 = (gasEst0 * 120n) / 100n + 10000n;
        const tx0 = await usdc.approve(marketAddress, 0n, await txOverrides(wallet.provider, pad0));
        logInfo(wallet.address, '🧾', `Reset tx: ${tx0.hash.slice(0, 10)}...`);
        await tx0.wait(CONFIRMATIONS);
        await delay(1000); // Give it time to settle
      }
    } catch (e) {
      logWarn(wallet.address, '⚠️', `Reset to 0 failed: ${e.message}`);
      // Continue anyway, might still work
    }
  }
  
  try {
    const gasEst = await estimateGasFor(usdc, wallet, 'approve', [marketAddress, needed]);
    if (!gasEst) {
      logErr(wallet.address, '❌', 'Gas estimate for approve failed');
      return false;
    }
    
    const pad = (gasEst * 120n) / 100n + 10000n;
    const tx = await usdc.approve(marketAddress, needed, await txOverrides(wallet.provider, pad));
    logInfo(wallet.address, '🧾', `Approve tx: ${tx.hash.slice(0, 10)}...`);
    await tx.wait(CONFIRMATIONS);
    
    // Wait and verify
    await delay(1000);
    try {
      const after = await readAllowance(usdc, wallet.address, marketAddress);
      const success = after >= needed;
      logInfo(wallet.address, success ? '✅' : '⚠️', `Allowance after: ${ethers.formatUnits(after, 6)} USDC`);
      return success;
    } catch (e) {
      // Assume success if we can't read
      logWarn(wallet.address, '⚠️', 'Could not verify allowance, assuming success');
      return true;
    }
  } catch (e) {
    logErr(wallet.address, '💥', 'Approval failed', e.message);
    return false;
  }
}

async function ensureErc1155Approval(wallet, erc1155, operator) {
  for (let i = 0; i < 3; i++) {
    try {
      const approved = await erc1155.isApprovedForAll(wallet.address, operator);
      if (approved) return true;
      break;
    } catch (e) {
      await delay(400);
    }
  }
  
  const gasEst = await estimateGasFor(erc1155, wallet, 'setApprovalForAll', [operator, true]);
  if (!gasEst) return false;
  
  try {
    const pad = (gasEst * 120n) / 100n + 10000n;
    const tx = await erc1155.setApprovalForAll(operator, true, await txOverrides(wallet.provider, pad));
    await tx.wait(CONFIRMATIONS);
    return true;
  } catch (e) {
    logErr(wallet.address, '💥', 'ERC1155 approval failed', e.message);
    return false;
  }
}

// ========= Contract Cache =========
const contractCache = new Map(); // key: marketAddress, value: { market, usdc, erc1155, decimals }

async function getContracts(wallet, provider, marketAddress, collateralTokenAddress) {
  const cacheKey = marketAddress;
  if (contractCache.has(cacheKey)) {
    return contractCache.get(cacheKey);
  }
  
  try {
    // Verify contracts have code before trying to interact
    const [marketHasCode, usdcHasCode] = await Promise.all([
      isContract(provider, marketAddress),
      isContract(provider, collateralTokenAddress)
    ]);
    
    if (!marketHasCode) {
      throw new Error(`Market contract has no code at ${marketAddress}`);
    }
    if (!usdcHasCode) {
      throw new Error(`USDC contract has no code at ${collateralTokenAddress}`);
    }
    
    const market = new ethers.Contract(marketAddress, MARKET_ABI, wallet);
    const usdc = new ethers.Contract(collateralTokenAddress, ERC20_ABI, wallet);
    
    // Try to get conditionalTokens address
    let conditionalTokensAddress;
    try {
      conditionalTokensAddress = await market.conditionalTokens();
      
      // Verify it returned a valid address
      if (!conditionalTokensAddress || conditionalTokensAddress === ethers.ZeroAddress) {
        throw new Error('conditionalTokens returned zero address');
      }
    } catch (e) {
      throw new Error(`Failed to get conditionalTokens address: ${e.message}`);
    }
    
    const erc1155 = new ethers.Contract(ethers.getAddress(conditionalTokensAddress), ERC1155_ABI, wallet);
    const decimals = Number(await usdc.decimals());
    
    const contracts = { market, usdc, erc1155, decimals };
    contractCache.set(cacheKey, contracts);
    
    logInfo(wallet.address, '✅', `Contracts loaded for market`);
    
    return contracts;
  } catch (e) {
    throw new Error(`Contract init failed: ${e.message}`);
  }
}

// ========= Main Trading Logic for Single Market =========
async function processMarket(wallet, provider, oracleId, marketData) {
  try {
    if (!marketData || !marketData.market || !marketData.market.address || !marketData.isActive) {
      logWarn(wallet.address, '⏸️', `Oracle ${oracleId}: Market not active or missing data`);
      return;
    }

    const marketInfo = marketData.market;
    const marketAddress = ethers.getAddress(marketInfo.address);
    const prices = marketInfo.prices || [];
    const positionIds = marketInfo.positionIds || [];
    const collateralTokenAddress = ethers.getAddress(marketInfo.collateralToken.address);

    logInfo(wallet.address, '📊', `Oracle ${oracleId}: ${marketInfo.title || 'Untitled'}`);
    
    // Log key market info for debugging
    if (prices.length >= 2) {
      logInfo(wallet.address, '💹', `Prices: ${prices[0]}/${prices[1]}`);
    }

    // Validate timing
    if (!validateMarketTiming(marketInfo, wallet)) {
      return;
    }

    // Get contracts
    let contracts;
    try {
      contracts = await getContracts(wallet, provider, marketAddress, collateralTokenAddress);
    } catch (e) {
      logErr(wallet.address, '❌', `Contract load failed: ${e.message}`);
      return;
    }

    const { market, usdc, erc1155, decimals } = contracts;

    // Check position
    const localHolding = getHolding(wallet.address, marketAddress);
    const pid0 = positionIds[0] ? BigInt(positionIds[0]) : null;
    const pid1 = positionIds[1] ? BigInt(positionIds[1]) : null;

    let bal0 = pid0 !== null ? await safeBalanceOf(erc1155, wallet.address, pid0) : 0n;
    let bal1 = pid1 !== null ? await safeBalanceOf(erc1155, wallet.address, pid1) : 0n;

    const hasPosition = (bal0 > 0n) || (bal1 > 0n) || !!localHolding;

    if (hasPosition) {
      // CRITICAL: Already have a position in this market, do not open another
      logInfo(wallet.address, '🔒', `Already holding position in this market - managing exit`);
      
      // Manage existing position
      let outcomeIndex = bal0 > 0n ? 0 : 1;
      let tokenId = bal0 > 0n ? pid0 : pid1;
      let tokenBalance = bal0 > 0n ? bal0 : bal1;

      let holding = localHolding;
      if (!holding || holding.tokenId !== tokenId) {
        const assumedCost = ethers.parseUnits(BUY_AMOUNT_USDC.toString(), decimals);
        holding = { outcomeIndex, tokenId, amount: tokenBalance, cost: assumedCost };
        setHolding(wallet.address, marketAddress, holding);
        logInfo(wallet.address, '💾', `Initialized cost: $${BUY_AMOUNT_USDC}`);
      }

      const cost = holding.cost;
      let tokensNeededForCost;
      try {
        tokensNeededForCost = await market.calcSellAmount(cost, outcomeIndex);
      } catch (e) {
        logErr(wallet.address, '💥', 'calcSellAmount failed', e.message);
        return;
      }

      if (tokensNeededForCost === 0n) {
        logWarn(wallet.address, '⚠️', 'calcSellAmount returned 0');
        return;
      }

      const positionValue = (tokenBalance * cost) / tokensNeededForCost;
      const pnlAbs = positionValue - cost;
      const pnlPct = cost > 0n ? Number((pnlAbs * 10000n) / cost) / 100 : 0;

      const valueHuman = fmtUnitsPrec(positionValue, decimals);
      const pnlSign = pnlAbs >= 0n ? '📈' : '📉';
      
      logInfo(wallet.address, pnlSign, `Value: ${valueHuman} | PnL: ${pnlPct.toFixed(1)}%`);

      if (pnlAbs > 0n && pnlPct >= TARGET_PROFIT_PCT) {
        const approvedOk = await ensureErc1155Approval(wallet, erc1155, marketAddress);
        if (!approvedOk) {
          logWarn(wallet.address, '🛑', 'ERC1155 approval failed');
          return;
        }

        const maxOutcomeTokensToSell = tokenBalance;
        const returnAmountForSell = positionValue - (positionValue / 100n);
        
        const gasEst = await estimateGasFor(market, wallet, 'sell', [returnAmountForSell, outcomeIndex, maxOutcomeTokensToSell]);
        if (!gasEst) {
          logWarn(wallet.address, '🛑', 'Sell gas estimate failed');
          return;
        }

        const padded = (gasEst * 120n) / 100n + 10000n;
        const tx = await market.sell(returnAmountForSell, outcomeIndex, maxOutcomeTokensToSell, await txOverrides(wallet.provider, padded));
        
        logInfo(wallet.address, '🧾', `Sell tx: ${tx.hash.slice(0, 10)}...`);
        await tx.wait(CONFIRMATIONS);
        logInfo(wallet.address, '✅', `SOLD at ${pnlPct.toFixed(1)}% profit`);
        
        // Log the trade
        const pnlAmount = Number(ethers.formatUnits(pnlAbs, decimals));
        logTrade(
          wallet.address,
          marketAddress,
          marketInfo.title || 'Unknown Market',
          outcomeIndex,
          'SELL',
          Number(ethers.formatUnits(cost, decimals)),
          pnlAmount,
          pnlPct
        );
        
        setHolding(wallet.address, marketAddress, null);
        markMarketCompleted(wallet.address, marketAddress);
        
        return;
      }

      logInfo(wallet.address, '⏳', 'Holding position');
      return;
    }

    // No position - look for entry
    if (!Array.isArray(prices) || prices.length < 2) {
      return;
    }

    if (isMarketCompleted(wallet.address, marketAddress)) {
      logInfo(wallet.address, '🧭', 'Market already completed - skipping');
      return;
    }
    
    // CRITICAL CHECK: Ensure we don't have any position in this market
    // This prevents opening multiple positions in the same market
    if (bal0 > 0n || bal1 > 0n || localHolding) {
      logInfo(wallet.address, '🔒', 'Position exists - cannot open another in same market');
      return;
    }

    const positionIdsValid = Array.isArray(positionIds) && positionIds.length >= 2 && positionIds[0] && positionIds[1];
    if (!positionIdsValid) {
      logWarn(wallet.address, '🛑', 'Invalid position IDs');
      return;
    }

    const outcomeToBuy = pickOutcome(prices);
    if (outcomeToBuy === null) {
      logInfo(wallet.address, '🔎', `No signal (${prices[0]}/${prices[1]})`);
      return;
    }

    const investment = ethers.parseUnits(BUY_AMOUNT_USDC.toString(), decimals);

    const usdcBal = await usdc.balanceOf(wallet.address);
    if (usdcBal < investment) {
      logWarn(wallet.address, '⚠️', 'Insufficient USDC');
      return;
    }

    const allowanceOk = await ensureUsdcApproval(wallet, usdc, marketAddress, investment);
    if (!allowanceOk) {
      logWarn(wallet.address, '🛑', 'USDC approval failed');
      return;
    }

    const expectedTokens = await market.calcBuyAmount(investment, outcomeToBuy);
    const minOutcomeTokensToBuy = expectedTokens - (expectedTokens * BigInt(SLIPPAGE_BPS)) / 10000n;
    
    logInfo(wallet.address, '🛒', `BUY outcome ${outcomeToBuy} for $${BUY_AMOUNT_USDC}`);

    const gasEst = await estimateGasFor(market, wallet, 'buy', [investment, outcomeToBuy, minOutcomeTokensToBuy]);
    if (!gasEst) {
      logWarn(wallet.address, '🛑', 'Buy gas estimate failed');
      return;
    }

    const padded = (gasEst * 120n) / 100n + 10000n;
    const tx = await market.buy(investment, outcomeToBuy, minOutcomeTokensToBuy, await txOverrides(wallet.provider, padded));
    
    logInfo(wallet.address, '🧾', `Buy tx: ${tx.hash.slice(0, 10)}...`);
    await tx.wait(CONFIRMATIONS);
    logInfo(wallet.address, '✅', 'BUY completed');

    const tokenId = outcomeToBuy === 0 ? pid0 : pid1;
    
    // Log the buy trade
    logTrade(
      wallet.address,
      marketAddress,
      marketInfo.title || 'Unknown Market',
      outcomeToBuy,
      'BUY',
      BUY_AMOUNT_USDC,
      null,
      null
    );
    
    setHolding(wallet.address, marketAddress, {
      outcomeIndex: outcomeToBuy,
      tokenId,
      amount: investment,
      cost: investment
    });

    // Confirm balance
    for (let i = 0; i < 3; i++) {
      const balNow = await safeBalanceOf(erc1155, wallet.address, tokenId);
      if (balNow > 0n) {
        logInfo(wallet.address, '🎟️', `Balance: ${balNow} tokens`);
        break;
      }
      await delay(1000);
    }

  } catch (err) {
    logErr(wallet.address, '💥', 'Error processing market', err.message);
  }
}

// ========= Main Wallet Worker =========
async function runForWallet(wallet, provider) {
  logInfo(wallet.address, '🚀', `Worker started for ${PRICE_ORACLE_IDS.length} markets`);

  async function tick() {
    const markets = await fetchAllMarkets();
    
    if (markets.length === 0) {
      logWarn(wallet.address, '⏸️', 'No active markets');
      return;
    }

    logInfo(wallet.address, '🔄', `Processing ${markets.length} markets...`);

    // Process markets sequentially to avoid race conditions
    for (const { oracleId, data } of markets) {
      await processMarket(wallet, provider, oracleId, data);
    }
  }

  await tick();
  return setInterval(tick, POLL_INTERVAL_MS);
}

// ========= Main Entry Point =========
async function main() {
  console.log('🚀 Starting Multi-Market Limitless Bot');
  console.log('🎯 VOLUME + CAPITAL PRESERVATION MODE');
  console.log(`📊 Strategy: ${STRATEGY_MODE.toUpperCase()}`);
  console.log(`💰 Position size: ${BUY_AMOUNT_USDC}`);
  console.log(`📈 Target profit: ${TARGET_PROFIT_PCT}% | Stop loss: ${STOP_LOSS_PCT}%`);
  console.log(`🎚️ Entry trigger: ${TRIGGER_PCT}% | Slippage: ${(SLIPPAGE_BPS / 100).toFixed(2)}%`);
  console.log(`⏱️ Poll interval: ${POLL_INTERVAL_MS / 1000}s | Confirmations: ${CONFIRMATIONS}`);
  console.log(`🎯 Tracking ${PRICE_ORACLE_IDS.length} oracle(s): ${PRICE_ORACLE_IDS.join(', ')}`);
  console.log('');
  
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  try {
    const net = await provider.getNetwork();
    console.log(`🌐 Connected to chainId=${net.chainId}`);
    if (Number(net.chainId) !== CHAIN_ID) {
      console.error(`❌ Wrong network: expected ${CHAIN_ID}, got ${net.chainId}`);
      process.exit(1);
    }
  } catch (e) {
    console.error('💥 Network check failed:', e.message);
    process.exit(1);
  }

  const wallets = PRIVATE_KEYS.map(pk => {
    const key = pk.startsWith('0x') ? pk : '0x' + pk;
    return new ethers.Wallet(key, provider);
  });

  // Load state
  const persisted = loadStateSync();
  for (const [addr, marketMap] of persisted.entries()) {
    userState.set(addr, marketMap);
  }
  
  // Initialize trade history (starts fresh each session)
  loadTradeHistory();

  for (const w of wallets) {
    console.log(`🔑 Loaded wallet: ${w.address.slice(0, 6)}...${w.address.slice(-4)}`);
  }
  
  // Print initial summary if exists
  if (fs.existsSync(SUMMARY_FILE)) {
    try {
      const summary = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'));
      console.log(`📊 Previous session: ${summary.totalTrades} trades | Win rate: ${summary.winRate} | Total PnL: ${summary.totalPnL}`);
    } catch (e) {
      // Ignore
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

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
const BUY_AMOUNT_USDC = process.env.BUY_AMOUNT_USDC ? Number(process.env.BUY_AMOUNT_USDC) : 2;
const TARGET_PROFIT_PCT = process.env.TARGET_PROFIT_PCT ? Number(process.env.TARGET_PROFIT_PCT) : 12;
const STOP_LOSS_PCT = process.env.STOP_LOSS_PCT ? Number(process.env.STOP_LOSS_PCT) : -8;
const SLIPPAGE_BPS = process.env.SLIPPAGE_BPS ? Number(process.env.SLIPPAGE_BPS) : 150;
const GAS_PRICE_GWEI = process.env.GAS_PRICE_GWEI ? String(process.env.GAS_PRICE_GWEI) : '0.005';
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || '1', 10);
const STRATEGY_MODE = (process.env.STRATEGY_MODE || 'dominant').toLowerCase();
const TRIGGER_PCT = process.env.TRIGGER_PCT ? Number(process.env.TRIGGER_PCT) : 55;
const TRIGGER_BAND = process.env.TRIGGER_BAND ? Number(process.env.TRIGGER_BAND) : 5;

// Trailing profit settings
const ENABLE_TRAILING_PROFIT = process.env.ENABLE_TRAILING_PROFIT === 'true';
const TRAILING_DISTANCE_PCT = process.env.TRAILING_DISTANCE_PCT ? Number(process.env.TRAILING_DISTANCE_PCT) : 5;
const TRAILING_MAX_TIME_MINUTES = process.env.TRAILING_MAX_TIME_MINUTES ? Number(process.env.TRAILING_MAX_TIME_MINUTES) : 10;

// Partial exit strategy
const ENABLE_PARTIAL_EXITS = process.env.ENABLE_PARTIAL_EXITS === 'true';
const PARTIAL_EXIT_PCT = process.env.PARTIAL_EXIT_PCT ? Number(process.env.PARTIAL_EXIT_PCT) : 50; // Sell 50% at target
const PARTIAL_EXIT_TRIGGER = process.env.PARTIAL_EXIT_TRIGGER ? Number(process.env.PARTIAL_EXIT_TRIGGER) : 8; // Trigger at 8% profit

// Time-based risk management
const MIN_TIME_TO_ENTER_MINUTES = process.env.MIN_TIME_TO_ENTER_MINUTES ? Number(process.env.MIN_TIME_TO_ENTER_MINUTES) : 20;
const MIN_TIME_TO_EXIT_MINUTES = process.env.MIN_TIME_TO_EXIT_MINUTES ? Number(process.env.MIN_TIME_TO_EXIT_MINUTES) : 5;
const TIME_DECAY_THRESHOLD_MINUTES = process.env.TIME_DECAY_THRESHOLD_MINUTES ? Number(process.env.TIME_DECAY_THRESHOLD_MINUTES) : 15;
const ENABLE_TIME_BASED_EXITS = process.env.ENABLE_TIME_BASED_EXITS !== 'false'; // Default true

// Global position management
const MAX_CONCURRENT_POSITIONS = process.env.MAX_CONCURRENT_POSITIONS ? Number(process.env.MAX_CONCURRENT_POSITIONS) : 5;

// Simulation mode
const SIMULATION_MODE = process.env.SIMULATION_MODE === 'true';
const SIMULATION_BALANCE_USDC = process.env.SIMULATION_BALANCE_USDC ? Number(process.env.SIMULATION_BALANCE_USDC) : 100;

const PRIVATE_KEYS = (process.env.PRIVATE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const STATE_FILE = process.env.STATE_FILE || path.join('data', 'state.json');
const TRADES_LOG_FILE = process.env.TRADES_LOG_FILE || path.join('data', 'trades.log');
const TRADES_CSV_FILE = process.env.TRADES_CSV_FILE || path.join('data', 'trades.csv');
const SUMMARY_FILE = process.env.SUMMARY_FILE || path.join('data', 'summary.json');
const ANALYTICS_FILE = process.env.ANALYTICS_FILE || path.join('data', 'analytics.json');
const FAILED_EXITS_FILE = process.env.FAILED_EXITS_FILE || path.join('data', 'failed_exits.json');

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

// Failed exits tracking - prevents re-entry until manually resolved
const failedExits = new Map(); // key: marketAddress, value: { timestamp, reason, pnl, attempts }

// Simulation state
const simulationBalances = new Map(); // key: walletAddress, value: balance in USDC

// Trading locks to prevent concurrent buys on same market
const tradingLocks = new Map(); // key: `${walletAddress}-${marketAddress}`, value: timestamp

function getWalletState(addr) {
  if (!userState.has(addr)) {
    userState.set(addr, new Map());
  }
  return userState.get(addr);
}

function loadFailedExits() {
  try {
    if (!fs.existsSync(FAILED_EXITS_FILE)) return new Map();
    const raw = fs.readFileSync(FAILED_EXITS_FILE, 'utf8');
    const data = JSON.parse(raw);
    const map = new Map();
    for (const [market, info] of Object.entries(data)) {
      map.set(market.toLowerCase(), info);
    }
    console.log(`⚠️ Loaded ${map.size} markets with failed exits`);
    return map;
  } catch (e) {
    console.warn('Failed to load failed exits:', e.message);
    return new Map();
  }
}

function saveFailedExits() {
  try {
    ensureDirSync(path.dirname(FAILED_EXITS_FILE));
    const obj = {};
    for (const [market, info] of failedExits.entries()) {
      obj[market] = info;
    }
    fs.writeFileSync(FAILED_EXITS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.warn('Failed to save failed exits:', e.message);
  }
}

function markExitFailed(marketAddress, wallet, reason, pnl, marketTitle) {
  const key = marketAddress.toLowerCase();
  const existing = failedExits.get(key);
  
  const record = {
    marketAddress,
    marketTitle,
    wallet,
    firstFailure: existing?.firstFailure || new Date().toISOString(),
    lastFailure: new Date().toISOString(),
    reason,
    pnl,
    attempts: (existing?.attempts || 0) + 1,
    status: 'BLOCKED' // Manual intervention required
  };
  
  failedExits.set(key, record);
  saveFailedExits();
  
  console.error(`🚫 Market ${marketAddress} BLOCKED due to failed exit. Check failed_exits.json`);
}

function isMarketBlocked(marketAddress) {
  const blocked = failedExits.has(marketAddress.toLowerCase());
  if (blocked) {
    const info = failedExits.get(marketAddress.toLowerCase());
    console.warn(`🚫 Skipping blocked market: ${info.marketTitle} (failed ${info.attempts}x, last: ${info.lastFailure})`);
  }
  return blocked;
}

function setHolding(addr, marketAddress, holding) {
  const walletState = getWalletState(addr);
  const marketState = walletState.get(marketAddress) || { holding: null, completed: false };
  marketState.holding = holding;
  walletState.set(marketAddress, marketState);
  scheduleSave();
}

function updatePeakPnL(addr, marketAddress, currentPnL) {
  const walletState = getWalletState(addr);
  const marketState = walletState.get(marketAddress);
  if (!marketState || !marketState.holding) return;

  if (marketState.holding.peakPnLPct === undefined || currentPnL > marketState.holding.peakPnLPct) {
    marketState.holding.peakPnLPct = currentPnL;
    scheduleSave();
  }
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

function countActivePositions(addr) {
  const walletState = getWalletState(addr);
  let count = 0;
  for (const [marketAddr, state] of walletState.entries()) {
    if (state.holding && !state.completed) {
      count++;
    }
  }
  return count;
}

function getSimulationBalance(addr) {
  if (!simulationBalances.has(addr)) {
    simulationBalances.set(addr, SIMULATION_BALANCE_USDC);
  }
  return simulationBalances.get(addr);
}

function updateSimulationBalance(addr, delta) {
  const current = getSimulationBalance(addr);
  const newBalance = current + delta;
  simulationBalances.set(addr, newBalance);
  return newBalance;
}

function markMarketCompleted(addr, marketAddress) {
  const walletState = getWalletState(addr);
  const marketState = walletState.get(marketAddress) || { holding: null, completed: false };
  marketState.completed = true;
  walletState.set(marketAddress, marketState);
  scheduleSave();
}

// ========= Trade Logging =========
function logTrade(walletAddress, marketAddress, marketTitle, outcome, action, amount, pnl = null, pnlPct = null, entryPrice = null, exitPrice = null, holdTimeMinutes = null, gasUsed = null, exitReason = null, peakPnLPct = null) {
  const timestamp = new Date().toISOString();
  const record = {
    timestamp,
    wallet: walletAddress,
    market: marketAddress,
    marketTitle,
    outcome,
    action, // 'BUY' or 'SELL'
    amount,
    entryPrice,
    exitPrice,
    pnl: pnl !== null ? Number(pnl) : null,
    pnlPct: pnlPct !== null ? Number(pnlPct) : null,
    holdTimeMinutes,
    gasUsed: gasUsed !== null ? Number(gasUsed) : null,
    exitReason,
    peakPnLPct: peakPnLPct !== null ? Number(peakPnLPct) : null
  };
  
  tradeHistory.push(record);
  
  // Append to human-readable log file
  try {
    ensureDirSync(path.dirname(TRADES_LOG_FILE));
    if (action === 'BUY') {
      const logLine = `${timestamp} | ${walletAddress.slice(0, 8)} | BUY | ${marketTitle} | Outcome ${outcome} | Amount: ${amount} | Price: ${entryPrice}%\n`;
      fs.appendFileSync(TRADES_LOG_FILE, logLine);
    } else {
      const exitReasonStr = exitReason ? ` | Reason: ${exitReason}` : '';
      const peakStr = peakPnLPct ? ` | Peak: ${peakPnLPct.toFixed(2)}%` : '';
      const logLine = `${timestamp} | ${walletAddress.slice(0, 8)} | SELL | ${marketTitle} | Outcome ${outcome} | Amount: ${amount} | PnL: ${pnlPct.toFixed(2)}%${peakStr} | Hold: ${holdTimeMinutes}m | Gas: ${gasUsed.toFixed(4)}${exitReasonStr}\n`;
      fs.appendFileSync(TRADES_LOG_FILE, logLine);
    }
  } catch (e) {
    console.warn('Failed to write trade log:', e.message);
  }
  
  // Append to CSV for analysis
  try {
    ensureDirSync(path.dirname(TRADES_CSV_FILE));
    const csvExists = fs.existsSync(TRADES_CSV_FILE);
    
    if (!csvExists) {
      // Write header
      const header = 'timestamp,wallet,market,marketTitle,outcome,action,amount,entryPrice,exitPrice,pnl,pnlPct,holdTimeMinutes,gasUsed,exitReason,peakPnLPct\n';
      fs.writeFileSync(TRADES_CSV_FILE, header);
    }

    const csvLine = `${timestamp},${walletAddress},${marketAddress},"${marketTitle}",${outcome},${action},${amount},${entryPrice || ''},${exitPrice || ''},${pnl || ''},${pnlPct || ''},${holdTimeMinutes || ''},${gasUsed || ''},${exitReason || ''},${peakPnLPct || ''}\n`;
    fs.appendFileSync(TRADES_CSV_FILE, csvLine);
  } catch (e) {
    console.warn('Failed to write CSV:', e.message);
  }
  
  // Update summary
  updateSummary();
  
  // Update analytics
  updateAnalytics();
}

function updateAnalytics() {
  try {
    ensureDirSync(path.dirname(ANALYTICS_FILE));
    
    const completedTrades = tradeHistory.filter(t => t.action === 'SELL' && t.pnl !== null);
    
    if (completedTrades.length === 0) return;
    
    // Overall stats
    const wins = completedTrades.filter(t => t.pnl > 0);
    const losses = completedTrades.filter(t => t.pnl < 0);
    const totalPnL = completedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalGas = completedTrades.reduce((sum, t) => sum + (t.gasUsed || 0), 0);
    const netPnL = totalPnL - totalGas;
    
    // By outcome
    const outcome0Trades = completedTrades.filter(t => t.outcome === 0);
    const outcome1Trades = completedTrades.filter(t => t.outcome === 1);
    
    const outcome0Wins = outcome0Trades.filter(t => t.pnl > 0).length;
    const outcome1Wins = outcome1Trades.filter(t => t.pnl > 0).length;
    
    // By price range at entry
    const priceRanges = {
      '50-60': completedTrades.filter(t => t.entryPrice >= 50 && t.entryPrice < 60),
      '60-70': completedTrades.filter(t => t.entryPrice >= 60 && t.entryPrice < 70),
      '70-80': completedTrades.filter(t => t.entryPrice >= 70 && t.entryPrice < 80),
      '80-90': completedTrades.filter(t => t.entryPrice >= 80 && t.entryPrice < 90),
      '90-100': completedTrades.filter(t => t.entryPrice >= 90)
    };
    
    const priceRangeStats = {};
    for (const [range, trades] of Object.entries(priceRanges)) {
      if (trades.length > 0) {
        const rangeWins = trades.filter(t => t.pnl > 0).length;
        const avgPnL = trades.reduce((sum, t) => sum + t.pnlPct, 0) / trades.length;
        priceRangeStats[range] = {
          count: trades.length,
          wins: rangeWins,
          winRate: ((rangeWins / trades.length) * 100).toFixed(1) + '%',
          avgPnLPct: avgPnL.toFixed(2) + '%'
        };
      }
    }
    
    // Hold time analysis
    const avgHoldTime = completedTrades.reduce((sum, t) => sum + (t.holdTimeMinutes || 0), 0) / completedTrades.length;
    const shortTrades = completedTrades.filter(t => t.holdTimeMinutes < 15);
    const mediumTrades = completedTrades.filter(t => t.holdTimeMinutes >= 15 && t.holdTimeMinutes < 30);
    const longTrades = completedTrades.filter(t => t.holdTimeMinutes >= 30);
    
    // Best and worst trades
    const sortedByPnL = [...completedTrades].sort((a, b) => b.pnlPct - a.pnlPct);
    const bestTrades = sortedByPnL.slice(0, 5).map(t => ({
      market: t.marketTitle,
      outcome: t.outcome,
      pnlPct: t.pnlPct.toFixed(2) + '%',
      entryPrice: t.entryPrice + '%',
      holdTime: t.holdTimeMinutes + 'm'
    }));
    const worstTrades = sortedByPnL.slice(-5).reverse().map(t => ({
      market: t.marketTitle,
      outcome: t.outcome,
      pnlPct: t.pnlPct.toFixed(2) + '%',
      entryPrice: t.entryPrice + '%',
      holdTime: t.holdTimeMinutes + 'm'
    }));
    
    const analytics = {
      lastUpdated: new Date().toISOString(),
      summary: {
        totalTrades: completedTrades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: ((wins.length / completedTrades.length) * 100).toFixed(2) + '%',
        totalPnL: totalPnL.toFixed(4),
        totalGas: totalGas.toFixed(4),
        netPnL: netPnL.toFixed(4),
        avgPnLPerTrade: (totalPnL / completedTrades.length).toFixed(4),
        avgPnLPct: (completedTrades.reduce((sum, t) => sum + t.pnlPct, 0) / completedTrades.length).toFixed(2) + '%',
        avgHoldTimeMinutes: avgHoldTime.toFixed(1)
      },
      byOutcome: {
        outcome0: {
          trades: outcome0Trades.length,
          wins: outcome0Wins,
          winRate: outcome0Trades.length > 0 ? ((outcome0Wins / outcome0Trades.length) * 100).toFixed(1) + '%' : '0%',
          avgPnLPct: outcome0Trades.length > 0 ? (outcome0Trades.reduce((sum, t) => sum + t.pnlPct, 0) / outcome0Trades.length).toFixed(2) + '%' : '0%'
        },
        outcome1: {
          trades: outcome1Trades.length,
          wins: outcome1Wins,
          winRate: outcome1Trades.length > 0 ? ((outcome1Wins / outcome1Trades.length) * 100).toFixed(1) + '%' : '0%',
          avgPnLPct: outcome1Trades.length > 0 ? (outcome1Trades.reduce((sum, t) => sum + t.pnlPct, 0) / outcome1Trades.length).toFixed(2) + '%' : '0%'
        }
      },
      byEntryPriceRange: priceRangeStats,
      byHoldTime: {
        short: {
          label: '< 15 minutes',
          count: shortTrades.length,
          avgPnLPct: shortTrades.length > 0 ? (shortTrades.reduce((sum, t) => sum + t.pnlPct, 0) / shortTrades.length).toFixed(2) + '%' : '0%'
        },
        medium: {
          label: '15-30 minutes',
          count: mediumTrades.length,
          avgPnLPct: mediumTrades.length > 0 ? (mediumTrades.reduce((sum, t) => sum + t.pnlPct, 0) / mediumTrades.length).toFixed(2) + '%' : '0%'
        },
        long: {
          label: '30+ minutes',
          count: longTrades.length,
          avgPnLPct: longTrades.length > 0 ? (longTrades.reduce((sum, t) => sum + t.pnlPct, 0) / longTrades.length).toFixed(2) + '%' : '0%'
        }
      },
      bestTrades,
      worstTrades
    };
    
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analytics, null, 2));
  } catch (e) {
    console.warn('Failed to update analytics:', e.message);
  }
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
          peakPnLPct: state.holding.peakPnLPct !== undefined ? state.holding.peakPnLPct : undefined,
          entryTime: state.holding.entryTime || null,
          entryPrice: state.holding.entryPrice || null,
          partialExitDone: state.holding.partialExitDone || false,
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
          peakPnLPct: state.holding.peakPnLPct !== undefined ? state.holding.peakPnLPct : undefined,
          entryTime: state.holding.entryTime || null,
          entryPrice: state.holding.entryPrice || null,
          partialExitDone: state.holding.partialExitDone || false,
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
function pickOutcome(prices, marketInfo = null) {
  const [p0, p1] = prices;

  // Hybrid strategy: Mode switches based on time remaining
  let effectiveMode = STRATEGY_MODE;

  if (STRATEGY_MODE === 'hybrid' && marketInfo && marketInfo.deadline) {
    const nowMs = Date.now();
    const deadlineMs = new Date(marketInfo.deadline).getTime();
    if (!Number.isNaN(deadlineMs)) {
      const remainingMinutes = (deadlineMs - nowMs) / 60000;

      // Early phase (>30 min): Mean reversion (opposite)
      // Late phase (<=30 min): Momentum (dominant)
      if (remainingMinutes > 30) {
        effectiveMode = 'opposite';
      } else {
        effectiveMode = 'dominant';
      }
    }
  }

  if (effectiveMode === 'dominant') {
    // DOMINANT: Buy the side that is >= TRIGGER_PCT (choose the higher if both)
    const p0ok = p0 >= TRIGGER_PCT;
    const p1ok = p1 >= TRIGGER_PCT;
    if (p0ok || p1ok) {
      return p0 >= p1 ? 0 : 1;
    }
    return null;
  } else {
    // OPPOSITE/CONTRARIAN: if a side is within TRIGGER_BAND of TRIGGER_PCT, buy the opposite side
    const low = TRIGGER_PCT - TRIGGER_BAND;
    const high = TRIGGER_PCT + TRIGGER_BAND;
    if (p0 >= low && p0 <= high) return 1;
    if (p1 >= low && p1 <= high) return 0;
    return null;
  }
}

function validateMarketTiming(marketInfo, wallet) {
  const nowMs = Date.now();
  
  if (marketInfo.createdAt) {
    const createdMs = new Date(marketInfo.createdAt).getTime();
    if (!Number.isNaN(createdMs)) {
      const ageMs = nowMs - createdMs;
      const minAgeMinutes = 3; // Reduced from 10 to 3 minutes
      if (ageMs < minAgeMinutes * 60 * 1000) {
        const ageMin = Math.floor(ageMs / 60000);
        logInfo(wallet.address, '⏳', `Market age ${ageMin}m < ${minAgeMinutes}m - skip`);
        return false;
      }
    }
  }
  
  if (marketInfo.deadline) {
    const deadlineMs = new Date(marketInfo.deadline).getTime();
    if (!Number.isNaN(deadlineMs)) {
      const remainingMs = deadlineMs - nowMs;
      const remainingMinutes = remainingMs / 60000;
      
      // Don't enter if too close to deadline
      if (remainingMinutes < MIN_TIME_TO_ENTER_MINUTES) {
        logInfo(wallet.address, '⏰', `Only ${remainingMinutes.toFixed(1)}m left < ${MIN_TIME_TO_ENTER_MINUTES}m - too risky to enter`);
        return false;
      }
    }
  }
  
  return true;
}

function calculateTimeBasedAdjustments(marketInfo) {
  const nowMs = Date.now();
  const result = {
    remainingMinutes: null,
    positionSizeMultiplier: 1.0,
    profitTargetMultiplier: 1.0,
    stopLossMultiplier: 1.0,
    shouldForceExit: false,
    timePhase: 'unknown'
  };
  
  if (!marketInfo.deadline) return result;
  
  const deadlineMs = new Date(marketInfo.deadline).getTime();
  if (Number.isNaN(deadlineMs)) return result;
  
  const remainingMs = deadlineMs - nowMs;
  const remainingMinutes = remainingMs / 60000;
  result.remainingMinutes = remainingMinutes;
  
  // Define time phases in hourly market (assumes 60-min duration)
  if (remainingMinutes > 30) {
    // Early phase: 30+ minutes left
    result.timePhase = 'early';
    result.positionSizeMultiplier = 1.0; // Full size
    result.profitTargetMultiplier = 1.0; // Normal target
    result.stopLossMultiplier = 1.0; // Normal stop
  } 
  else if (remainingMinutes > 20) {
    // Mid phase: 20-30 minutes left
    result.timePhase = 'mid';
    result.positionSizeMultiplier = 1.0; // Full size
    result.profitTargetMultiplier = 1.0; // Normal target
    result.stopLossMultiplier = 1.0; // Normal stop
  }
  else if (remainingMinutes > TIME_DECAY_THRESHOLD_MINUTES) {
    // Late phase: 15-20 minutes left
    result.timePhase = 'late';
    result.positionSizeMultiplier = 0.75; // Reduce position size
    result.profitTargetMultiplier = 0.85; // Lower profit target (12% → 10.2%)
    result.stopLossMultiplier = 0.75; // Tighter stop loss (-8% → -6%)
  }
  else if (remainingMinutes > MIN_TIME_TO_EXIT_MINUTES) {
    // Critical phase: 5-15 minutes left
    result.timePhase = 'critical';
    result.positionSizeMultiplier = 0.5; // Half size only
    result.profitTargetMultiplier = 0.7; // Much lower target (12% → 8.4%)
    result.stopLossMultiplier = 0.5; // Much tighter stop (-8% → -4%)
  }
  else {
    // Danger zone: < 5 minutes - force exit any position
    result.timePhase = 'danger';
    result.shouldForceExit = true;
  }
  
  return result;
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
    
    // Try to get conditionalTokens address with multiple strategies
    let conditionalTokensAddress;
    try {
      // Strategy 1: Direct call
      conditionalTokensAddress = await market.conditionalTokens();
      
      // Verify it returned a valid address
      if (!conditionalTokensAddress || conditionalTokensAddress === ethers.ZeroAddress) {
        throw new Error('returned zero address');
      }
    } catch (e) {
      // Strategy 2: Try with staticCall
      try {
        conditionalTokensAddress = await market.conditionalTokens.staticCall();
        if (!conditionalTokensAddress || conditionalTokensAddress === ethers.ZeroAddress) {
          throw new Error('returned zero address');
        }
      } catch (e2) {
        // Strategy 3: Manual encoding
        try {
          const iface = market.interface;
          const data = iface.encodeFunctionData('conditionalTokens', []);
          const result = await provider.call({
            to: marketAddress,
            data: data
          });
          conditionalTokensAddress = iface.decodeFunctionResult('conditionalTokens', result)[0];
          if (!conditionalTokensAddress || conditionalTokensAddress === ethers.ZeroAddress) {
            throw new Error('returned zero address');
          }
        } catch (e3) {
          throw new Error(`All strategies failed. Last error: ${e3.message}`);
        }
      }
    }
    
    const erc1155 = new ethers.Contract(ethers.getAddress(conditionalTokensAddress), ERC1155_ABI, wallet);
    const decimals = Number(await usdc.decimals());
    
    const contracts = { market, usdc, erc1155, decimals };
    contractCache.set(cacheKey, contracts);
    
    logInfo(wallet.address, '✅', `Contracts loaded (CT: ${conditionalTokensAddress.slice(0, 10)}...)`);
    
    return contracts;
  } catch (e) {
    throw new Error(`${e.message}`);
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
    
    // Check if market is blocked due to previous failed exit
    if (isMarketBlocked(marketAddress)) {
      return;
    }

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

    // Get contracts (skip in simulation mode for now, use defaults)
    let contracts;
    let decimals = 6; // USDC decimals
    let market = null;
    let usdc = null;
    let erc1155 = null;

    if (!SIMULATION_MODE) {
      try {
        contracts = await getContracts(wallet, provider, marketAddress, collateralTokenAddress);
        market = contracts.market;
        usdc = contracts.usdc;
        erc1155 = contracts.erc1155;
        decimals = contracts.decimals;
      } catch (e) {
        logErr(wallet.address, '❌', `Contract load failed: ${e.message}`);
        return;
      }
    }

    // Check position (optimized to reduce RPC calls)
    const localHolding = getHolding(wallet.address, marketAddress);
    const pid0 = positionIds[0] ? BigInt(positionIds[0]) : null;
    const pid1 = positionIds[1] ? BigInt(positionIds[1]) : null;

    // Only check balances if we don't have local holding info, or to verify
    let bal0 = 0n;
    let bal1 = 0n;

    if (SIMULATION_MODE) {
      // In simulation, trust local state
      if (localHolding) {
        const knownTokenId = localHolding.tokenId;
        if (knownTokenId === pid0) {
          bal0 = localHolding.amount || 0n;
        } else if (knownTokenId === pid1) {
          bal1 = localHolding.amount || 0n;
        }
      }
    } else {
      if (localHolding) {
        // We have local state, only check the known position
        const knownTokenId = localHolding.tokenId;
        if (knownTokenId === pid0) {
          bal0 = await safeBalanceOf(erc1155, wallet.address, pid0);
        } else if (knownTokenId === pid1) {
          bal1 = await safeBalanceOf(erc1155, wallet.address, pid1);
        }
      } else {
        // No local state, check both positions
        bal0 = pid0 !== null ? await safeBalanceOf(erc1155, wallet.address, pid0) : 0n;
        bal1 = pid1 !== null ? await safeBalanceOf(erc1155, wallet.address, pid1) : 0n;
      }
    }

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

      if (SIMULATION_MODE) {
        // Simulate: Use current market price to estimate tokens needed
        const currentPrice = prices[outcomeIndex];
        // Approximate: tokens needed = cost / (price/100)
        // If price is 60%, each token is worth ~0.60 USDC
        const priceRatio = currentPrice / 100;
        tokensNeededForCost = cost / BigInt(Math.max(1, Math.floor(priceRatio * 1000000))) * 1000000n;
        if (tokensNeededForCost === 0n) tokensNeededForCost = cost; // Fallback
      } else {
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
      }

      const positionValue = (tokenBalance * cost) / tokensNeededForCost;
      const pnlAbs = positionValue - cost;
      const pnlPct = cost > 0n ? Number((pnlAbs * 10000n) / cost) / 100 : 0;

      const valueHuman = fmtUnitsPrec(positionValue, decimals);
      const pnlSign = pnlAbs >= 0n ? '📈' : '📉';

      // Update peak PnL for trailing stop
      updatePeakPnL(wallet.address, marketAddress, pnlPct);

      // Get peak PnL from holding
      const peakPnLPct = holding.peakPnLPct !== undefined ? holding.peakPnLPct : pnlPct;

      // Calculate time-based adjustments
      const timeAdjustments = calculateTimeBasedAdjustments(marketInfo);

      // Dynamic profit target and stop loss based on time remaining
      const adjustedProfitTarget = TARGET_PROFIT_PCT * timeAdjustments.profitTargetMultiplier;
      const adjustedStopLoss = STOP_LOSS_PCT * timeAdjustments.stopLossMultiplier;

      // Calculate trailing stop loss (now with dynamic distance)
      const trailingDistance = TRAILING_DISTANCE_PCT * timeAdjustments.stopLossMultiplier;
      let trailingStopLoss = adjustedStopLoss;
      let shouldSellReason = null;

      if (ENABLE_TRAILING_PROFIT && peakPnLPct > 0) {
        // Trailing stop: sell if we drop from peak
        trailingStopLoss = peakPnLPct - trailingDistance;

        if (pnlPct <= trailingStopLoss) {
          shouldSellReason = `Trailing stop hit (Peak: ${peakPnLPct.toFixed(1)}%, Now: ${pnlPct.toFixed(1)}%, Drop: ${trailingDistance.toFixed(1)}%)`;
        }
      }

      // Force exit if in danger zone
      if (timeAdjustments.shouldForceExit && ENABLE_TIME_BASED_EXITS) {
        shouldSellReason = `FORCE EXIT: <${MIN_TIME_TO_EXIT_MINUTES}m to deadline`;
      }

      const timeInfo = timeAdjustments.remainingMinutes !== null ? ` | Time: ${timeAdjustments.remainingMinutes.toFixed(1)}m (${timeAdjustments.timePhase})` : '';
      const partialExitStatus = holding.partialExitDone ? ' | Partial✓' : '';
      logInfo(wallet.address, pnlSign, `Value: ${valueHuman} | PnL: ${pnlPct.toFixed(1)}% | Peak: ${peakPnLPct.toFixed(1)}% | Target: ${adjustedProfitTarget.toFixed(1)}% | Stop: ${trailingStopLoss.toFixed(1)}%${timeInfo}${partialExitStatus}`);

      // Check for partial exit trigger
      if (ENABLE_PARTIAL_EXITS && !holding.partialExitDone && pnlPct >= PARTIAL_EXIT_TRIGGER && pnlPct < adjustedProfitTarget) {
        logInfo(wallet.address, '📊', `Partial exit triggered at ${pnlPct.toFixed(1)}% - selling ${PARTIAL_EXIT_PCT}%`);

        const tokensToSell = (tokenBalance * BigInt(PARTIAL_EXIT_PCT)) / 100n;
        const partialValue = (tokensToSell * cost) / tokensNeededForCost;
        let gasUsedEth = 0;

        if (SIMULATION_MODE) {
          // Simulation mode
          const proceeds = Number(ethers.formatUnits(partialValue, decimals));
          const newBalance = updateSimulationBalance(wallet.address, proceeds);

          logInfo(wallet.address, '🎮', `[SIM] PARTIAL EXIT: Sold ${PARTIAL_EXIT_PCT}% | Proceeds: $${proceeds.toFixed(4)} | Balance: ${newBalance.toFixed(2)} USDC`);
          gasUsedEth = 0.0002;
        } else {
          // Real mode
          const approvedOk = await ensureErc1155Approval(wallet, erc1155, marketAddress);
          if (!approvedOk) {
            logWarn(wallet.address, '🛑', 'ERC1155 approval failed for partial exit');
            return;
          }

          const returnAmountForSell = partialValue - (partialValue / 100n);

          const gasEst = await estimateGasFor(market, wallet, 'sell', [returnAmountForSell, outcomeIndex, tokensToSell]);
          if (!gasEst) {
            return;
          }

          const padded = (gasEst * 120n) / 100n + 10000n;
          const tx = await market.sell(returnAmountForSell, outcomeIndex, tokensToSell, await txOverrides(wallet.provider, padded));

          logInfo(wallet.address, '🧾', `Partial exit tx: ${tx.hash.slice(0, 10)}...`);
          const receipt = await tx.wait(CONFIRMATIONS);

          const gasUsedBigInt = receipt.gasUsed * receipt.gasPrice;
          gasUsedEth = Number(ethers.formatEther(gasUsedBigInt));

          logInfo(wallet.address, '✅', `PARTIAL EXIT: Sold ${PARTIAL_EXIT_PCT}% at ${pnlPct.toFixed(1)}% profit`);
        }

        // Update holding to mark partial exit done and adjust amount
        holding.partialExitDone = true;
        holding.amount = tokenBalance - tokensToSell;
        setHolding(wallet.address, marketAddress, holding);

        // Log partial exit as a trade
        const partialPnl = Number(ethers.formatUnits(partialValue - (cost * BigInt(PARTIAL_EXIT_PCT) / 100n), decimals));
        const entryTime = holding.entryTime || Date.now();
        const holdTimeMs = Date.now() - entryTime;
        const holdTimeMinutes = holdTimeMs / 60000;
        const currentPrice = prices[outcomeIndex];

        logTrade(
          wallet.address,
          marketAddress,
          marketInfo.title || 'Unknown Market',
          outcomeIndex,
          'SELL',
          Number(ethers.formatUnits(cost * BigInt(PARTIAL_EXIT_PCT) / 100n, decimals)),
          partialPnl,
          pnlPct,
          holding.entryPrice || null,
          currentPrice || null,
          holdTimeMinutes,
          gasUsedEth,
          'PARTIAL_EXIT',
          peakPnLPct
        );

        return; // Return to check position again next cycle
      }

      if (pnlPct >= adjustedProfitTarget || pnlPct <= adjustedStopLoss || shouldSellReason) {
        // Determine exit reason
        let exitReason = 'UNKNOWN';
        if (shouldSellReason) {
          if (shouldSellReason.includes('FORCE EXIT')) {
            exitReason = 'TIME_BASED_EXIT';
          } else {
            exitReason = 'TRAILING_STOP';
          }
          logInfo(wallet.address, '🛑', shouldSellReason);
        } else if (pnlPct >= adjustedProfitTarget) {
          exitReason = 'PROFIT_TARGET';
          logInfo(wallet.address, '🎯', `Target profit reached: ${pnlPct.toFixed(1)}% (adjusted: ${adjustedProfitTarget.toFixed(1)}%)`);
        } else if (pnlPct <= adjustedStopLoss) {
          exitReason = 'STOP_LOSS';
          logInfo(wallet.address, '🛑', `Stop loss triggered: ${pnlPct.toFixed(1)}% (adjusted: ${adjustedStopLoss.toFixed(1)}%)`);
        }

        let gasUsedEth = 0;

        if (SIMULATION_MODE) {
          // Simulation mode - just calculate the proceeds
          const proceeds = Number(ethers.formatUnits(positionValue, decimals));
          const newBalance = updateSimulationBalance(wallet.address, proceeds);

          logInfo(wallet.address, '🎮', `[SIM] SELL at ${pnlPct.toFixed(1)}% | Proceeds: $${proceeds.toFixed(4)} | New balance: ${newBalance.toFixed(2)} USDC`);
          logInfo(wallet.address, '✅', `[SIM] SOLD | Reason: ${exitReason}`);

          // Simulate gas cost (typical: 0.0001-0.0005 ETH)
          gasUsedEth = 0.0002;
        } else {
          // Real mode
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
          const txStartTime = Date.now();
          const tx = await market.sell(returnAmountForSell, outcomeIndex, maxOutcomeTokensToSell, await txOverrides(wallet.provider, padded));

          logInfo(wallet.address, '🧾', `Sell tx: ${tx.hash.slice(0, 10)}...`);
          const receipt = await tx.wait(CONFIRMATIONS);

          // Calculate gas cost
          const gasUsedBigInt = receipt.gasUsed * receipt.gasPrice;
          gasUsedEth = Number(ethers.formatEther(gasUsedBigInt));

          logInfo(wallet.address, '✅', `SOLD at ${pnlPct.toFixed(1)}% | Reason: ${exitReason}`);
        }

        // Calculate hold time
        const entryTime = holding.entryTime || Date.now();
        const holdTimeMs = Date.now() - entryTime;
        const holdTimeMinutes = holdTimeMs / 60000;

        // Log the trade with full details
        const pnlAmount = Number(ethers.formatUnits(pnlAbs, decimals));
        const currentPrice = prices[outcomeIndex];

        logTrade(
          wallet.address,
          marketAddress,
          marketInfo.title || 'Unknown Market',
          outcomeIndex,
          'SELL',
          Number(ethers.formatUnits(cost, decimals)),
          pnlAmount,
          pnlPct,
          holding.entryPrice || null,
          currentPrice || null,
          holdTimeMinutes,
          gasUsedEth,
          exitReason,
          peakPnLPct
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

    const outcomeToBuy = pickOutcome(prices, marketInfo);
    if (outcomeToBuy === null) {
      logInfo(wallet.address, '🔎', `No signal (${prices[0]}/${prices[1]}) | Strategy: ${STRATEGY_MODE} | Trigger: ${TRIGGER_PCT}% ±${TRIGGER_BAND}%`);
      return;
    }

    // Determine effective mode for logging
    let effectiveMode = STRATEGY_MODE;
    if (STRATEGY_MODE === 'hybrid' && marketInfo.deadline) {
      const remainingMs = new Date(marketInfo.deadline).getTime() - Date.now();
      const remainingMinutes = remainingMs / 60000;
      effectiveMode = remainingMinutes > 30 ? 'opposite (hybrid-early)' : 'dominant (hybrid-late)';
    }

    logInfo(wallet.address, '📍', `SIGNAL DETECTED: Buy outcome ${outcomeToBuy} at ${prices[outcomeToBuy]}% | Strategy: ${effectiveMode}`);

    // Check global position limit
    const activePositions = countActivePositions(wallet.address);
    if (activePositions >= MAX_CONCURRENT_POSITIONS) {
      logWarn(wallet.address, '🚫', `Max concurrent positions reached (${activePositions}/${MAX_CONCURRENT_POSITIONS}) - skipping`);
      return;
    }

    const investment = ethers.parseUnits(BUY_AMOUNT_USDC.toString(), decimals);

    if (SIMULATION_MODE) {
      // Simulation mode - check virtual balance
      const simBalance = getSimulationBalance(wallet.address);
      if (simBalance < BUY_AMOUNT_USDC) {
        logWarn(wallet.address, '⚠️', `[SIM] Insufficient balance: ${simBalance.toFixed(2)} USDC`);
        return;
      }

      logInfo(wallet.address, '🎮', `[SIM] BUY outcome ${outcomeToBuy} for $${BUY_AMOUNT_USDC} | Balance: ${simBalance.toFixed(2)} USDC`);

      // Deduct from simulation balance
      const newBalance = updateSimulationBalance(wallet.address, -BUY_AMOUNT_USDC);
      logInfo(wallet.address, '✅', `[SIM] BUY completed | New balance: ${newBalance.toFixed(2)} USDC`);
    } else {
      // Real mode - actual transactions
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
    }

    const tokenId = outcomeToBuy === 0 ? pid0 : pid1;
    
    // Log the buy trade with entry price
    logTrade(
      wallet.address,
      marketAddress,
      marketInfo.title || 'Unknown Market',
      outcomeToBuy,
      'BUY',
      BUY_AMOUNT_USDC,
      null,
      null,
      prices[outcomeToBuy],
      null,
      null,
      null
    );
    
    setHolding(wallet.address, marketAddress, {
      outcomeIndex: outcomeToBuy,
      tokenId,
      amount: investment,
      cost: investment,
      entryTime: Date.now(),
      entryPrice: prices[outcomeToBuy]
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
  console.log(SIMULATION_MODE ? '🎮 SIMULATION MODE - NO REAL TRADES' : '🎯 LIVE TRADING MODE');
  console.log(`📊 Strategy: ${STRATEGY_MODE.toUpperCase()}`);
  console.log(`💰 Position size: ${BUY_AMOUNT_USDC} USDC | Max positions: ${MAX_CONCURRENT_POSITIONS}`);
  if (SIMULATION_MODE) {
    console.log(`💵 Starting balance: ${SIMULATION_BALANCE_USDC} USDC (virtual)`);
  }
  console.log(`📈 Target profit: ${TARGET_PROFIT_PCT}% | Stop loss: ${STOP_LOSS_PCT}%`);
  console.log(`🎚️ Entry trigger: ${TRIGGER_PCT}% ±${TRIGGER_BAND}% | Slippage: ${(SLIPPAGE_BPS / 100).toFixed(2)}%`);
  console.log(`📉 Trailing stop: ${ENABLE_TRAILING_PROFIT ? `${TRAILING_DISTANCE_PCT}%` : 'DISABLED'}`);
  console.log(`🎯 Partial exits: ${ENABLE_PARTIAL_EXITS ? `${PARTIAL_EXIT_PCT}% @ ${PARTIAL_EXIT_TRIGGER}%` : 'DISABLED'}`);
  console.log(`⏱️ Time-based exits: ${ENABLE_TIME_BASED_EXITS ? 'ENABLED' : 'DISABLED'} | Market age min: 3m`);
  console.log(`⏱️ Poll interval: ${POLL_INTERVAL_MS / 1000}s | Confirmations: ${CONFIRMATIONS}`);
  console.log(`🎯 Tracking ${PRICE_ORACLE_IDS.length} oracle(s): ${PRICE_ORACLE_IDS.join(', ')}`);
  console.log('');
  
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  if (!SIMULATION_MODE) {
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
  } else {
    console.log(`🎮 Simulation mode - skipping network validation`);
  }

  const wallets = SIMULATION_MODE
    ? [{ address: '0xSimulation' + Math.random().toString(36).substring(2, 10), provider }]
    : PRIVATE_KEYS.map(pk => {
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

    // Print simulation summary if in simulation mode
    if (SIMULATION_MODE) {
      console.log('\n' + '='.repeat(60));
      console.log('🎮 SIMULATION SUMMARY');
      console.log('='.repeat(60));

      for (const [addr, balance] of simulationBalances.entries()) {
        const startBalance = SIMULATION_BALANCE_USDC;
        const pnl = balance - startBalance;
        const pnlPct = ((pnl / startBalance) * 100).toFixed(2);
        const sign = pnl >= 0 ? '+' : '';

        console.log(`\n💼 Wallet: ${addr}`);
        console.log(`   Start: ${startBalance.toFixed(2)} USDC`);
        console.log(`   End:   ${balance.toFixed(2)} USDC`);
        console.log(`   PnL:   ${sign}${pnl.toFixed(2)} USDC (${sign}${pnlPct}%)`);
      }

      const completedTrades = tradeHistory.filter(t => t.action === 'SELL');
      if (completedTrades.length > 0) {
        const wins = completedTrades.filter(t => t.pnl > 0).length;
        const losses = completedTrades.filter(t => t.pnl <= 0).length;
        const winRate = ((wins / completedTrades.length) * 100).toFixed(1);

        console.log(`\n📊 Trade Stats:`);
        console.log(`   Total trades: ${completedTrades.length}`);
        console.log(`   Wins: ${wins} | Losses: ${losses}`);
        console.log(`   Win rate: ${winRate}%`);

        const exitReasons = {};
        completedTrades.forEach(t => {
          const reason = t.exitReason || 'UNKNOWN';
          exitReasons[reason] = (exitReasons[reason] || 0) + 1;
        });

        console.log(`\n🚪 Exit Reasons:`);
        for (const [reason, count] of Object.entries(exitReasons)) {
          console.log(`   ${reason}: ${count}`);
        }
      }

      console.log('\n' + '='.repeat(60) + '\n');
    }

    timers.forEach(t => clearInterval(t));
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});

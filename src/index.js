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

const PRICE_ORACLE_IDS = (process.env.PRICE_ORACLE_IDS || process.env.PRICE_ORACLE_ID || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const FREQUENCY = process.env.FREQUENCY || 'hourly';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);
const BUY_AMOUNT_USDC = process.env.BUY_AMOUNT_USDC ? Number(process.env.BUY_AMOUNT_USDC) : 2;
const TARGET_PROFIT_PCT = process.env.TARGET_PROFIT_PCT ? Number(process.env.TARGET_PROFIT_PCT) : 12;
const SLIPPAGE_BPS = process.env.SLIPPAGE_BPS ? Number(process.env.SLIPPAGE_BPS) : 150;
const GAS_PRICE_GWEI = process.env.GAS_PRICE_GWEI ? String(process.env.GAS_PRICE_GWEI) : '0.005';
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || '1', 10);
const STRATEGY_MODE = (process.env.STRATEGY_MODE || 'dominant').toLowerCase();
const TRIGGER_PCT = process.env.TRIGGER_PCT ? Number(process.env.TRIGGER_PCT) : 55;
const TRIGGER_BAND = process.env.TRIGGER_BAND ? Number(process.env.TRIGGER_BAND) : 5;

// NEW: Pre-approval settings
const PRE_APPROVE_USDC = process.env.PRE_APPROVE_USDC !== 'false'; // Default enabled
const PRE_APPROVAL_INTERVAL_MS = parseInt(process.env.PRE_APPROVAL_INTERVAL_MS || '3600000', 10); // 1 hour
const PRE_APPROVAL_AMOUNT_USDC = process.env.PRE_APPROVAL_AMOUNT_USDC ? Number(process.env.PRE_APPROVAL_AMOUNT_USDC) : 100;


// Time-based risk management
const MIN_TIME_TO_ENTER_MINUTES = process.env.MIN_TIME_TO_ENTER_MINUTES ? Number(process.env.MIN_TIME_TO_ENTER_MINUTES) : 20;
const MIN_TIME_TO_EXIT_MINUTES = process.env.MIN_TIME_TO_EXIT_MINUTES ? Number(process.env.MIN_TIME_TO_EXIT_MINUTES) : 5;
const TIME_DECAY_THRESHOLD_MINUTES = process.env.TIME_DECAY_THRESHOLD_MINUTES ? Number(process.env.TIME_DECAY_THRESHOLD_MINUTES) : 15;
const ENABLE_TIME_BASED_EXITS = process.env.ENABLE_TIME_BASED_EXITS !== 'false';

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
const userState = new Map();
const tradeHistory = [];
const failedExits = new Map();
const tradingLocks = new Map();

// NEW: Track pre-approvals per wallet
const preApprovedMarkets = new Map(); // key: walletAddress, value: Set of market addresses
let lastPreApprovalTime = new Map(); // key: walletAddress, value: timestamp

// Hourly active markets tracking
let currentHour = -1;
let activeOraclesThisHour = new Set(); // Oracle IDs that were active at :00

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
    status: 'BLOCKED'
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
function logTrade(walletAddress, marketAddress, marketTitle, outcome, action, amount, pnl = null, pnlPct = null, entryPrice = null, exitPrice = null, holdTimeMinutes = null, gasUsed = null, triggerPrice = null, exitReason = null) {
  const timestamp = new Date().toISOString();
  const record = {
    timestamp,
    wallet: walletAddress,
    market: marketAddress,
    marketTitle,
    outcome,
    action,
    amount,
    entryPrice,
    exitPrice,
    triggerPrice, // NEW: Log the price that triggered the buy
    pnl: pnl !== null ? Number(pnl) : null,
    pnlPct: pnlPct !== null ? Number(pnlPct) : null,
    holdTimeMinutes,
    gasUsed: gasUsed !== null ? Number(gasUsed) : null,
    exitReason: exitReason || null  // NEW: Exit reason
  };

  tradeHistory.push(record);

  try {
    ensureDirSync(path.dirname(TRADES_LOG_FILE));
    if (action === 'BUY') {
      const logLine = `${timestamp} | ${walletAddress.slice(0, 8)} | BUY | ${marketTitle} | Outcome ${outcome} | Amount: ${amount} | Entry Price: ${entryPrice}% | Trigger Price: ${triggerPrice}%\n`;
      fs.appendFileSync(TRADES_LOG_FILE, logLine);
    } else {
      const logLine = `${timestamp} | ${walletAddress.slice(0, 8)} | SELL | ${marketTitle} | Outcome ${outcome} | Amount: ${amount} | PnL: ${pnlPct.toFixed(2)}% | Hold: ${holdTimeMinutes}m | Gas: ${gasUsed.toFixed(4)} | Reason: ${exitReason || 'N/A'}\n`;
      fs.appendFileSync(TRADES_LOG_FILE, logLine);
    }
  } catch (e) {
    console.warn('Failed to write trade log:', e.message);
  }
  
  try {
    ensureDirSync(path.dirname(TRADES_CSV_FILE));
    const csvExists = fs.existsSync(TRADES_CSV_FILE);
    
    if (!csvExists) {
      const header = 'timestamp,wallet,market,marketTitle,outcome,action,amount,entryPrice,triggerPrice,exitPrice,pnl,pnlPct,holdTimeMinutes,gasUsed,exitReason\n';
      fs.writeFileSync(TRADES_CSV_FILE, header);
    }

    const csvLine = `${timestamp},${walletAddress},${marketAddress},"${marketTitle}",${outcome},${action},${amount},${entryPrice || ''},${triggerPrice || ''},${exitPrice || ''},${pnl || ''},${pnlPct || ''},${holdTimeMinutes || ''},${gasUsed || ''},${exitReason || ''}\n`;
    fs.appendFileSync(TRADES_CSV_FILE, csvLine);
  } catch (e) {
    console.warn('Failed to write CSV:', e.message);
  }
  
  updateSummary();
  updateAnalytics();
}

function updateAnalytics() {
  try {
    ensureDirSync(path.dirname(ANALYTICS_FILE));
    
    const completedTrades = tradeHistory.filter(t => t.action === 'SELL' && t.pnl !== null);
    
    if (completedTrades.length === 0) return;
    
    const wins = completedTrades.filter(t => t.pnl > 0);
    const losses = completedTrades.filter(t => t.pnl < 0);
    const totalPnL = completedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalGas = completedTrades.reduce((sum, t) => sum + (t.gasUsed || 0), 0);
    const netPnL = totalPnL - totalGas;
    
    const outcome0Trades = completedTrades.filter(t => t.outcome === 0);
    const outcome1Trades = completedTrades.filter(t => t.outcome === 1);
    
    const outcome0Wins = outcome0Trades.filter(t => t.pnl > 0).length;
    const outcome1Wins = outcome1Trades.filter(t => t.pnl > 0).length;
    
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
    
    const avgHoldTime = completedTrades.reduce((sum, t) => sum + (t.holdTimeMinutes || 0), 0) / completedTrades.length;
    const shortTrades = completedTrades.filter(t => t.holdTimeMinutes < 15);
    const mediumTrades = completedTrades.filter(t => t.holdTimeMinutes >= 15 && t.holdTimeMinutes < 30);
    const longTrades = completedTrades.filter(t => t.holdTimeMinutes >= 30);
    
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
      recentTrades: completedTrades.slice(-10).reverse()
    };
    
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  } catch (e) {
    console.warn('Failed to update summary:', e.message);
  }
}

function loadTradeHistory() {
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
  const now = new Date();
  const hourOfDay = now.getUTCHours();
  const minuteOfHour = now.getUTCMinutes();

  // Check if we're at the start of a new hour (minute 00)
  const isNewHour = hourOfDay !== currentHour;
  const isHourStart = minuteOfHour === 0;

  if (isNewHour || isHourStart || activeOraclesThisHour.size === 0) {
    // New hour detected or first run - check ALL markets to find active ones
    console.log(`🕐 Hour ${hourOfDay}:${minuteOfHour.toString().padStart(2, '0')} - Checking all markets for active oracles...`);

    const promises = PRICE_ORACLE_IDS.map(id => fetchMarket(id));
    const results = await Promise.allSettled(promises);

    const markets = [];
    const newActiveOracles = new Set();

    results.forEach((result, idx) => {
      const oracleId = PRICE_ORACLE_IDS[idx];

      if (result.status === 'fulfilled' && result.value) {
        const isActive = result.value.isActive;

        if (isActive) {
          newActiveOracles.add(oracleId);
          markets.push({
            oracleId,
            data: result.value
          });
        } else {
          console.log(`⏸️  Oracle ${oracleId}: Inactive this hour`);
        }
      }
    });

    // Update tracking
    currentHour = hourOfDay;
    activeOraclesThisHour = newActiveOracles;

    console.log(`✅ Active oracles for hour ${hourOfDay}: [${Array.from(activeOraclesThisHour).join(', ')}]`);
    return markets;

  } else {
    // During the hour - only fetch markets for oracles that were active at :00
    if (activeOraclesThisHour.size === 0) {
      console.log(`⚠️  No active oracles found for this hour`);
      return [];
    }

    const activeOracleIds = Array.from(activeOraclesThisHour);
    const promises = activeOracleIds.map(id => fetchMarket(id));
    const results = await Promise.allSettled(promises);

    const markets = [];
    results.forEach((result, idx) => {
      if (result.status === 'fulfilled' && result.value) {
        markets.push({
          oracleId: activeOracleIds[idx],
          data: result.value
        });
      }
    });

    return markets;
  }
}

// ========= Strategy =========
function pickOutcome(prices) {
  const [p0, p1] = prices;

  if (STRATEGY_MODE === 'dominant') {
    const p0ok = p0 >= TRIGGER_PCT;
    const p1ok = p1 >= TRIGGER_PCT;
    if (p0ok || p1ok) {
      return p0 >= p1 ? 0 : 1;
    }
    return null;
  } else {
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
      const remainingMinutes = remainingMs / 60000;
      
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
    shouldForceExit: false,
    timePhase: 'unknown'
  };

  if (!marketInfo.deadline) return result;

  const deadlineMs = new Date(marketInfo.deadline).getTime();
  if (Number.isNaN(deadlineMs)) return result;

  const remainingMs = deadlineMs - nowMs;
  const remainingMinutes = remainingMs / 60000;
  result.remainingMinutes = remainingMinutes;

  if (remainingMinutes > 30) {
    result.timePhase = 'early';
    result.positionSizeMultiplier = 1.0;
    result.profitTargetMultiplier = 1.0;
  }
  else if (remainingMinutes > 20) {
    result.timePhase = 'mid';
    result.positionSizeMultiplier = 1.0;
    result.profitTargetMultiplier = 1.0;
  }
  else if (remainingMinutes > TIME_DECAY_THRESHOLD_MINUTES) {
    result.timePhase = 'late';
    result.positionSizeMultiplier = 0.75;
    result.profitTargetMultiplier = 0.85;
  }
  else if (remainingMinutes > MIN_TIME_TO_EXIT_MINUTES) {
    result.timePhase = 'critical';
    result.positionSizeMultiplier = 0.5;
    result.profitTargetMultiplier = 0.7;
  }
  else {
    result.timePhase = 'danger';
    result.shouldForceExit = true;
  }

  return result;
}

// ========= NEW: Pre-Approval Functions =========
async function preApproveMarketsForWallet(wallet, provider, markets) {
  if (!PRE_APPROVE_USDC) return;
  
  const walletAddr = wallet.address;
  const now = Date.now();
  const lastRun = lastPreApprovalTime.get(walletAddr) || 0;
  
  // Check if it's time to run
  if (now - lastRun < PRE_APPROVAL_INTERVAL_MS) {
    return;
  }
  
  logInfo(walletAddr, '🔐', 'Running periodic USDC pre-approval...');
  lastPreApprovalTime.set(walletAddr, now);
  
  if (!preApprovedMarkets.has(walletAddr)) {
    preApprovedMarkets.set(walletAddr, new Set());
  }
  const approvedSet = preApprovedMarkets.get(walletAddr);
  
  let approvedCount = 0;
  let skippedCount = 0;
  
  for (const { data: marketData } of markets) {
    if (!marketData || !marketData.market || !marketData.isActive) continue;
    
    const marketInfo = marketData.market;
    const marketAddress = ethers.getAddress(marketInfo.address);
    const collateralTokenAddress = ethers.getAddress(marketInfo.collateralToken.address);
    
    // Skip if already approved
    if (approvedSet.has(marketAddress)) {
      skippedCount++;
      continue;
    }
    
    try {
      const usdc = new ethers.Contract(collateralTokenAddress, ERC20_ABI, wallet);
      const decimals = Number(await usdc.decimals());
      const approvalAmount = ethers.parseUnits(PRE_APPROVAL_AMOUNT_USDC.toString(), decimals);
      
      // Check current allowance
      const current = await readAllowance(usdc, walletAddr, marketAddress);
      
      if (current >= approvalAmount) {
        approvedSet.add(marketAddress);
        skippedCount++;
        continue;
      }
      
      // Reset if needed
      if (current > 0n) {
        try {
          const tx0 = await usdc.approve(marketAddress, 0n, await txOverrides(wallet.provider, 100000n));
          await tx0.wait(CONFIRMATIONS);
          await delay(1000);
        } catch (e) {
          logWarn(walletAddr, '⚠️', `Reset failed for ${marketInfo.title?.slice(0, 30)}`);
        }
      }
      
      // Approve
      const gasEst = await estimateGasFor(usdc, wallet, 'approve', [marketAddress, approvalAmount]);
      if (!gasEst) {
        logWarn(walletAddr, '⚠️', `Gas estimate failed for ${marketInfo.title?.slice(0, 30)}`);
        continue;
      }
      
      const pad = (gasEst * 120n) / 100n + 10000n;
      const tx = await usdc.approve(marketAddress, approvalAmount, await txOverrides(wallet.provider, pad));
      await tx.wait(CONFIRMATIONS);
      
      approvedSet.add(marketAddress);
      approvedCount++;
      
      logInfo(walletAddr, '✅', `Pre-approved: ${marketInfo.title?.slice(0, 40)} ($${PRE_APPROVAL_AMOUNT_USDC})`);
      
      await delay(2000);
      
    } catch (e) {
      logErr(walletAddr, '❌', `Pre-approval failed for ${marketInfo.title?.slice(0, 30)}`, e.message);
    }
  }
  
  logInfo(walletAddr, '🎉', `Pre-approval complete: ${approvedCount} new, ${skippedCount} already approved`);
}

// ========= Approval Functions =========
async function readAllowance(usdc, owner, spender) {
  try {
    const allowance = await usdc.allowance(owner, spender);
    return allowance;
  } catch (e) {
    try {
      const allowance = await usdc.allowance.staticCall(owner, spender);
      return allowance;
    } catch (e2) {
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
        console.warn(`Warning: Could not read allowance, assuming 0. Error: ${e3.message}`);
        return 0n;
      }
    }
  }
}

async function ensureUsdcApproval(wallet, usdc, marketAddress, needed) {
  // Check if already pre-approved
  const walletAddr = wallet.address;
  const approvedSet = preApprovedMarkets.get(walletAddr);
  if (approvedSet && approvedSet.has(marketAddress)) {
    // Verify it's still valid
    try {
      const current = await readAllowance(usdc, walletAddr, marketAddress);
      if (current >= needed) {
        logInfo(walletAddr, '⚡', 'Using pre-approved allowance (instant)');
        return true;
      }
    } catch (e) {
      // Fall through to normal approval
    }
  }
  
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
        await delay(1000);
      }
    } catch (e) {
      logWarn(wallet.address, '⚠️', `Reset to 0 failed: ${e.message}`);
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
    
    await delay(1000);
    try {
      const after = await readAllowance(usdc, wallet.address, marketAddress);
      const success = after >= needed;
      logInfo(wallet.address, success ? '✅' : '⚠️', `Allowance after: ${ethers.formatUnits(after, 6)} USDC`);
      return success;
    } catch (e) {
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
const contractCache = new Map();

async function getContracts(wallet, provider, marketAddress, collateralTokenAddress) {
  const cacheKey = marketAddress;
  if (contractCache.has(cacheKey)) {
    return contractCache.get(cacheKey);
  }
  
  try {
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
    
    let conditionalTokensAddress;
    try {
      conditionalTokensAddress = await market.conditionalTokens();
      
      if (!conditionalTokensAddress || conditionalTokensAddress === ethers.ZeroAddress) {
        throw new Error('returned zero address');
      }
    } catch (e) {
      try {
        conditionalTokensAddress = await market.conditionalTokens.staticCall();
        if (!conditionalTokensAddress || conditionalTokensAddress === ethers.ZeroAddress) {
          throw new Error('returned zero address');
        }
      } catch (e2) {
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
    
    if (isMarketBlocked(marketAddress)) {
      return;
    }

    const prices = marketInfo.prices || [];
    const positionIds = marketInfo.positionIds || [];
    const collateralTokenAddress = ethers.getAddress(marketInfo.collateralToken.address);

    logInfo(wallet.address, '📊', `Oracle ${oracleId}: ${marketInfo.title || 'Untitled'}`);

    // NEW: Log current prices for transparency
    if (prices.length >= 2) {
      logInfo(wallet.address, '💹', `Current Prices: ${prices[0].toFixed(1)}% / ${prices[1].toFixed(1)}%`);
    }

    let contracts;
    try {
      contracts = await getContracts(wallet, provider, marketAddress, collateralTokenAddress);
    } catch (e) {
      logErr(wallet.address, '❌', `Contract load failed: ${e.message}`);
      return;
    }

    const { market, usdc, erc1155, decimals } = contracts;

    const localHolding = getHolding(wallet.address, marketAddress);
    const pid0 = positionIds[0] ? BigInt(positionIds[0]) : null;
    const pid1 = positionIds[1] ? BigInt(positionIds[1]) : null;

    let bal0 = pid0 !== null ? await safeBalanceOf(erc1155, wallet.address, pid0) : 0n;
    let bal1 = pid1 !== null ? await safeBalanceOf(erc1155, wallet.address, pid1) : 0n;

    const hasPosition = (bal0 > 0n) || (bal1 > 0n) || !!localHolding;

    if (hasPosition) {
      logInfo(wallet.address, '🔒', `Already holding position in this market - managing exit`);
      
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

      // Check if market has expired before trying to sell
      let minutesRemaining = Infinity;
      if (marketInfo.deadline) {
        const deadlineMs = new Date(marketInfo.deadline).getTime();
        if (!Number.isNaN(deadlineMs)) {
          const remainingMs = deadlineMs - Date.now();
          minutesRemaining = remainingMs / 60000;

          if (minutesRemaining <= 0) {
            logWarn(wallet.address, '⏰', 'Market expired - cannot sell, marking as completed');
            markMarketCompleted(wallet.address, marketAddress);
            return;
          }
        }
      }

      const cost = holding.cost;
      let tokensNeededForCost;
      try {
        tokensNeededForCost = await market.calcSellAmount(cost, outcomeIndex);
      } catch (e) {
        logErr(wallet.address, '💥', `calcSellAmount failed: ${e.message}`);

        // If market is within 2 minutes of deadline, probably expired
        if (minutesRemaining <= 2) {
          logWarn(wallet.address, '⏰', 'Market near/past deadline - marking as completed');
          markMarketCompleted(wallet.address, marketAddress);
          return;
        }

        // Track failures - only mark as completed after multiple failures
        if (!holding.calcSellFailures) {
          holding.calcSellFailures = 1;
          setHolding(wallet.address, marketAddress, holding);
          logWarn(wallet.address, '⚠️', 'Will retry next iteration...');
          return;
        } else if (holding.calcSellFailures < 5) {
          holding.calcSellFailures++;
          setHolding(wallet.address, marketAddress, holding);
          logWarn(wallet.address, '⚠️', `Retry ${holding.calcSellFailures}/5...`);
          return;
        } else {
          logErr(wallet.address, '🏁', 'Multiple failures - market likely expired, marking as completed');
          markMarketCompleted(wallet.address, marketAddress);
          return;
        }
      }

      // Reset failure count on success
      if (holding.calcSellFailures) {
        holding.calcSellFailures = 0;
        setHolding(wallet.address, marketAddress, holding);
      }

      if (tokensNeededForCost === 0n) {
        logWarn(wallet.address, '⚠️', 'calcSellAmount returned 0 - skipping this iteration');
        return;
      }

      const positionValue = (tokenBalance * cost) / tokensNeededForCost;
      const pnlAbs = positionValue - cost;
      const pnlPct = cost > 0n ? Number((pnlAbs * 10000n) / cost) / 100 : 0;

      const valueHuman = fmtUnitsPrec(positionValue, decimals);
      const pnlSign = pnlAbs >= 0n ? '📈' : '📉';

      logInfo(wallet.address, pnlSign, `Value: ${valueHuman} | PnL: ${pnlPct.toFixed(1)}% | Time left: ${minutesRemaining.toFixed(0)}m`);

      // Check for exit conditions:
      let shouldSell = false;
      let exitReason = '';

      // DEBUG: Always log profit check
      logInfo(wallet.address, '🔍', `Profit check: ${pnlPct.toFixed(1)}% vs target ${TARGET_PROFIT_PCT}%`);

      // 1. Fixed profit target
      if (pnlPct >= TARGET_PROFIT_PCT) {
        shouldSell = true;
        exitReason = `TARGET_PROFIT (${pnlPct.toFixed(1)}%)`;
        logInfo(wallet.address, '🎯', `Target profit reached: ${exitReason}`);
      }

      // 2. Last 12 minutes: Emergency stop loss if down 70%+
      if (!shouldSell && minutesRemaining <= 12 && pnlPct <= -70) {
        shouldSell = true;
        exitReason = `EMERGENCY_STOP_LOSS (${minutesRemaining.toFixed(0)}m left, ${pnlPct.toFixed(1)}% loss)`;
        logErr(wallet.address, '🚨', `Emergency stop loss triggered: ${exitReason}`);
      }

      // 3. Last 10 minutes: Exit any profitable position
      if (!shouldSell && minutesRemaining <= 10 && pnlPct > 0) {
        shouldSell = true;
        exitReason = `DEADLINE_EXIT (${minutesRemaining.toFixed(0)}m left, ${pnlPct.toFixed(1)}% profit)`;
        logInfo(wallet.address, '⏰', `Closing profitable position before deadline`);
      }

      if (shouldSell) {
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

        const exitEmoji = pnlPct >= 0 ? '✅' : '🛑';
        logInfo(wallet.address, exitEmoji, `SOLD at ${pnlPct.toFixed(1)}% (${exitReason || 'EXIT'})`);

        const pnlAmount = Number(ethers.formatUnits(pnlAbs, decimals));

        // Calculate hold time
        const entryTime = holding.entryTime || Date.now();
        const holdTimeMs = Date.now() - entryTime;
        const holdTimeMinutes = holdTimeMs / 60000;

        // Get entry and exit prices
        const entryPriceVal = holding.entryPrice || null;
        const currentPrice = prices && prices[outcomeIndex] ? prices[outcomeIndex] : null;

        // Get gas used (estimate for now)
        const gasUsedEth = 0.0002;

        logTrade(
          wallet.address,
          marketAddress,
          marketInfo.title || 'Unknown Market',
          outcomeIndex,
          'SELL',
          Number(ethers.formatUnits(cost, decimals)),
          pnlAmount,
          pnlPct,
          entryPriceVal,
          currentPrice,
          holdTimeMinutes,
          gasUsedEth,
          null, // triggerPrice (only for buys)
          exitReason // EXIT REASON
        );
        
        setHolding(wallet.address, marketAddress, null);
        markMarketCompleted(wallet.address, marketAddress);
        
        return;
      }

      logInfo(wallet.address, '⏳', 'Holding position');
      return;
    }

    if (!Array.isArray(prices) || prices.length < 2) {
      return;
    }

    if (isMarketCompleted(wallet.address, marketAddress)) {
      logInfo(wallet.address, '🧭', 'Market already completed - skipping');
      return;
    }
    
    if (bal0 > 0n || bal1 > 0n || localHolding) {
      logInfo(wallet.address, '🔒', 'Position exists - cannot open another in same market');
      return;
    }

    const positionIdsValid = Array.isArray(positionIds) && positionIds.length >= 2 && positionIds[0] && positionIds[1];
    if (!positionIdsValid) {
      logWarn(wallet.address, '🛑', 'Invalid position IDs');
      return;
    }

    // Validate market timing for new entries only
    if (!validateMarketTiming(marketInfo, wallet)) {
      return;
    }

    // Check time remaining for last-minute entry strategy
    let minutesRemaining = Infinity;
    if (marketInfo.deadline) {
      const deadlineMs = new Date(marketInfo.deadline).getTime();
      if (!Number.isNaN(deadlineMs)) {
        const remainingMs = deadlineMs - Date.now();
        minutesRemaining = remainingMs / 60000;
      }
    }

    let outcomeToBuy = pickOutcome(prices);

    if (outcomeToBuy === null) {
      logInfo(wallet.address, '🔎', `No signal (${prices[0].toFixed(1)}%/${prices[1].toFixed(1)}%)`);
      return;
    }

    // NEW: Log the trigger price - the price that caused the buy signal
    const triggerPrice = prices[outcomeToBuy];

    // MAX ENTRY PRICE CHECK: Don't buy if price is above 65%
    if (triggerPrice > 65) {
      logInfo(wallet.address, '🚫', `Entry price too high: ${triggerPrice.toFixed(1)}% > 65% - skipping`);
      return;
    }

    logInfo(wallet.address, '🎯', `BUY SIGNAL: Outcome ${outcomeToBuy} at trigger price ${triggerPrice.toFixed(1)}%`);

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
    
    // Get actual entry price after buy
    const entryPrice = prices[outcomeToBuy];
    logInfo(wallet.address, '✅', `BUY completed at ${entryPrice.toFixed(1)}%`);

    const tokenId = outcomeToBuy === 0 ? pid0 : pid1;
    
    // NEW: Log buy with both trigger price and actual entry price
    logTrade(
      wallet.address,
      marketAddress,
      marketInfo.title || 'Unknown Market',
      outcomeToBuy,
      'BUY',
      BUY_AMOUNT_USDC,
      null,
      null,
      entryPrice,
      null,
      null,
      null,
      triggerPrice
    );
    
    setHolding(wallet.address, marketAddress, {
      outcomeIndex: outcomeToBuy,
      tokenId,
      amount: investment,
      cost: investment,
      entryTime: Date.now(),
      entryPrice: entryPrice
    });

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

    // NEW: Run pre-approval before processing markets
    await preApproveMarketsForWallet(wallet, provider, markets);

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
  console.log(`📈 Target profit: ${TARGET_PROFIT_PCT}%`);
  console.log(`🎚️ Entry trigger: ${TRIGGER_PCT}% | Slippage: ${(SLIPPAGE_BPS / 100).toFixed(2)}%`);
  console.log(`🔐 Pre-approval: ${PRE_APPROVE_USDC ? `Enabled (every ${PRE_APPROVAL_INTERVAL_MS/60000}min, $${PRE_APPROVAL_AMOUNT_USDC})` : 'Disabled'}`);
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

  const persisted = loadStateSync();
  for (const [addr, marketMap] of persisted.entries()) {
    userState.set(addr, marketMap);
  }
  
  loadTradeHistory();

  for (const w of wallets) {
    console.log(`🔑 Loaded wallet: ${w.address.slice(0, 6)}...${w.address.slice(-4)}`);
  }
  
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
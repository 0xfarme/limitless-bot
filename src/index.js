require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const MARKET_ABI = require('./abis/Market.json');
const ERC20_ABI = require('./abis/ERC20.json');
const ERC1155_ABI = require('./abis/ERC1155.json');
const CONDITIONAL_TOKENS_ABI = require('./abis/ConditionalTokens.json');

// ========= Config =========
// Support multiple RPC URLs (comma-separated) for automatic fallback
const RPC_URLS = (process.env.RPC_URL || process.env.RPC_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
if (RPC_URLS.length === 0) {
  console.error('❌ ERROR: No RPC_URL configured. Please set RPC_URL in .env file.');
  process.exit(1);
}
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '8453', 10);
const PRICE_ORACLE_IDS = (process.env.PRICE_ORACLE_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const FREQUENCY = process.env.FREQUENCY || 'hourly';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);

// Universal buy amount (fallback if strategy-specific not set)
const BUY_AMOUNT_USDC = process.env.BUY_AMOUNT_USDC ? Number(process.env.BUY_AMOUNT_USDC) : 5; // human units

// Per-strategy buy amounts (overrides BUY_AMOUNT_USDC if set)
const LATE_BUY_AMOUNT_USDC = process.env.LATE_BUY_AMOUNT_USDC ? Number(process.env.LATE_BUY_AMOUNT_USDC) : null;

// Helper function to get buy amount for a strategy
function getBuyAmountForStrategy(strategy) {
  // Normalize strategy name
  const isMoonshot = strategy && strategy.includes('moonshot');
  const isQuickScalp = strategy && strategy.includes('quick_scalp');
  const isLate = strategy && strategy === 'default';

  // Check strategy-specific amount first
  if (isMoonshot) {
    return MOONSHOT_AMOUNT_USDC;
  }
  if (isQuickScalp) {
    return QUICK_SCALP_AMOUNT_USDC;
  }
  if (isLate && LATE_BUY_AMOUNT_USDC !== null) {
    return LATE_BUY_AMOUNT_USDC;
  }

  // Fall back to universal amount
  return BUY_AMOUNT_USDC;
}

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
// Late window (default) strategy - always enabled unless explicitly disabled
const LATE_STRATEGY_ENABLED = (process.env.LATE_STRATEGY_ENABLED || 'true').toLowerCase() === 'true'; // Enable late window strategy
const BUY_WINDOW_MINUTES = parseInt(process.env.BUY_WINDOW_MINUTES || '13', 10); // Last N minutes to buy
const NO_BUY_FINAL_MINUTES = parseInt(process.env.NO_BUY_FINAL_MINUTES || '2', 10); // Don't buy in last N minutes
const STOP_LOSS_MINUTES = parseInt(process.env.STOP_LOSS_MINUTES || '2', 10); // Stop loss active in last N minutes
const STOP_LOSS_ENABLED = (process.env.STOP_LOSS_ENABLED || 'false').toLowerCase() === 'true'; // Enable stop loss
const STOP_LOSS_PNL_PCT = parseInt(process.env.STOP_LOSS_PNL_PCT || '-50', 10); // Sell if PnL drops below N%
const MIN_ODDS = parseInt(process.env.MIN_ODDS || '75', 10); // Minimum odds to buy
const MAX_ODDS = parseInt(process.env.MAX_ODDS || '95', 10); // Maximum odds to buy
const MIN_MARKET_AGE_MINUTES = parseInt(process.env.MIN_MARKET_AGE_MINUTES || '10', 10); // Don't buy markets younger than N minutes

// ========= Time-Based Odds Windows Config =========
const TIME_BASED_ODDS_ENABLED = (process.env.TIME_BASED_ODDS_ENABLED || 'false').toLowerCase() === 'true';
// Window 1: Earlier late window
const LATE_WINDOW_1_START = parseInt(process.env.LATE_WINDOW_1_START || '40', 10);
const LATE_WINDOW_1_END = parseInt(process.env.LATE_WINDOW_1_END || '50', 10);
const LATE_WINDOW_1_MIN_ODDS = parseInt(process.env.LATE_WINDOW_1_MIN_ODDS || '70', 10);
const LATE_WINDOW_1_MAX_ODDS = parseInt(process.env.LATE_WINDOW_1_MAX_ODDS || '95', 10);
// Window 2: Final late window
const LATE_WINDOW_2_START = parseInt(process.env.LATE_WINDOW_2_START || '50', 10);
const LATE_WINDOW_2_END = parseInt(process.env.LATE_WINDOW_2_END || '59', 10);
const LATE_WINDOW_2_MIN_ODDS = parseInt(process.env.LATE_WINDOW_2_MIN_ODDS || '75', 10);
const LATE_WINDOW_2_MAX_ODDS = parseInt(process.env.LATE_WINDOW_2_MAX_ODDS || '90', 10);

// ========= Scale-In Config (Late Strategy) =========
const SCALE_IN_ENABLED = (process.env.SCALE_IN_ENABLED || 'false').toLowerCase() === 'true'; // Enable scale-in for late strategy
const SCALE_IN_POSITIONS = parseInt(process.env.SCALE_IN_POSITIONS || '2', 10); // Number of scale-in positions (2 = split buy into 2 entries)
const SCALE_IN_DROP_PCT = parseInt(process.env.SCALE_IN_DROP_PCT || '10', 10); // Odds must drop by N% to trigger next scale-in

// ========= Quick Scalp Strategy Config (Early Market Arbitrage) =========
const QUICK_SCALP_ENABLED = (process.env.QUICK_SCALP_ENABLED || 'false').toLowerCase() === 'true';
const QUICK_SCALP_WINDOW_MINUTES = parseInt(process.env.QUICK_SCALP_WINDOW_MINUTES || '40', 10); // Active in first N minutes of market
const QUICK_SCALP_MIN_ENTRY_ODDS = parseInt(process.env.QUICK_SCALP_MIN_ENTRY_ODDS || '5', 10); // Min odds to enter
const QUICK_SCALP_MAX_ENTRY_ODDS = parseInt(process.env.QUICK_SCALP_MAX_ENTRY_ODDS || '30', 10); // Max odds to enter
const QUICK_SCALP_PROFIT_MULTIPLIER = parseFloat(process.env.QUICK_SCALP_PROFIT_MULTIPLIER || '2'); // Sell when odds reach Nx entry
const QUICK_SCALP_AMOUNT_USDC = parseFloat(process.env.QUICK_SCALP_AMOUNT_USDC || '10');

// ========= Moonshot Strategy Config =========
const MOONSHOT_ENABLED = (process.env.MOONSHOT_ENABLED || 'true').toLowerCase() === 'true'; // Enable moonshot strategy
const MOONSHOT_WINDOW_MINUTES = parseInt(process.env.MOONSHOT_WINDOW_MINUTES || '2', 10); // Moonshot triggers in last N minutes
const MOONSHOT_MAX_ODDS = parseInt(process.env.MOONSHOT_MAX_ODDS || '10', 10); // Only buy if opposite side <= N%
const MOONSHOT_MIN_LATE_ODDS = parseInt(process.env.MOONSHOT_MIN_LATE_ODDS || '70', 10); // Require late position >= N% to trigger moonshot
const MOONSHOT_MAX_LATE_ODDS = parseInt(process.env.MOONSHOT_MAX_LATE_ODDS || '95', 10); // Require late position <= N% to trigger moonshot
const MOONSHOT_AMOUNT_USDC = parseFloat(process.env.MOONSHOT_AMOUNT_USDC || '1'); // Amount to invest in moonshot
const MOONSHOT_PROFIT_TARGET_PCT = parseInt(process.env.MOONSHOT_PROFIT_TARGET_PCT || '100', 10); // Sell at N% profit
const MOONSHOT_FINAL_SECONDS_BUFFER = parseInt(process.env.MOONSHOT_FINAL_SECONDS_BUFFER || '15', 10); // Don't buy in final N seconds

// ========= Sell Config =========
const AUTO_PROFIT_SELL_ENABLED = (process.env.AUTO_PROFIT_SELL_ENABLED || 'true').toLowerCase() === 'true'; // Enable automatic profit taking
// Always sell 100% of positions - no partial sells

// ========= Redemption Config =========
const AUTO_REDEEM_ENABLED = (process.env.AUTO_REDEEM_ENABLED || 'true').toLowerCase() === 'true'; // Enable automatic redemption
const REDEEM_WINDOW_START = parseInt(process.env.REDEEM_WINDOW_START || '6', 10); // Redemption window start minute (0-59)
const REDEEM_WINDOW_END = parseInt(process.env.REDEEM_WINDOW_END || '10', 10); // Redemption window end minute (0-59)

// ========= Transaction Lock (Prevent Nonce Conflicts) =========
// Track pending transactions per wallet to prevent nonce conflicts
const pendingTransactions = new Map(); // walletAddress -> Promise

// Serialize transactions for a wallet to prevent nonce conflicts
async function withTransactionLock(walletAddress, transactionFn) {
  // Wait for any pending transaction to complete first
  const pending = pendingTransactions.get(walletAddress);
  if (pending) {
    try {
      await pending;
    } catch (e) {
      // Ignore errors from previous transaction, proceed with current one
    }
  }

  // Execute this transaction and store the promise
  const promise = transactionFn();
  pendingTransactions.set(walletAddress, promise);

  try {
    const result = await promise;
    return result;
  } finally {
    // Clean up after transaction completes
    if (pendingTransactions.get(walletAddress) === promise) {
      pendingTransactions.delete(walletAddress);
    }
  }
}

// ========= S3 Upload Config =========
const S3_UPLOAD_ENABLED = (process.env.S3_UPLOAD_ENABLED || 'false').toLowerCase() === 'true';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'limitless-bot-logs';
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const S3_UPLOAD_INTERVAL_MS = parseInt(process.env.S3_UPLOAD_INTERVAL_MS || '60000', 10); // 1 minute default

// Initialize S3 client if upload is enabled
let s3Client = null;
if (S3_UPLOAD_ENABLED) {
  const s3Config = {
    region: S3_REGION
  };
  // Add credentials if provided (otherwise uses AWS CLI credentials or IAM role)
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    s3Config.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    };
  }
  s3Client = new S3Client(s3Config);
  console.log(`📤 S3 upload enabled: Bucket=${S3_BUCKET_NAME}, Region=${S3_REGION}, Interval=${S3_UPLOAD_INTERVAL_MS}ms`);
}

// RPC_URLS validation is already done at lines 14-19
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

// ========= File Path Helpers =========
// Helper to get hourly folder path (e.g., data/2025-01-18-14 for 2pm on Jan 18, 2025)
function getHourlyFolder() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  return path.join('data', `${year}-${month}-${day}-${hour}`);
}

function getStateFile(strategy = null) {
  return path.join(getHourlyFolder(), 'state.json');
}
function getTradesLogFile(strategy = null) {
  return path.join(getHourlyFolder(), 'trades.jsonl');
}
function getStatsFile(strategy = null) {
  return path.join(getHourlyFolder(), 'stats.json');
}
function getRedemptionLogFile(strategy = null) {
  return path.join(getHourlyFolder(), 'redemptions.jsonl');
}

// ========= Logging helpers with emojis =========
function logInfo(addr, emoji, msg, strategy = null) {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} ${emoji} [${addr}] ${msg}`);
}
function logWarn(addr, emoji, msg, strategy = null) {
  const timestamp = new Date().toISOString();
  console.warn(`${timestamp} ${emoji} [${addr}] ${msg}`);
}
function logErr(addr, emoji, msg, err, strategy = null) {
  const timestamp = new Date().toISOString();
  const base = `${timestamp} ${emoji} [${addr}] ${msg}`;
  if (err) console.error(base, err);
  else console.error(base);
}

// ========= Trade Logging =========
function logTrade(tradeData) {
  try {
    const logFile = getTradesLogFile();
    ensureDirSync(path.dirname(logFile));
    const logEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...tradeData
    }) + '\n';
    fs.appendFileSync(logFile, logEntry);
  } catch (e) {
    console.error('⚠️ Failed to log trade:', e?.message || e);
  }
}

// ========= Redemption Logging =========
function logRedemption(redemptionData) {
  try {
    const logFile = getRedemptionLogFile();
    ensureDirSync(path.dirname(logFile));
    const logEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...redemptionData
    }) + '\n';
    fs.appendFileSync(logFile, logEntry);
  } catch (e) {
    console.error('⚠️ Failed to log redemption:', e?.message || e);
  }
}

// ========= S3 Upload Logic =========
async function uploadFileToS3(filePath, s3Key) {
  if (!S3_UPLOAD_ENABLED || !s3Client) return;

  try {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return; // File doesn't exist yet, skip
    }

    const fileContent = fs.readFileSync(filePath);
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: s3Key,
      Body: fileContent,
      ContentType: s3Key.endsWith('.json') ? 'application/json' : 'application/x-ndjson'
    });

    await s3Client.send(command);
    console.log(`✅ [S3] Uploaded ${s3Key}`);
  } catch (e) {
    console.error(`⚠️ [S3] Failed to upload ${s3Key}:`, e?.message || e);
  }
}

async function uploadAllLogsToS3() {
  if (!S3_UPLOAD_ENABLED || !s3Client) return;

  console.log('📤 [S3] Uploading logs to S3...');

  // Upload all log files
  await Promise.all([
    uploadFileToS3(TRADES_LOG_FILE, 'trades.jsonl'),
    uploadFileToS3(STATS_FILE, 'stats.json'),
    uploadFileToS3(REDEMPTION_LOG_FILE, 'redemptions.jsonl'),
    uploadFileToS3(STATE_FILE, 'state.json')
  ]);
}

// Schedule periodic S3 uploads
let s3UploadTimer = null;
function startS3Upload() {
  if (!S3_UPLOAD_ENABLED || !s3Client) return;

  console.log(`📤 [S3] Starting periodic uploads every ${S3_UPLOAD_INTERVAL_MS}ms`);

  // Upload immediately on start
  uploadAllLogsToS3().catch(e => console.error('⚠️ [S3] Initial upload failed:', e?.message || e));

  // Then schedule periodic uploads
  s3UploadTimer = setInterval(() => {
    uploadAllLogsToS3().catch(e => console.error('⚠️ [S3] Periodic upload failed:', e?.message || e));
  }, S3_UPLOAD_INTERVAL_MS);
}

function stopS3Upload() {
  if (s3UploadTimer) {
    clearInterval(s3UploadTimer);
    s3UploadTimer = null;
    // Final upload before shutdown
    if (S3_UPLOAD_ENABLED) {
      uploadAllLogsToS3().catch(e => console.error('⚠️ [S3] Final upload failed:', e?.message || e));
    }
  }
}

// ========= Portfolio API Integration =========
async function fetchPortfolioData(walletAddress) {
  try {
    const url = `https://api.limitless.exchange/portfolio/${walletAddress}/positions`;
    const response = await axios.get(url, { timeout: 15000 });
    return response.data;
  } catch (error) {
    console.error(`⚠️ Failed to fetch portfolio for ${walletAddress}:`, error?.message || error);
    return null;
  }
}

// Portfolio snapshot feature removed - API has stale/cached data
// Using local state tracking instead (trades.jsonl, stats.json, state.json)

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
    const statsFile = getStatsFile();
    ensureDirSync(path.dirname(statsFile));
    const statsData = {
      ...botStats,
      netProfitUSDC: botStats.totalProfitUSDC - botStats.totalLossUSDC,
      winRate: botStats.totalTrades > 0 ? ((botStats.profitableTrades / botStats.totalTrades) * 100).toFixed(2) + '%' : '0%',
      uptimeHours: ((Date.now() - botStats.startTime) / (1000 * 60 * 60)).toFixed(2)
    };
    fs.writeFileSync(statsFile, JSON.stringify(statsData, null, 2));

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
  // Remove any existing holding for same market+strategy before adding new one
  const strategy = holding.strategy || 'default';
  const filtered = holdings.filter(h => {
    const isSameMarket = h.marketAddress.toLowerCase() === holding.marketAddress.toLowerCase();
    const isSameStrategy = (h.strategy || 'default') === strategy;
    return !(isSameMarket && isSameStrategy);
  });
  filtered.push(holding);
  userState.set(addr, { ...prev, holdings: filtered });
  scheduleSave();
}
function updateHoldingForScaleIn(addr, marketAddress, strategy, additionalInvestment, newTxHash) {
  const prev = userState.get(addr) || { holdings: [], completedMarkets: new Set() };
  const holdings = prev.holdings || [];
  const holding = holdings.find(h => {
    const isSameMarket = h.marketAddress.toLowerCase() === marketAddress.toLowerCase();
    const isSameStrategy = (h.strategy || 'default') === strategy;
    return isSameMarket && isSameStrategy;
  });

  if (holding) {
    // Update existing holding with cumulative values
    holding.amount = (BigInt(holding.amount) + BigInt(additionalInvestment)).toString();
    holding.cost = (BigInt(holding.cost) + BigInt(additionalInvestment)).toString();
    holding.scaleInStep = (holding.scaleInStep || 1) + 1;
    holding.lastScaleInTxHash = newTxHash;
    holding.lastScaleInTimestamp = new Date().toISOString();

    userState.set(addr, { ...prev, holdings });
    scheduleSave();
    return true;
  }
  return false;
}
function removeHolding(addr, marketAddress, strategy = null) {
  const prev = userState.get(addr) || { holdings: [], completedMarkets: new Set() };
  const holdings = prev.holdings || [];
  const filtered = holdings.filter(h => {
    const isSameMarket = h.marketAddress.toLowerCase() === marketAddress.toLowerCase();
    if (!strategy) {
      // If no strategy specified, remove all holdings for this market
      return !isSameMarket;
    }
    // Remove only holdings for this market+strategy combination
    const isSameStrategy = (h.strategy || 'default') === strategy;
    return !(isSameMarket && isSameStrategy);
  });
  userState.set(addr, { ...prev, holdings: filtered });
  scheduleSave();
}
function getHolding(addr, marketAddress, strategy = null) {
  const st = userState.get(addr);
  if (!st || !st.holdings) return null;
  if (!strategy) {
    // If no strategy specified, return any holding for this market
    return st.holdings.find(h => h.marketAddress.toLowerCase() === marketAddress.toLowerCase()) || null;
  }
  // Return holding for specific market+strategy combination
  return st.holdings.find(h => {
    const isSameMarket = h.marketAddress.toLowerCase() === marketAddress.toLowerCase();
    const isSameStrategy = (h.strategy || 'default') === strategy;
    return isSameMarket && isSameStrategy;
  }) || null;
}
function getHoldingsForMarket(addr, marketAddress) {
  const st = userState.get(addr);
  if (!st || !st.holdings) return [];
  return st.holdings.filter(h => h.marketAddress.toLowerCase() === marketAddress.toLowerCase());
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
      const stateFile = getStateFile();
      ensureDirSync(path.dirname(stateFile));
      const data = serializeState();
      fs.writeFileSync(stateFile, JSON.stringify(data, null, 2));
      console.log(`💾 [STATE] Saved to ${stateFile}`);
    } catch (e) {
      console.warn('⚠️ [STATE] Failed to save state:', e && e.message ? e.message : e);
    } finally {
      saveTimer = null;
    }
  }, 100);
}

function loadStateSync() {
  try {
    const stateFile = getStateFile();
    if (!fs.existsSync(stateFile)) return new Map();
    const raw = fs.readFileSync(stateFile, 'utf8');
    const obj = JSON.parse(raw);
    console.log(`📂 [STATE] Loaded from ${stateFile}`);
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
  // Try with retry and fallback - RPC nodes can be flaky
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // Add timeout to the call
      const allowancePromise = usdc.allowance(owner, spender);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Allowance read timeout')), 10000)
      );
      return await Promise.race([allowancePromise, timeoutPromise]);
    } catch (e) {
      const errMsg = e?.message || String(e);
      const isCallException = errMsg.includes('CALL_EXCEPTION') || errMsg.includes('missing revert data');
      const isTimeout = errMsg.includes('timeout');

      if (attempt < 4) {
        // Exponential backoff with jitter for RPC issues
        const baseDelay = isCallException || isTimeout ? 2000 : 1000;
        const backoff = baseDelay * Math.pow(1.5, attempt);
        const jitter = Math.random() * 500;
        await delay(backoff + jitter);
        continue;
      }

      // Last attempt: try staticCall fallback
      try {
        const fn = usdc.getFunction ? usdc.getFunction('allowance') : null;
        if (fn && fn.staticCall) {
          return await fn.staticCall(owner, spender);
        }
      } catch (_) {}

      // If all retries fail, log warning and return 0 (will trigger approval flow)
      console.warn(`⚠️ All allowance read attempts failed: ${errMsg.substring(0, 100)}. Assuming 0 allowance.`);
      return 0n;
    }
  }
  return 0n; // Final fallback
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
  return withTransactionLock(wallet.address, async () => {
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
  });
}

async function ensureErc1155Approval(wallet, erc1155, operator) {
  return withTransactionLock(wallet.address, async () => {
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
  });
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

    // CRITICAL: Check if we actually still hold the position tokens before attempting redemption
    // Get position IDs from market data
    const positionIds = marketInfo.positionIds || [];
    if (!positionIds || positionIds.length < 2) {
      logWarn(wallet.address, '⚠️', `[${marketAddress.substring(0, 8)}...] No positionIds in market data, cannot verify token balance`);
      logRedemption({
        event: 'NO_POSITION_IDS',
        wallet: wallet.address,
        marketAddress: marketAddress,
        marketInfo: marketInfo
      });
      return false;
    }

    // Get ERC1155 contract (ConditionalTokens)
    const erc1155 = new ethers.Contract(
      conditionalTokensContract.target,
      ERC1155_ABI,
      wallet
    );

    const pid0 = BigInt(positionIds[0]);
    const pid1 = BigInt(positionIds[1]);
    const bal0 = await safeBalanceOf(erc1155, wallet.address, pid0);
    const bal1 = await safeBalanceOf(erc1155, wallet.address, pid1);

    logInfo(wallet.address, '🎟️', `[${marketAddress.substring(0, 8)}...] Token balances: pid0=${pid0} (${bal0}) | pid1=${pid1} (${bal1})`);
    logRedemption({
      event: 'TOKEN_BALANCE_CHECK',
      wallet: wallet.address,
      marketAddress: marketAddress,
      pid0: pid0.toString(),
      pid1: pid1.toString(),
      bal0: bal0.toString(),
      bal1: bal1.toString()
    });

    // Check if we have ANY tokens to redeem
    const hasTokens = (bal0 > 0n) || (bal1 > 0n);
    if (!hasTokens) {
      logWarn(wallet.address, '⚠️', `[${marketAddress.substring(0, 8)}...] No tokens found on-chain - position was likely already sold or redeemed. Removing from local state.`);
      logRedemption({
        event: 'NO_TOKENS_FOUND',
        wallet: wallet.address,
        marketAddress: marketAddress,
        reason: 'Position already sold/redeemed'
      });

      // Remove holding from local state since it's already closed
      removeHolding(wallet.address, marketAddress);
      markMarketCompleted(wallet.address, marketAddress);

      return false;
    }

    logInfo(wallet.address, '✅', `[${marketAddress.substring(0, 8)}...] Tokens confirmed on-chain, proceeding with redemption`);

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
  function shouldBeActive(wallet) {
    const now = new Date();
    const nowMinutes = now.getMinutes();

    // Check if ANY strategy is enabled
    const anyStrategyEnabled = LATE_STRATEGY_ENABLED || MOONSHOT_ENABLED || QUICK_SCALP_ENABLED;
    const hasActiveStrategies = anyStrategyEnabled || AUTO_REDEEM_ENABLED;

    // If no strategies enabled and no redemption, always sleep
    if (!hasActiveStrategies) {
      return false; // Deep sleep - no trading or redemption enabled
    }

    // Always stay active if we have open positions (need to monitor for profit targets)
    if (wallet) {
      const holdings = getAllHoldings(wallet.address);
      if (holdings && holdings.length > 0) {
        return true; // Stay awake to monitor positions
      }
    }

    // Redemption window: minutes 6-10
    const inRedemptionWindow = AUTO_REDEEM_ENABLED && nowMinutes >= REDEEM_WINDOW_START && nowMinutes <= REDEEM_WINDOW_END;

    // Last 13 minutes trading window: minutes 47-60 (if late window strategy enabled)
    const inLateWindow = LATE_STRATEGY_ENABLED && nowMinutes >= (60 - BUY_WINDOW_MINUTES);

    // Quick Scalp runs in first 40 minutes of any market (not time-based, market-age-based)
    // So if enabled, bot needs to stay active to catch new markets
    const quickScalpActive = QUICK_SCALP_ENABLED;

    return inRedemptionWindow || inLateWindow || quickScalpActive;
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
    } else if (nowMinutes < (60 - BUY_WINDOW_MINUTES)) {
      nextWakeMinute = 60 - BUY_WINDOW_MINUTES;
    } else {
      // Next window is in the next hour
      if (AUTO_REDEEM_ENABLED) {
        nextWakeMinute = REDEEM_WINDOW_START + 60;
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
    // Check if bot should be active right now - do this FIRST to avoid unnecessary work during sleep
    const nowMinutes = new Date().getMinutes();
    const holdings = getAllHoldings(wallet.address);
    const isActive = shouldBeActive(wallet);

    // Enhanced redemption window logging
    const inRedemptionWindow = AUTO_REDEEM_ENABLED && nowMinutes >= REDEEM_WINDOW_START && nowMinutes <= REDEEM_WINDOW_END;
    if (inRedemptionWindow && holdings.length > 0) {
      logInfo(wallet.address, '🔔', `REDEMPTION ALERT: In redemption window (minute ${nowMinutes}) with ${holdings.length} position(s) - isActive=${isActive}`);
      holdings.forEach(h => {
        logInfo(wallet.address, '📋', `  - Position: ${h.marketAddress.substring(0, 8)}... outcome=${h.outcomeIndex} cost=${h.cost} strategy=${h.strategy || 'default'}`);
      });
    }

    if (!isActive) {
      // Check if all strategies are disabled
      const allStrategiesDisabled = !LATE_STRATEGY_ENABLED && !MOONSHOT_ENABLED && !AUTO_REDEEM_ENABLED;

      if (allStrategiesDisabled) {
        // Deep sleep mode - no strategies enabled
        if (holdings.length > 0) {
          logWarn(wallet.address, '⚠️', `💤 DEEP SLEEP: All strategies disabled but ${holdings.length} position(s) exist. Enable strategies to trade.`);
        } else {
          // Only log once per hour to avoid spam
          const shouldLog = nowMinutes === 0 || (nowMinutes % 15 === 0); // Log every 15 minutes
          if (shouldLog) {
            logInfo(wallet.address, '💤', `DEEP SLEEP: All trading strategies disabled. Enable LATE_STRATEGY_ENABLED or MOONSHOT_ENABLED to start trading.`);
          }
        }
        return;
      }

      // Normal sleep between trading windows
      const nextWakeMs = getNextWakeTime();
      const nextWakeMinutes = Math.floor(nextWakeMs / 60000);
      const nextWakeSeconds = Math.floor((nextWakeMs % 60000) / 1000);

      const activeStrategies = [];
      if (LATE_STRATEGY_ENABLED) activeStrategies.push('Late');
      if (MOONSHOT_ENABLED) activeStrategies.push('Moonshot');

      logInfo(wallet.address, '💤', `Sleep mode (minute ${nowMinutes}, ${holdings.length} positions, strategies: ${activeStrategies.join('+')}) - Wake in ${nextWakeMinutes}m ${nextWakeSeconds}s`);

      // Critical warning if we have positions but bot is sleeping during redemption window
      if (inRedemptionWindow && holdings.length > 0) {
        logWarn(wallet.address, '⚠️', `WARNING: Bot is sleeping during redemption window with ${holdings.length} positions! This should not happen!`);
      }
      return;
    }

    // Clear buyingInProgress at start of each tick - it's just for preventing concurrent buys within same tick
    buyingInProgress.clear();

    // Clear inactive markets set every hour and show position summary
    const nowHour = new Date().getHours();
    if (currentHourForInactive !== nowHour) {
      inactiveMarketsThisHour.clear();
      currentHourForInactive = nowHour;
      logInfo(wallet.address, '🔄', `New hour started - cleared inactive markets cache`);

      // Show positions summary at the start of each hour (only during active periods)
      logPositionsSummary(wallet.address);
    }

    try {
      logInfo(wallet.address, '🔄', `Polling market data (oracles=[${PRICE_ORACLE_IDS.join(', ')}], freq=${FREQUENCY})...`);
      const allMarketsData = await fetchMarkets();

      // Redemption window: Only check for redemptions during configured time window
      // This allows time for market settlement after closing at :00
      const nowMinutes = new Date().getMinutes();
      const inRedemptionWindow = AUTO_REDEEM_ENABLED && nowMinutes >= REDEEM_WINDOW_START && nowMinutes <= REDEEM_WINDOW_END;

      // Log redemption window status every tick during the window
      if (AUTO_REDEEM_ENABLED && nowMinutes >= REDEEM_WINDOW_START && nowMinutes <= REDEEM_WINDOW_END) {
        logInfo(wallet.address, '🕐', `Currently in REDEMPTION WINDOW (minute ${nowMinutes}, window: ${REDEEM_WINDOW_START}-${REDEEM_WINDOW_END})`);
      }

      if (inRedemptionWindow) {
        // Check for positions that need redemption using local state
        const myHoldings = getAllHoldings(wallet.address);
        if (myHoldings.length > 0) {
          logInfo(wallet.address, '💰', `Redemption window active - checking ${myHoldings.length} position(s)...`);

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
              const marketAddress = holding.marketAddress;

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
                  const rawData = res.data;

                  // Normalize structure - handle different API response formats
                  // 1. Oracle markets: { market: { address: "0x..." }, isActive: true, resolved: false }
                  // 2. Group markets: { markets: [{...}], status: "RESOLVED" } (multi-outcome)
                  // 3. Single market by address might return either format

                  if (rawData.market && rawData.market.address) {
                    // Already in correct format (oracle market)
                    marketData = rawData;
                  } else if (rawData.markets && Array.isArray(rawData.markets)) {
                    // Group market - need to find which sub-market matches our holding
                    // Group markets return array of markets, we need the one matching our address
                    const specificMarket = rawData.markets.find(m =>
                      m.address?.toLowerCase() === holding.marketAddress.toLowerCase()
                    );

                    if (specificMarket) {
                      // Wrap in expected structure
                      marketData = {
                        market: specificMarket,
                        resolved: specificMarket.status === 'RESOLVED',
                        isActive: !specificMarket.expired
                      };
                    } else {
                      // The market address might be the group address, not an individual market
                      // In this case, we can't determine which sub-market to redeem
                      logWarn(wallet.address, '⚠️', `[${holding.marketAddress.substring(0, 8)}...] Group market detected but can't determine specific sub-market. Manual redemption may be needed.`);
                      logRedemption({
                        event: 'GROUP_MARKET_UNSUPPORTED',
                        wallet: wallet.address,
                        marketAddress: holding.marketAddress,
                        groupMarketId: rawData.id,
                        subMarketsCount: rawData.markets.length,
                        reason: 'Bot trades oracle markets, this is a group market (multi-outcome)'
                      });
                      continue;
                    }
                  } else if (rawData.address || rawData.conditionId) {
                    // Direct market object - wrap it
                    marketData = {
                      market: rawData,
                      resolved: rawData.status === 'RESOLVED',
                      isActive: !rawData.expired
                    };
                  } else {
                    // Unknown structure
                    logWarn(wallet.address, '⚠️', `[${holding.marketAddress.substring(0, 8)}...] Unknown market data structure from API`);
                    logRedemption({
                      event: 'UNKNOWN_MARKET_STRUCTURE',
                      wallet: wallet.address,
                      marketAddress: holding.marketAddress,
                      dataKeys: Object.keys(rawData).slice(0, 10)
                    });
                    continue;
                  }

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

              // Validate market data structure
              if (!marketData || !marketData.market) {
                logWarn(wallet.address, '⚠️', `[${holding.marketAddress.substring(0, 8)}...] Invalid market data structure, skipping`);
                logRedemption({
                  event: 'INVALID_MARKET_DATA',
                  wallet: wallet.address,
                  marketAddress: holding.marketAddress,
                  marketData: marketData
                });
                continue;
              }

              // Extract collateral token address - handle different API response formats
              let collateralTokenAddress;
              try {
                if (marketData.market.collateralToken?.address) {
                  collateralTokenAddress = ethers.getAddress(marketData.market.collateralToken.address);
                } else if (marketData.collateralToken?.address) {
                  collateralTokenAddress = ethers.getAddress(marketData.collateralToken.address);
                } else {
                  logWarn(wallet.address, '⚠️', `[${holding.marketAddress.substring(0, 8)}...] No collateralToken found in market data, skipping`);
                  logRedemption({
                    event: 'NO_COLLATERAL_TOKEN',
                    wallet: wallet.address,
                    marketAddress: holding.marketAddress,
                    marketDataKeys: Object.keys(marketData),
                    marketKeys: Object.keys(marketData.market || {})
                  });
                  continue;
                }
              } catch (e) {
                logWarn(wallet.address, '⚠️', `[${holding.marketAddress.substring(0, 8)}...] Error parsing collateral token: ${e?.message}`);
                continue;
              }

              // Get or create conditional tokens contract
              const marketAddressChecksummed = ethers.getAddress(holding.marketAddress);
              if (!cachedContracts.has(marketAddressChecksummed)) {
                // Initialize contracts for this market if not cached
                const market = new ethers.Contract(marketAddressChecksummed, MARKET_ABI, wallet);
                const usdc = new ethers.Contract(collateralTokenAddress, ERC20_ABI, wallet);
                const conditionalTokensAddress = await retryRpcCall(async () => await market.conditionalTokens());
                const erc1155 = new ethers.Contract(ethers.getAddress(conditionalTokensAddress), ERC1155_ABI, wallet);
                const decimals = Number(await retryRpcCall(async () => await usdc.decimals()));
                cachedContracts.set(marketAddressChecksummed, { market, usdc, erc1155, decimals, conditionalTokensAddress });
              }

              const { conditionalTokensAddress, usdc, decimals } = cachedContracts.get(marketAddressChecksummed);
              const conditionalTokensContract = new ethers.Contract(
                conditionalTokensAddress,
                CONDITIONAL_TOKENS_ABI,
                wallet
              );

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
                logInfo(wallet.address, '⏭️', `[${holding.marketAddress.substring(0, 8)}...] Position not redeemed - Check redemptions.jsonl for details`);
                logRedemption({
                  event: 'REDEMPTION_SKIPPED_SUMMARY',
                  wallet: wallet.address,
                  marketAddress: holding.marketAddress,
                  reason: 'Check previous redemption log entries for details (market not resolved, already claimed, or no tokens)'
                });
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
    // First, check if we already have a position in this market via API
    try {
      const portfolioData = await fetchPortfolioData(wallet.address);
      if (portfolioData && portfolioData.amm) {
        const existingPosition = portfolioData.amm.find(pos =>
          pos.market.id.toLowerCase() === marketAddress.toLowerCase() &&
          !pos.market.closed && // Only check open markets
          (parseFloat(pos.outcomeTokenAmount || 0) > 0 || parseFloat(pos.collateralAmount || 0) > 0)
        );

        if (existingPosition) {
          logInfo(wallet.address, '⚠️', `[${marketAddress.substring(0, 8)}...] Already have position (${existingPosition.outcomeTokenAmount} tokens, outcome ${existingPosition.outcomeIndex}) - skipping buy to prevent double position`);
          return;
        }
      }
    } catch (error) {
      logWarn(wallet.address, '⚠️', `Failed to check existing positions: ${error?.message || error} - proceeding with buy`);
    }

    // Compute minOutcomeTokensToBuy via calcBuyAmount and slippage
    logInfo(wallet.address, '🧮', `[${marketAddress.substring(0, 8)}...] Calculating expected tokens for investment=${investment}...`, strategy);
    const expectedTokens = await retryRpcCall(async () => await market.calcBuyAmount(investment, outcomeToBuy));
    const minOutcomeTokensToBuy = expectedTokens - (expectedTokens * BigInt(SLIPPAGE_BPS)) / 10000n;
    logInfo(wallet.address, '🛒', `Buying outcome=${outcomeToBuy} invest=${investment} expectedTokens=${expectedTokens} minTokens=${minOutcomeTokensToBuy} slippage=${SLIPPAGE_BPS}bps`, strategy);

    // Execute transaction
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
      strategy: strategy, // 'default', 'moonshot', or other strategies
      entryPrice: prices[outcomeToBuy] || 'Unknown',
      buyTimestamp: new Date().toISOString(),
      marketDeadline: marketInfo?.deadline || null,
      buyTxHash: buyTx.hash,
      // Scale-in tracking
      scaleInEnabled: SCALE_IN_ENABLED && strategy === 'default',
      scaleInStep: 1, // Current step (1 = first entry)
      scaleInTotalSteps: SCALE_IN_POSITIONS,
      scaleInInitialOdds: prices[outcomeToBuy] || null,
      scaleInDropPct: SCALE_IN_DROP_PCT
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

      // Parse market title to extract asset and target price
      // Format: "$ETH above $3983.88 on Oct 15, 17:00 UTC?"
      let assetInfo = '';
      if (marketInfo && marketInfo.title) {
        const titleMatch = marketInfo.title.match(/\$([A-Z]+)\s+(above|below)\s+\$?([\d,\.]+)/i);
        if (titleMatch) {
          const asset = titleMatch[1];
          const direction = titleMatch[2];
          const targetPrice = titleMatch[3];
          assetInfo = ` | 🎯 Target: ${asset} ${direction} $${targetPrice}`;
        }
      }

      logInfo(wallet.address, '💹', `[${marketAddress.substring(0, 8)}...] Prediction: YES ${prices[0]}% | NO ${prices[1]}%${assetInfo}`);

      // Pre-compute timing guardrails for buying
      const nowMs = Date.now();
      let tooNewForBet = false;
      let nearDeadlineForBet = false;
      let inLastThirteenMinutes = false;
      let inLastTwoMinutes = false;
      let inLastThreeMinutes = false;
      let inMoonshotWindow = false;

      // Check market age for "too new" restriction
      if (marketInfo.createdAt) {
        const createdMs = new Date(marketInfo.createdAt).getTime();
        if (!Number.isNaN(createdMs)) {
          const ageMs = nowMs - createdMs;
          const ageMin = Math.max(0, Math.floor(ageMs / 60000));

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
            logInfo(wallet.address, '🕐', `[${marketAddress.substring(0, 8)}...] In last ${STOP_LOSS_MINUTES} minutes (${remMin}m remaining) - stop loss active if PnL below ${STOP_LOSS_PNL_PCT}%`);
          }

          // Check if in buy window
          if (remainingMs <= BUY_WINDOW_MINUTES * 60 * 1000 && remainingMs > 0) {
            inLastThirteenMinutes = true;
            logInfo(wallet.address, '🕐', `[${marketAddress.substring(0, 8)}...] In last ${BUY_WINDOW_MINUTES} minutes (${remMin}m remaining) - can buy if ${MIN_ODDS}-${MAX_ODDS}%`);
          }

          // Check if in moonshot window
          const moonshotWindowMs = MOONSHOT_WINDOW_MINUTES * 60 * 1000;
          inMoonshotWindow = remainingMs <= moonshotWindowMs && remainingMs > 0;
          if (MOONSHOT_ENABLED) {
            if (inMoonshotWindow) {
              logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] ✅ IN MOONSHOT WINDOW: ${remMin}m remaining <= ${MOONSHOT_WINDOW_MINUTES}min threshold - contrarian bets enabled`);
            } else {
              logInfo(wallet.address, '🔍', `[${marketAddress.substring(0, 8)}...] Not in moonshot window yet: ${remMin}m remaining > ${MOONSHOT_WINDOW_MINUTES}min threshold`);
            }
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

      // Check ALL positions for this market (could have multiple strategies)
      const allHoldingsThisMarket = getHoldingsForMarket(wallet.address, marketAddress);
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
      const hasLocalHoldings = allHoldingsThisMarket.length > 0;
      const hasAny = hasOnchain || hasLocalHoldings;

      // Process ALL existing positions for this market
      if (hasAny) {
        // Log how many holdings we have for this market
        if (allHoldingsThisMarket.length > 1) {
          logInfo(wallet.address, '🔍', `[${marketAddress.substring(0, 8)}...] Found ${allHoldingsThisMarket.length} holdings for this market (multiple strategies)`);
          allHoldingsThisMarket.forEach((h, idx) => {
            logInfo(wallet.address, '📋', `  [${idx+1}] Strategy: ${h.strategy || 'default'}, TokenId: ${h.tokenId?.toString().substring(0, 20)}..., Cost: ${h.cost ? ethers.formatUnits(h.cost, decimals) : 'unknown'} USDC`);
          });
        }

        // Determine which outcome is held, then ensure we have cost basis
        let outcomeIndex = null;
        let tokenId = null;
        let tokenBalance = 0n;
        if (bal0 > 0n) { outcomeIndex = 0; tokenId = pid0; tokenBalance = bal0; }
        if (bal1 > 0n) { outcomeIndex = 1; tokenId = pid1; tokenBalance = bal1; }

        // Find matching holding from local state (match by tokenId)
        // IMPORTANT: If multiple holdings share same tokenId (multiple strategies on same outcome),
        // this will only process the FIRST one!
        let holding = allHoldingsThisMarket.find(h => h.tokenId === tokenId);

        if (holding) {
          logInfo(wallet.address, '🎯', `[${marketAddress.substring(0, 8)}...] Processing holding: Strategy=${holding.strategy || 'default'}, TokenId match found`);
        }

        // Initialize cost basis from env if missing
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
        let calcSellFailed = false;

        try {
          tokensNeededForCost = await market.calcSellAmount(cost, outcomeIndex);
        } catch (e) {
          calcSellFailed = true;
          const errorMsg = e?.reason || e?.message || String(e);

          // Check if market is likely closed/expired
          if (errorMsg.includes('subtraction overflow') || errorMsg.includes('insufficient liquidity')) {
            logWarn(wallet.address, '⚠️', `[${marketAddress.substring(0, 8)}...] calcSellAmount failed (likely market closed/expired): ${errorMsg.substring(0, 100)}`);
            logInfo(wallet.address, '💡', `[${marketAddress.substring(0, 8)}...] Position may need redemption - check during redemption window`);
          } else {
            logErr(wallet.address, '💥', `[${marketAddress.substring(0, 8)}...] calcSellAmount failed: ${errorMsg.substring(0, 100)}`);
          }

          // Don't return - continue processing to check if market needs redemption
          // But we can't calculate PnL, so skip position value display
        }

        if (!calcSellFailed && tokensNeededForCost === 0n) {
          logWarn(wallet.address, '⚠️', `[${marketAddress.substring(0, 8)}...] calcSellAmount returned 0 - market may be closed or have no liquidity`);
          calcSellFailed = true;
        }

        // Only calculate PnL if calcSellAmount succeeded
        let positionValue = 0n;
        let pnlAbs = 0n;
        let pnlPct = 0;

        if (!calcSellFailed) {
          positionValue = (tokenBalance * cost) / tokensNeededForCost; // floor
          pnlAbs = positionValue - cost; // signed
          pnlPct = cost > 0n ? Number((pnlAbs * 10000n) / cost) / 100 : 0;
          const signEmoji = pnlAbs >= 0n ? '🔺' : '🔻';
          const valueHuman = fmtUnitsPrec(positionValue, decimals, 4);
          const costHuman = fmtUnitsPrec(cost, decimals, 4);
          const pnlAbsHuman = fmtUnitsPrec(pnlAbs >= 0n ? pnlAbs : -pnlAbs, decimals, 4);

          // Get current price and entry price
          const currentPrice = prices[outcomeIndex] || 'N/A';
          const entryPrice = holding.entryPrice || 'N/A';
          const strategyLabel = (holding.strategy || 'default').toUpperCase();

          logInfo(wallet.address, '📈', `[${marketAddress.substring(0, 8)}...] [${strategyLabel}] Position Side ${outcomeIndex}: Entry ${entryPrice}% → Now ${currentPrice}% | Value=${valueHuman} Cost=${costHuman} | PnL=${pnlPct.toFixed(2)}% ${signEmoji}${pnlAbsHuman} USDC`);
        } else {
          // Can't calculate PnL, just show basic position info
          const currentPrice = prices[outcomeIndex] || 'N/A';
          const entryPrice = holding.entryPrice || 'N/A';
          const strategyLabel = (holding.strategy || 'default').toUpperCase();
          const costHuman = fmtUnitsPrec(cost, decimals, 4);

          logInfo(wallet.address, '📊', `[${marketAddress.substring(0, 8)}...] [${strategyLabel}] Position Side ${outcomeIndex}: Entry ${entryPrice}% → Now ${currentPrice}% | Balance=${tokenBalance.toString()} tokens | Cost=${costHuman} USDC (PnL unavailable - market may be closed)`);
        }

        // Stop loss: sell if PnL drops below threshold in last N minutes
        // Skip if calcSellAmount failed (market likely closed) or if we can't calculate PnL
        if (STOP_LOSS_ENABLED && inLastThreeMinutes && !calcSellFailed && !Number.isNaN(pnlPct) && pnlPct < STOP_LOSS_PNL_PCT) {
          logInfo(wallet.address, '🚨', `[${marketAddress.substring(0, 8)}...] Stop loss! PnL ${pnlPct.toFixed(2)}% below threshold ${STOP_LOSS_PNL_PCT}%`);

          const maxOutcomeTokensToSell = tokenBalance;
          const returnAmountForSell = positionValue > 0n ? positionValue - (positionValue / 100n) : 0n;
          logInfo(wallet.address, '🧮', `Stop loss sell: maxTokens=${maxOutcomeTokensToSell}, returnAmount=${returnAmountForSell}`);

          // Execute stop loss
          const approvedOk = await ensureErc1155Approval(wallet, erc1155, marketAddress);
          if (!approvedOk) {
            logWarn(wallet.address, '🛑', 'Approval not confirmed; skipping stop loss sell this tick.');
            return;
          }

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
          logInfo(wallet.address, '✅', `[${marketAddress.substring(0, 8)}...] Stop loss sell completed. PnL: ${pnlPct.toFixed(2)}%`);

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
            reason: `Stop loss - PnL ${pnlPct.toFixed(2)}% < ${STOP_LOSS_PNL_PCT}%`,
            txHash: tx.hash,
            blockNumber: sellReceipt.blockNumber,
            gasUsed: sellReceipt.gasUsed.toString()
          });
          updateStats(pnlUSDC);

          // Remove only this strategy's holding, not all holdings for this market
          const strategyToRemove = holding?.strategy || 'default';
          removeHolding(wallet.address, marketAddress, strategyToRemove);

          // Don't mark market as completed - other strategies may still want to trade it
          // markMarketCompleted(wallet.address, marketAddress);
          logInfo(wallet.address, '🗑️', `[${marketAddress.substring(0, 8)}...] Removed ${strategyToRemove} holding after stop loss`);
          return;
        }

        // SCALE-IN MONITORING: Check if we should scale in with additional buy
        if (holding?.scaleInEnabled && holding?.scaleInStep < holding?.scaleInTotalSteps) {
          const currentStep = holding.scaleInStep || 1;
          const totalSteps = holding.scaleInTotalSteps || SCALE_IN_POSITIONS;
          const initialOdds = holding.scaleInInitialOdds;
          const currentOdds = prices[outcomeIndex];
          const dropPct = holding.scaleInDropPct || SCALE_IN_DROP_PCT;

          if (initialOdds && currentOdds) {
            // Calculate how much odds have dropped
            const oddsDropPct = ((initialOdds - currentOdds) / initialOdds) * 100;

            logInfo(wallet.address, '📊', `[${marketAddress.substring(0, 8)}...] Scale-in check (step ${currentStep}/${totalSteps}): Initial ${initialOdds}% → Current ${currentOdds}% (${oddsDropPct.toFixed(1)}% drop, threshold: ${dropPct}%)`);

            // If odds have dropped enough, execute scale-in buy
            if (oddsDropPct >= dropPct) {
              logInfo(wallet.address, '📈', `[${marketAddress.substring(0, 8)}...] Scale-in triggered! Odds dropped ${oddsDropPct.toFixed(1)}% (>= ${dropPct}%). Buying step ${currentStep + 1}/${totalSteps}...`);

              // Calculate scaled investment for this step
              const fullAmount = getBuyAmountForStrategy('default');
              const scaledAmount = fullAmount / totalSteps;
              const scaleInInvestment = ethers.parseUnits(scaledAmount.toString(), decimals);

              // Check USDC balance
              const usdcBal = await retryRpcCall(async () => await usdc.balanceOf(wallet.address));
              if (usdcBal >= scaleInInvestment) {
                try {
                  // Ensure approval
                  const approvedOk = await ensureErc20Approval(wallet, usdc, marketAddress, scaleInInvestment, decimals);
                  if (!approvedOk) {
                    logWarn(wallet.address, '🛑', 'Approval not confirmed for scale-in; skipping this tick.');
                    return;
                  }

                  // Execute the scale-in buy
                  const minOut = scaleInInvestment - (scaleInInvestment / 100n); // 1% slippage
                  const gasEst = await estimateGasFor(market, wallet, 'buy', [scaleInInvestment, outcomeIndex, minOut]);
                  if (!gasEst) {
                    logWarn(wallet.address, '🛑', 'Gas estimate failed for scale-in buy');
                    return;
                  }

                  const padded = (gasEst * 120n) / 100n + 10000n;
                  const buyOv = await txOverrides(wallet.provider, padded);
                  const buyTx = await market.buy(scaleInInvestment, outcomeIndex, minOut, buyOv);
                  logInfo(wallet.address, '🧾', `Scale-in buy tx (step ${currentStep + 1}/${totalSteps}): ${buyTx.hash}`);

                  const receipt = await buyTx.wait(CONFIRMATIONS);
                  logInfo(wallet.address, '✅', `[${marketAddress.substring(0, 8)}...] Scale-in buy confirmed (step ${currentStep + 1}/${totalSteps})`);

                  // Update holding for scale-in (cumulative cost and amount)
                  updateHoldingForScaleIn(wallet.address, marketAddress, 'default', scaleInInvestment.toString(), buyTx.hash);

                  // Log the scale-in trade
                  logTrade({
                    type: 'SCALE_IN',
                    wallet: wallet.address,
                    marketAddress,
                    marketTitle: marketInfo?.title || 'Unknown',
                    outcome: outcomeIndex,
                    investmentUSDC: scaledAmount.toFixed(2),
                    step: `${currentStep + 1}/${totalSteps}`,
                    currentOdds: currentOdds,
                    initialOdds: initialOdds,
                    oddsDropPct: oddsDropPct.toFixed(1),
                    txHash: buyTx.hash,
                    blockNumber: receipt.blockNumber
                  });
                } catch (err) {
                  logErr(wallet.address, '💥', `Scale-in buy failed: ${err?.message || err}`);
                }
              } else {
                logWarn(wallet.address, '⚠️', `[${marketAddress.substring(0, 8)}...] Insufficient USDC for scale-in. Need $${scaledAmount}, have ${ethers.formatUnits(usdcBal, decimals)}`);
              }
            }
          }
        }

        // Determine profit target based on strategy
        const strategyType = holding?.strategy || 'default';
        let profitTarget = TARGET_PROFIT_PCT; // Default for 'default' strategy
        if (strategyType === 'moonshot') {
          profitTarget = MOONSHOT_PROFIT_TARGET_PCT;
        }

        // Hold positions during last 13 minutes if using last-minute strategy - don't take profits early
        if (inLastThirteenMinutes && strategyType === 'default') {
          logInfo(wallet.address, '💎', `[${marketAddress.substring(0, 8)}...] Holding position until market closes (last 13min strategy)`);
          // Don't return - other strategies may want to trade
        }

        // Check if we already took profits on this position
        const alreadyTookProfit = holding?.profitTaken === true;

        // Debug logging for sell decision
        logInfo(wallet.address, '🔍', `[${marketAddress.substring(0, 8)}...] Sell check: calcSellFailed=${calcSellFailed}, pnlAbs=${pnlAbs > 0n ? '+' : '-'}, pnlPct=${pnlPct.toFixed(2)}%, profitTarget=${profitTarget}%, alreadyTookProfit=${alreadyTookProfit}, strategy=${strategyType}`);

        // QUICK SCALP SELL LOGIC: Sell when odds reach target multiplier
        if (strategyType === 'quick_scalp' && !calcSellFailed) {
          const entryOdds = holding?.entryPrice;
          const currentOdds = prices[outcomeIndex];
          const targetOdds = entryOdds * QUICK_SCALP_PROFIT_MULTIPLIER;

          logInfo(wallet.address, '⚡', `[${marketAddress.substring(0, 8)}...] Quick scalp check: Entry ${entryOdds}% → Current ${currentOdds}% (Target: ${targetOdds}% = ${QUICK_SCALP_PROFIT_MULTIPLIER}x entry)`);

          if (currentOdds >= targetOdds) {
            // Target reached! Sell position
            logInfo(wallet.address, '💰', `[${marketAddress.substring(0, 8)}...] Quick scalp target reached! ${currentOdds}% >= ${targetOdds}% (${QUICK_SCALP_PROFIT_MULTIPLIER}x from ${entryOdds}%). Selling position...`);

            const approvedOk = await ensureErc1155Approval(wallet, erc1155, marketAddress);
            if (!approvedOk) {
              logWarn(wallet.address, '🛑', 'Approval not confirmed; skipping quick scalp sell this tick.');
              return;
            }

            // Sell 100% of position
            const maxOutcomeTokensToSell = tokenBalance;
            const returnAmountForSell = positionValue - (positionValue / 100n); // minus 1% safety

            const gasEst = await estimateGasFor(market, wallet, 'sell', [returnAmountForSell, outcomeIndex, maxOutcomeTokensToSell]);
            if (!gasEst) {
              logWarn(wallet.address, '🛑', 'Gas estimate sell failed; skipping quick scalp sell this tick.');
              return;
            }

            const padded = (gasEst * 120n) / 100n + 10000n;
            const sellOv = await txOverrides(wallet.provider, padded);
            const tx = await market.sell(returnAmountForSell, outcomeIndex, maxOutcomeTokensToSell, sellOv);
            logInfo(wallet.address, '🧾', `Quick scalp sell tx: ${tx.hash}`);
            const receipt = await tx.wait(CONFIRMATIONS);

            const pnlUSDC = parseFloat(ethers.formatUnits(positionValue - cost, decimals));
            const oddsGain = currentOdds - entryOdds;
            logInfo(wallet.address, '✅', `[${marketAddress.substring(0, 8)}...] Quick scalp sold! Entry ${entryOdds}% → Exit ${currentOdds}% (+${oddsGain.toFixed(1)}% odds gain, PnL=${pnlPct.toFixed(2)}%)`);

            logTrade({
              type: 'SELL_QUICK_SCALP',
              wallet: wallet.address,
              marketAddress,
              marketTitle: marketInfo?.title || 'Unknown',
              outcome: outcomeIndex,
              costUSDC: ethers.formatUnits(cost, decimals),
              returnUSDC: ethers.formatUnits(positionValue, decimals),
              pnlUSDC: pnlUSDC.toFixed(4),
              pnlPercent: pnlPct.toFixed(2),
              entryOdds: entryOdds,
              exitOdds: currentOdds,
              oddsMultiplier: (currentOdds / entryOdds).toFixed(2),
              reason: `Quick scalp: ${entryOdds}% → ${currentOdds}% (${QUICK_SCALP_PROFIT_MULTIPLIER}x target reached)`,
              txHash: tx.hash,
              blockNumber: receipt.blockNumber,
              gasUsed: receipt.gasUsed.toString()
            });
            updateStats(pnlUSDC);

            removeHolding(wallet.address, marketAddress, strategyType);
            logInfo(wallet.address, '🗑️', `[${marketAddress.substring(0, 8)}...] Removed quick_scalp holding after profitable exit`);
            return;
          }
        }

        // Only attempt profit-taking if enabled and calcSellAmount succeeded (market is active)
        if (AUTO_PROFIT_SELL_ENABLED && !calcSellFailed && pnlAbs > 0n && pnlPct >= profitTarget && !alreadyTookProfit) {
          // Always sell 100% of position
          logInfo(wallet.address, '🎯', `Profit target reached! PnL=${pnlPct.toFixed(2)}% >= ${profitTarget}% (${strategyType} strategy). Selling 100% of position...`);

          const approvedOk = await ensureErc1155Approval(wallet, erc1155, marketAddress);
          if (!approvedOk) {
            logWarn(wallet.address, '🛑', 'Approval not confirmed; skipping sell this tick.');
            return;
          }

          // Sell 100% of position
          const maxOutcomeTokensToSell = tokenBalance;
          const returnAmountForSell = positionValue - (positionValue / 100n); // minus 1% safety

          logInfo(wallet.address, '🧮', `Calculating 100% sell: maxTokens=${maxOutcomeTokensToSell}, returnAmount=${returnAmountForSell} (positionValue=${positionValue} - 1% safety)`);

          // Execute sell transaction
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

          // Calculate PNL for full position
          const pnlAbsValue = positionValue - cost;
          const pnlUSDC = parseFloat(ethers.formatUnits(pnlAbsValue, decimals));
          const pnlAbsHuman = fmtUnitsPrec(pnlAbsValue >= 0n ? pnlAbsValue : -pnlAbsValue, decimals, 4);
          const signEmoji = pnlAbsValue >= 0n ? '🔺' : '🔻';

          logInfo(wallet.address, '✅', `[${marketAddress.substring(0, 8)}...] 100% sell completed. PnL: ${signEmoji}${pnlAbsHuman} USDC (${pnlPct.toFixed(2)}%)`);

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
            reason: `Profit target reached ${pnlPct.toFixed(2)}% >= ${profitTarget}% - sold 100%`,
            txHash: tx.hash,
            blockNumber: profitSellReceipt.blockNumber,
            gasUsed: profitSellReceipt.gasUsed.toString()
          });
          updateStats(pnlUSDC);

          // Full sell - remove only this strategy's holding, not all holdings for this market
          const strategyToRemove = holding?.strategy || 'default';
          removeHolding(wallet.address, marketAddress, strategyToRemove);

          // Don't mark market as completed - other strategies may still want to trade it
          logInfo(wallet.address, '🗑️', `[${marketAddress.substring(0, 8)}...] Removed ${strategyToRemove} holding after profit sell`);
          return;
        } else if (AUTO_PROFIT_SELL_ENABLED) {
          logInfo(wallet.address, '📊', `[${marketAddress.substring(0, 8)}...] Not profitable yet: PnL=${pnlPct.toFixed(2)}% < ${profitTarget}% (${strategyType} strategy)`);
        } else {
          logInfo(wallet.address, '💎', `[${marketAddress.substring(0, 8)}...] Holding position: PnL=${pnlPct.toFixed(2)}% (profit selling disabled - will redeem at market close)`);
        }

        // Don't return here - continue to check if other strategies can buy
        // The strategy-specific buy checks below will handle whether to buy
      }

      // Check if we should buy with any strategy (independent of existing positions)
      if (!Array.isArray(prices) || prices.length < 2) {
        logWarn(wallet.address, '⚠️', `[${marketAddress.substring(0, 8)}...] Prices unavailable; skipping.`);
        return;
      }

      // NOTE: We do NOT check global "completed" status here because strategies are independent
      // Each strategy checks its own holding status before buying

      // Prevent duplicate buys - check if buy is in progress for this market
      const marketKey = marketAddress.toLowerCase();
      if (buyingInProgress.has(marketKey)) {
        logInfo(wallet.address, '🔒', `[${marketAddress.substring(0, 8)}...] Buy already in progress for this market; skipping.`);
        return;
      }

      // Mark as buying NOW to prevent race conditions
      buyingInProgress.add(marketKey);

      // Use try/finally to ensure buyingInProgress is always cleared
      try {
      // Additional guardrails for betting:
      const positionIdsValid = Array.isArray(positionIds) && positionIds.length >= 2 && positionIds[0] && positionIds[1];
      if (!positionIdsValid) {
        logWarn(wallet.address, '🛑', 'Position IDs missing/invalid — skip betting');
        return;
      }

      // QUICK SCALP STRATEGY: Early market arbitrage (first 40 minutes)
      if (QUICK_SCALP_ENABLED && marketInfo.createdAt) {
        const createdMs = new Date(marketInfo.createdAt).getTime();
        const nowMs = Date.now();
        const marketAgeMinutes = Math.floor((nowMs - createdMs) / 60000);

        // Check if market is in quick scalp window (first N minutes)
        if (marketAgeMinutes <= QUICK_SCALP_WINDOW_MINUTES) {
          // Check if we already have a quick scalp position
          const quickScalpHolding = getHolding(wallet.address, marketAddress, 'quick_scalp');
          if (!quickScalpHolding) {
            // Look for imbalanced odds - find side with odds in entry range
            const side0Odds = prices[0];
            const side1Odds = prices[1];

            let targetSide = null;
            let targetOdds = null;

            // Check if either side is in the entry range
            if (side0Odds >= QUICK_SCALP_MIN_ENTRY_ODDS && side0Odds <= QUICK_SCALP_MAX_ENTRY_ODDS) {
              targetSide = 0;
              targetOdds = side0Odds;
            } else if (side1Odds >= QUICK_SCALP_MIN_ENTRY_ODDS && side1Odds <= QUICK_SCALP_MAX_ENTRY_ODDS) {
              targetSide = 1;
              targetOdds = side1Odds;
            }

            if (targetSide !== null) {
              // Found an opportunity! Buy it
              const investmentHuman = getBuyAmountForStrategy('quick_scalp');
              const investment = ethers.parseUnits(investmentHuman.toString(), decimals);

              logInfo(wallet.address, '⚡', `[${marketAddress.substring(0, 8)}...] Quick Scalp opportunity! Market age ${marketAgeMinutes}min, buying side ${targetSide} at ${targetOdds}% (entry range: ${QUICK_SCALP_MIN_ENTRY_ODDS}-${QUICK_SCALP_MAX_ENTRY_ODDS}%)`);

              // Check USDC balance
              const usdcBal = await retryRpcCall(async () => await usdc.balanceOf(wallet.address));
              if (usdcBal >= investment) {
                await executeBuy(wallet, market, usdc, marketAddress, investment, targetSide, decimals, pid0, pid1, erc1155, 'quick_scalp');
                return; // Exit after quick scalp buy
              } else {
                logWarn(wallet.address, '⚠️', `Insufficient USDC for quick scalp. Need ${investmentHuman}, have ${ethers.formatUnits(usdcBal, decimals)}.`);
              }
            }
          } else {
            // We have a quick scalp position - sell logic will be handled in the position monitoring section
            logInfo(wallet.address, '⚡', `[${marketAddress.substring(0, 8)}...] Quick scalp position exists (age ${marketAgeMinutes}min) - monitoring for exit`);
          }
        }
      }

      // NEW LOGIC: Check if we should use last 13 minutes strategy
      if (inLastThirteenMinutes) {
        // Check if late strategy is enabled
        if (!LATE_STRATEGY_ENABLED) {
          logInfo(wallet.address, '⏸️', `[${marketAddress.substring(0, 8)}...] Late window strategy disabled - skipping`);
          return;
        }

        // Check if late strategy already has a position
        const lateStrategy = 'default';
        const lateHolding = getHolding(wallet.address, marketAddress, lateStrategy);
        if (lateHolding) {
          if (MOONSHOT_ENABLED && inMoonshotWindow) {
            logInfo(wallet.address, '🛑', `[${marketAddress.substring(0, 8)}...] Late window strategy already has a position - skipping late buy, will check moonshot below`);
            // Skip to end of late strategy block to check moonshot
          } else {
            logInfo(wallet.address, '🛑', `[${marketAddress.substring(0, 8)}...] Late window strategy already has a position - skipping buy`);
            return; // No moonshot, so exit
          }
        } else {
        // Only execute late buy logic if we don't have a position yet

        // Check if in last 2 minutes - don't buy (but let independent moonshot handle it if enabled)
        if (inLastTwoMinutes) {
          if (MOONSHOT_ENABLED && inMoonshotWindow) {
            logInfo(wallet.address, '⏳', `[${marketAddress.substring(0, 8)}...] In last 2 minutes - skipping late strategy, will check moonshot below`);
          } else {
            logInfo(wallet.address, '⏳', `[${marketAddress.substring(0, 8)}...] In last 2 minutes - not buying`);
          }
          return; // Exit late strategy block to allow independent moonshot strategy to run
        }

        // In last 13 minutes - IGNORE the "too new" check, only check if deadline is too close
        if (nearDeadlineForBet) {
          if (MOONSHOT_ENABLED && inMoonshotWindow) {
            logInfo(wallet.address, '⏳', `[${marketAddress.substring(0, 8)}...] Near deadline but moonshot window active - skipping late strategy, will check moonshot below`);
          } else {
            logWarn(wallet.address, '⏳', `[${marketAddress.substring(0, 8)}...] Too close to deadline - skipping`);
          }
          return; // Exit late strategy block to allow independent moonshot strategy to run
        }

        // Determine odds range based on time-based windows or default MIN/MAX_ODDS
        let minOddsToUse = MIN_ODDS;
        let maxOddsToUse = MAX_ODDS;
        let windowDescription = `${MIN_ODDS}-${MAX_ODDS}%`;

        if (TIME_BASED_ODDS_ENABLED) {
          // Get current minute of the hour
          const currentMinute = new Date().getMinutes();

          // Check which window we're in
          if (currentMinute >= LATE_WINDOW_1_START && currentMinute <= LATE_WINDOW_1_END) {
            // In Window 1
            minOddsToUse = LATE_WINDOW_1_MIN_ODDS;
            maxOddsToUse = LATE_WINDOW_1_MAX_ODDS;
            windowDescription = `Window 1 (min ${currentMinute}, ${LATE_WINDOW_1_START}-${LATE_WINDOW_1_END}): ${minOddsToUse}-${maxOddsToUse}%`;
          } else if (currentMinute >= LATE_WINDOW_2_START && currentMinute <= LATE_WINDOW_2_END) {
            // In Window 2
            minOddsToUse = LATE_WINDOW_2_MIN_ODDS;
            maxOddsToUse = LATE_WINDOW_2_MAX_ODDS;
            windowDescription = `Window 2 (min ${currentMinute}, ${LATE_WINDOW_2_START}-${LATE_WINDOW_2_END}): ${minOddsToUse}-${maxOddsToUse}%`;
          } else {
            // Not in any configured window
            logInfo(wallet.address, '⏸️', `[${marketAddress.substring(0, 8)}...] Current minute ${currentMinute} not in any time-based window (W1: ${LATE_WINDOW_1_START}-${LATE_WINDOW_1_END}, W2: ${LATE_WINDOW_2_START}-${LATE_WINDOW_2_END}) - skipping`);
            return;
          }
        }

        // Only buy if one side is in configured odds range
        const maxPrice = Math.max(...prices);
        if (maxPrice < minOddsToUse || maxPrice > maxOddsToUse) {
          logInfo(wallet.address, '⏸️', `[${marketAddress.substring(0, 8)}...] No side in ${windowDescription} range (prices: [${prices.join(', ')}]) - skipping`);
          return;
        }

        // Determine which side is in odds range
        let outcomeToBuy = prices[0] >= minOddsToUse && prices[0] <= maxOddsToUse ? 0 : 1;

        // Calculate investment amount (with scale-in support)
        let investmentHuman = getBuyAmountForStrategy(lateStrategy);
        if (SCALE_IN_ENABLED) {
          // Scale the investment amount by the number of positions
          investmentHuman = investmentHuman / SCALE_IN_POSITIONS;
          logInfo(wallet.address, '📊', `[${marketAddress.substring(0, 8)}...] Scale-in enabled: Using $${investmentHuman} USDC (1/${SCALE_IN_POSITIONS} of full position)`);
        }

        const strategyDescription = TIME_BASED_ODDS_ENABLED ? windowDescription : `Last ${BUY_WINDOW_MINUTES}min strategy`;
        const scaleInLabel = SCALE_IN_ENABLED ? ` (scale-in step 1/${SCALE_IN_POSITIONS})` : '';
        logInfo(wallet.address, '🎯', `[${marketAddress.substring(0, 8)}...] ${strategyDescription}: Buying outcome ${outcomeToBuy} at ${prices[outcomeToBuy]}% with $${investmentHuman} USDC${scaleInLabel}`);

        // Continue to buy logic below with this outcome
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

        // After late window buy, check if we should place moonshot contrarian bet
        if (MOONSHOT_ENABLED && inMoonshotWindow) {
          // Moonshot is always the opposite side of what we just bought
          const moonshotOutcome = outcomeToBuy === 0 ? 1 : 0;

          // Check if we already have a moonshot position
          const moonshotHolding = getHolding(wallet.address, marketAddress, 'moonshot');
          if (moonshotHolding) {
            logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] Skipping late window moonshot - already have moonshot position`);
          } else {
            // Check late position odds and opposite side odds
            const moonshotOdds = prices[moonshotOutcome];
            const lateOdds = prices[outcomeToBuy];

            // First check if late position odds are in acceptable range
            if (lateOdds < MOONSHOT_MIN_LATE_ODDS) {
              logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] Late position too weak: ${lateOdds}% < ${MOONSHOT_MIN_LATE_ODDS}% minimum - skipping moonshot`);
            } else if (lateOdds > MOONSHOT_MAX_LATE_ODDS) {
              logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] Late position too strong: ${lateOdds}% > ${MOONSHOT_MAX_LATE_ODDS}% maximum - skipping moonshot (too extreme)`);
            } else if (moonshotOdds > MOONSHOT_MAX_ODDS) {
              logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] Skipping moonshot - opposite side at ${moonshotOdds}% (> ${MOONSHOT_MAX_ODDS}% threshold). Not a true moonshot.`);
            } else {
              // All conditions met - place moonshot bet
              const moonshotStrategy = 'moonshot';
              const moonshotInvestment = ethers.parseUnits(MOONSHOT_AMOUNT_USDC.toString(), decimals);

              logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] Moonshot hedge! Late position: outcome ${outcomeToBuy} @ ${lateOdds}% → Buying opposite outcome ${moonshotOutcome} @ ${moonshotOdds}% with $${MOONSHOT_AMOUNT_USDC} USDC`);

              // Check USDC balance for moonshot
              const usdcBalAfter = await retryRpcCall(async () => await usdc.balanceOf(wallet.address));
              if (usdcBalAfter >= moonshotInvestment) {
                await executeBuy(wallet, market, usdc, marketAddress, moonshotInvestment, moonshotOutcome, decimals, pid0, pid1, erc1155, moonshotStrategy);
              } else {
                logWarn(wallet.address, '⚠️', `Insufficient USDC balance for moonshot. Need ${MOONSHOT_AMOUNT_USDC}, have ${ethers.formatUnits(usdcBalAfter, decimals)}.`);
              }
            }
          }
        }

        } // End else block - only execute late buy if no existing position

        // Only return if we're not going to check moonshot
        if (!(MOONSHOT_ENABLED && inMoonshotWindow && lateHolding)) {
          return; // Exit if no moonshot or no late holding to hedge
        }
        // Otherwise continue to independent moonshot section below
      }

      // Independent Moonshot Strategy: ONLY triggers when there's an existing late window position
      // Always buys the OPPOSITE side as a hedge/contrarian bet
      // Moonshot ignores MIN_MARKET_AGE_MINUTES and nearDeadlineForBet - only cares about MOONSHOT_WINDOW_MINUTES
      // Works in last N minutes based on MOONSHOT_WINDOW_MINUTES parameter

      // Debug logging for moonshot decision
      logInfo(wallet.address, '🔍', `[${marketAddress.substring(0, 8)}...] Moonshot check: ENABLED=${MOONSHOT_ENABLED}, inWindow=${inMoonshotWindow}, window=${MOONSHOT_WINDOW_MINUTES}min`);

      if (MOONSHOT_ENABLED && inMoonshotWindow) {
        logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] ✅ MOONSHOT SECTION ENTERED - checking conditions...`);
        // Safety check: Don't buy in final N seconds to ensure transaction can complete
        if (marketInfo.deadline) {
          const deadlineMs = new Date(marketInfo.deadline).getTime();
          const nowMs = Date.now();
          const remainingMs = deadlineMs - nowMs;
          const remainingSec = Math.floor(remainingMs / 1000);

          if (remainingMs < MOONSHOT_FINAL_SECONDS_BUFFER * 1000) {
            logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] Moonshot window active but only ${remainingSec}s remaining - too close to deadline (buffer: ${MOONSHOT_FINAL_SECONDS_BUFFER}s)`);
            return;
          }
        }

        // Check if we already have a moonshot position
        const moonshotHolding = getHolding(wallet.address, marketAddress, 'moonshot');
        if (moonshotHolding) {
          logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] Already have moonshot position - skipping`);
          return;
        }

        // REQUIREMENT: Moonshot ONLY buys when there's an existing late window position
        // It always buys the OPPOSITE side as a hedge/contrarian bet
        const lateHolding = getHolding(wallet.address, marketAddress, 'default');

        if (!lateHolding) {
          // No late window position - skip moonshot
          logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] No late window position found - moonshot requires existing position to hedge against`);
          return;
        }

        // We have a late window position - buy the opposite side if it qualifies
        const targetSide = lateHolding.outcomeIndex === 0 ? 1 : 0;
        const targetOdds = prices[targetSide];
        const latePositionOdds = prices[lateHolding.outcomeIndex];
        const moonshotReason = `opposite of late position (outcome ${lateHolding.outcomeIndex} @ ${latePositionOdds}%)`;

        logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] ✅ FOUND LATE POSITION: outcome ${lateHolding.outcomeIndex} @ ${latePositionOdds}%`);
        logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] Checking opposite side ${targetSide} @ ${targetOdds}%`);

        // First check if late position odds are in acceptable range
        if (latePositionOdds < MOONSHOT_MIN_LATE_ODDS) {
          logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] ❌ SKIP: Late position too weak: ${latePositionOdds}% < ${MOONSHOT_MIN_LATE_ODDS}% minimum`);
          return;
        }
        if (latePositionOdds > MOONSHOT_MAX_LATE_ODDS) {
          logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] ❌ SKIP: Late position too strong: ${latePositionOdds}% > ${MOONSHOT_MAX_LATE_ODDS}% maximum (too extreme)`);
          return;
        }

        logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] ✅ LATE ODDS IN RANGE: ${latePositionOdds}% is within [${MOONSHOT_MIN_LATE_ODDS}-${MOONSHOT_MAX_LATE_ODDS}%]`);

        // Late position is in range, now check if opposite side odds qualify for moonshot
        logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] Checking opposite odds: ${targetOdds}% vs ${MOONSHOT_MAX_ODDS}% max`);

        if (targetOdds <= MOONSHOT_MAX_ODDS) {
          logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] ✅ OPPOSITE ODDS QUALIFY: ${targetOdds}% <= ${MOONSHOT_MAX_ODDS}%`);
          const moonshotStrategy = 'moonshot';
          const investmentHuman = getBuyAmountForStrategy(moonshotStrategy);
          const moonshotInvestment = ethers.parseUnits(investmentHuman.toString(), decimals);

          logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] Moonshot hedge! Late position: outcome ${lateHolding.outcomeIndex} @ ${latePositionOdds}% → Buying opposite outcome ${targetSide} @ ${targetOdds}% with $${investmentHuman} USDC`);

          // Check USDC balance for moonshot
          const usdcBal = await retryRpcCall(async () => await usdc.balanceOf(wallet.address));
          if (usdcBal >= moonshotInvestment) {
            await executeBuy(wallet, market, usdc, marketAddress, moonshotInvestment, targetSide, decimals, pid0, pid1, erc1155, moonshotStrategy);
            return;
          } else {
            logWarn(wallet.address, '⚠️', `Insufficient USDC balance for moonshot. Need ${investmentHuman}, have ${ethers.formatUnits(usdcBal, decimals)}.`);
            return;
          }
        } else {
          logInfo(wallet.address, '🌙', `[${marketAddress.substring(0, 8)}...] ❌ SKIP: Opposite side ${targetSide} at ${targetOdds}% (> ${MOONSHOT_MAX_ODDS}% threshold) - waiting for odds to drop`);
          return;
        }
      } else {
        // Moonshot section not entered - log why
        if (!MOONSHOT_ENABLED) {
          logInfo(wallet.address, '🔍', `[${marketAddress.substring(0, 8)}...] Moonshot disabled (MOONSHOT_ENABLED=false)`);
        } else if (!inMoonshotWindow) {
          logInfo(wallet.address, '🔍', `[${marketAddress.substring(0, 8)}...] Not in moonshot window (need last ${MOONSHOT_WINDOW_MINUTES} minutes)`);
        }
      }

      // Not in last 13 minutes - check age/deadline restrictions
      if (tooNewForBet || nearDeadlineForBet) {
        // Market too new or too close to deadline - skip
        return;
      }

      // Regular buy logic is DISABLED - only using configured strategies (late window + moonshot)
      logInfo(wallet.address, '⏸️', `[${marketAddress.substring(0, 8)}...] Not in any strategy window - waiting`);
      return;
      } finally {
        // Always clear the buyingInProgress lock, even if buy failed or returned early
        buyingInProgress.delete(marketKey);
      }
    } catch (err) {
      logErr(wallet.address, '💥', `Error processing market: ${err && err.message ? err.message : err}`);
      if (err.stack) {
        console.error(`Stack trace for ${wallet.address}:`, err.stack);
      }
    }
  }

  // Flag to control polling
  let shouldStop = false;

  // Smart polling function that adjusts delay based on active/sleep state
  async function smartPoll() {
    if (shouldStop) return;

    await tick();

    // Determine next poll time based on bot state
    const holdings = getAllHoldings(wallet.address);
    const isActive = shouldBeActive(wallet);

    let nextPollDelay;
    let reason = '';

    if (!isActive && holdings.length === 0) {
      // Bot is sleeping and no positions to monitor - use long sleep until next window
      const nextWakeMs = getNextWakeTime();

      // Cap sleep at 5 minutes to avoid missing windows (safety measure)
      const maxSleepMs = 5 * 60 * 1000; // 5 minutes
      nextPollDelay = Math.min(nextWakeMs, maxSleepMs);

      const sleepMinutes = Math.floor(nextPollDelay / 60000);
      const sleepSeconds = Math.floor((nextPollDelay % 60000) / 1000);

      reason = `no positions, outside trading windows`;
      // Only log if sleep is significant (more than 30 seconds)
      if (nextPollDelay > 30000) {
        logInfo(wallet.address, '😴', `Smart wait mode: Sleeping for ${sleepMinutes}m ${sleepSeconds}s (${reason})`);
      }
    } else if (!isActive && holdings.length > 0) {
      // Bot is sleeping but has positions to monitor - poll more frequently
      nextPollDelay = 30000; // 30 seconds to monitor positions
      reason = `monitoring ${holdings.length} position(s) outside trading windows`;
    } else {
      // Bot is active - use normal polling interval
      nextPollDelay = POLL_INTERVAL_MS;
      reason = `active trading window (LATE=${LATE_STRATEGY_ENABLED}, MOONSHOT=${MOONSHOT_ENABLED}, QUICK_SCALP=${QUICK_SCALP_ENABLED})`;
    }

    // Schedule next poll
    if (!shouldStop) {
      setTimeout(smartPoll, nextPollDelay);
    }
  }

  // Start smart polling
  await smartPoll();

  // Return stop function
  return () => { shouldStop = true; };
}

async function main() {
  console.log('🚀 Starting Limitless bot on Base...');
  console.log(`📋 Configuration:`);
  console.log(`   RPC_URLS: ${RPC_URLS.length} endpoint(s) configured`);
  console.log(`   CHAIN_ID: ${CHAIN_ID}`);
  console.log(`   PRICE_ORACLE_IDS: [${PRICE_ORACLE_IDS.join(', ')}] (${PRICE_ORACLE_IDS.length} market(s))`);
  console.log(`   FREQUENCY: ${FREQUENCY}`);
  console.log(`   POLL_INTERVAL_MS: ${POLL_INTERVAL_MS}`);

  // Show buy amounts (universal and per-strategy)
  if (LATE_BUY_AMOUNT_USDC !== null) {
    console.log(`   BUY_AMOUNT_USDC: ${BUY_AMOUNT_USDC} (default)`);
    console.log(`   LATE_BUY_AMOUNT_USDC: ${LATE_BUY_AMOUNT_USDC} (overrides default for late strategy)`);
  } else {
    console.log(`   BUY_AMOUNT_USDC: ${BUY_AMOUNT_USDC} (all strategies)`);
  }

  console.log(`   AUTO_PROFIT_SELL_ENABLED: ${AUTO_PROFIT_SELL_ENABLED}`);
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
  console.log(`   🎯 Late Trading: Minutes ${60 - BUY_WINDOW_MINUTES}-60 (last minute strategy)`);
  if (MOONSHOT_ENABLED) {
    console.log(`   🌙 Moonshot: Last ${MOONSHOT_WINDOW_MINUTES} minutes ($${MOONSHOT_AMOUNT_USDC} contrarian bet on opposite side)`);
    console.log(`      - Late position range: ${MOONSHOT_MIN_LATE_ODDS}-${MOONSHOT_MAX_LATE_ODDS}% (triggers moonshot)`);
    console.log(`      - Opposite side max: ${MOONSHOT_MAX_ODDS}% (moonshot entry threshold)`);
  }

  // Calculate sleep periods
  const sleepPeriods = [];
  if (AUTO_REDEEM_ENABLED && REDEEM_WINDOW_END < (60 - BUY_WINDOW_MINUTES)) {
    sleepPeriods.push(`${REDEEM_WINDOW_END + 1}-${60 - BUY_WINDOW_MINUTES - 1}`);
  }
  if (sleepPeriods.length > 0) {
    console.log(`   💤 Sleep Mode: Minutes ${sleepPeriods.join(', ')} (saves RPC calls)`);
  }

  // Try each RPC URL until one works
  console.log(`\n🔌 Connecting to RPC...`);
  console.log(`   Available RPCs: ${RPC_URLS.length}`);

  let provider = null;
  let workingRpcUrl = null;

  for (let i = 0; i < RPC_URLS.length; i++) {
    const rpcUrl = RPC_URLS[i];
    console.log(`   [${i + 1}/${RPC_URLS.length}] Trying: ${rpcUrl.substring(0, 50)}...`);

    try {
      const testProvider = new ethers.JsonRpcProvider(rpcUrl);
      const net = await testProvider.getNetwork();

      if (Number(net.chainId) !== CHAIN_ID) {
        console.log(`   ❌ Wrong network (chainId=${net.chainId}, expected ${CHAIN_ID})`);
        continue;
      }

      // Success!
      provider = testProvider;
      workingRpcUrl = rpcUrl;
      logInfo('GLOBAL', '✅', `Connected to chainId=${net.chainId} (${net.name || 'unknown'})`);
      console.log(`   🎯 Using RPC [${i + 1}]: ${rpcUrl.substring(0, 50)}...`);
      break;
    } catch (e) {
      console.log(`   ❌ Failed: ${e.message}`);
      if (i === RPC_URLS.length - 1) {
        logErr('GLOBAL', '💥', 'All RPC URLs failed. Please check your RPC_URL configuration.', e && e.message ? e.message : e);
        process.exit(1);
      }
    }
  }

  if (!provider) {
    logErr('GLOBAL', '💥', 'Failed to connect to any RPC URL');
    process.exit(1);
  }

  // Store backup RPCs for runtime fallback
  const backupRpcUrls = RPC_URLS.filter(url => url !== workingRpcUrl);

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

  const stopFunctions = [];
  for (const w of wallets) {
    const stopFn = await runForWallet(w, provider);
    stopFunctions.push(stopFn);
  }

  // Start S3 uploads if enabled
  startS3Upload();

  process.on('SIGINT', () => {
    console.log('👋 Shutting down...');
    stopFunctions.forEach(fn => fn());
    stopS3Upload();
    // Give a moment for final S3 upload
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  });
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
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

// Market frequency: 'daily' or 'weekly'
const FREQUENCY = process.env.LONG_TERM_FREQUENCY || 'daily';

// API settings
const API_BASE = 'https://api.limitless.exchange';
const CRYPTO_CATEGORY_ID = 2;

const POLL_INTERVAL_MS = parseInt(process.env.LONG_TERM_POLL_INTERVAL_MS || '60000', 10); // 1 min for long-term
const BUY_AMOUNT_USDC = process.env.LONG_TERM_BUY_AMOUNT_USDC ? Number(process.env.LONG_TERM_BUY_AMOUNT_USDC) : 10;
const TARGET_PROFIT_PCT = process.env.LONG_TERM_TARGET_PROFIT_PCT ? Number(process.env.LONG_TERM_TARGET_PROFIT_PCT) : 15;
const STOP_LOSS_PCT = process.env.LONG_TERM_STOP_LOSS_PCT ? Number(process.env.LONG_TERM_STOP_LOSS_PCT) : -10;
const SLIPPAGE_BPS = process.env.SLIPPAGE_BPS ? Number(process.env.SLIPPAGE_BPS) : 150;
const GAS_PRICE_GWEI = process.env.GAS_PRICE_GWEI ? String(process.env.GAS_PRICE_GWEI) : '0.005';
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || '1', 10);

// Hybrid Strategy: Time-based phases with different exit rules
const PHASE_CONFIG = {
  daily: {
    periodMs: 24 * 60 * 60 * 1000,
    earlyPhaseHours: 18,        // First 18 hours: let it run
    midPhaseHours: 4,           // Next 4 hours: tighten stops
    finalPhaseHours: 2,         // Last 2 hours: enable hard stop loss
    earlyTrailingPct: 8,        // 8% trailing in early phase
    midTrailingPct: 5,          // 5% trailing in mid phase
    finalTrailingPct: 3         // 3% trailing in final phase
  },
  weekly: {
    periodMs: 7 * 24 * 60 * 60 * 1000,
    earlyPhaseHours: 132,       // First 5.5 days: let it run
    midPhaseHours: 24,          // Next 1 day: tighten stops
    finalPhaseHours: 12,        // Last 12 hours: enable hard stop loss
    earlyTrailingPct: 10,       // 10% trailing in early phase
    midTrailingPct: 7,          // 7% trailing in mid phase
    finalTrailingPct: 5         // 5% trailing in final phase
  }
};

const config = PHASE_CONFIG[FREQUENCY] || PHASE_CONFIG.daily;

const PRIVATE_KEYS = (process.env.PRIVATE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const STATE_FILE = process.env.LONG_TERM_STATE_FILE || path.join('data', 'long-term-state.json');
const TRADES_LOG_FILE = process.env.LONG_TERM_TRADES_LOG_FILE || path.join('data', 'long-term-trades.log');

// ========= State Management =========
const userState = new Map();

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
  saveState();
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
  saveState();
}

function saveState() {
  const stateObj = {};
  for (const [addr, walletMap] of userState.entries()) {
    stateObj[addr] = {};
    for (const [market, state] of walletMap.entries()) {
      stateObj[addr][market] = state;
    }
  }

  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(stateObj, null, 2));
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      for (const [addr, walletObj] of Object.entries(data)) {
        const walletMap = new Map();
        for (const [market, state] of Object.entries(walletObj)) {
          walletMap.set(market, state);
        }
        userState.set(addr, walletMap);
      }
      console.log('✅ State loaded');
    }
  } catch (e) {
    console.error('Failed to load state:', e.message);
  }
}

// ========= Logging =========
function log(addr, emoji, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${emoji} ${addr.slice(0, 8)}: ${msg}`);
}

function logTrade(addr, market, title, outcome, action, amount) {
  const ts = new Date().toISOString();
  const line = `${ts} | ${addr.slice(0, 8)} | ${action} | ${title} | Outcome ${outcome} | $${amount}\n`;

  try {
    const dir = path.dirname(TRADES_LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(TRADES_LOG_FILE, line);
  } catch (e) {
    console.error('Failed to log trade:', e.message);
  }
}

// ========= Market Fetching =========
async function fetchCryptoMarkets() {
  try {
    const tag = FREQUENCY === 'daily' ? 'Daily' : 'Weekly';
    const response = await axios.get(`${API_BASE}/markets/active/${CRYPTO_CATEGORY_ID}`, {
      params: { limit: 100 }
    });

    if (!response.data || !response.data.data) return [];

    // Filter by tag (Daily or Weekly)
    const markets = response.data.data.filter(m => {
      return m.tags && m.tags.includes(tag) && m.status === 'FUNDED' && !m.expired;
    });

    console.log(`📡 Found ${markets.length} active ${FREQUENCY} crypto markets`);
    return markets;

  } catch (e) {
    console.error(`Failed to fetch markets: ${e.message}`);
    return [];
  }
}

// ========= Phase Detection =========
function getMarketPhase(expirationTimestamp) {
  const now = Date.now();
  const timeRemaining = expirationTimestamp - now;
  const hoursRemaining = timeRemaining / (60 * 60 * 1000);

  if (hoursRemaining < 0) return 'expired';
  if (hoursRemaining <= config.finalPhaseHours) return 'final';
  if (hoursRemaining <= (config.finalPhaseHours + config.midPhaseHours)) return 'mid';
  return 'early';
}

// ========= Contract Utilities =========
async function txOverrides(provider, gasLimit) {
  const feeData = await provider.getFeeData();
  return {
    gasLimit,
    maxFeePerGas: feeData.maxFeePerGas || ethers.parseUnits(GAS_PRICE_GWEI, 'gwei'),
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || ethers.parseUnits('0.001', 'gwei')
  };
}

async function safeBalanceOf(erc1155, addr, tokenId) {
  for (let i = 0; i < 3; i++) {
    try {
      return await erc1155.balanceOf(addr, tokenId);
    } catch (e) {
      if (i === 2) return 0n;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return 0n;
}

// ========= Trading Logic =========
async function processMarket(wallet, provider, marketData) {
  try {
    const marketAddress = ethers.getAddress(marketData.address);
    const title = marketData.title || 'Unknown';

    // Check if already completed
    if (isMarketCompleted(wallet.address, marketAddress)) {
      return;
    }

    const expirationTimestamp = marketData.expirationTimestamp;
    const phase = getMarketPhase(expirationTimestamp);

    if (phase === 'expired') {
      log(wallet.address, '⏰', `${title} - Market expired`);
      return;
    }

    const collateralTokenAddress = ethers.getAddress(marketData.collateralToken.address);
    const market = new ethers.Contract(marketAddress, MARKET_ABI, wallet);
    const usdc = new ethers.Contract(collateralTokenAddress, ERC20_ABI, wallet);
    const decimals = Number(marketData.collateralToken.decimals);

    // Check if we have a position
    const holding = getHolding(wallet.address, marketAddress);
    const positionIds = marketData.positionIds;

    if (!positionIds || positionIds.length < 2) {
      log(wallet.address, '⚠️', `${title} - Invalid position IDs`);
      return;
    }

    const pid0 = BigInt(positionIds[0]);
    const pid1 = BigInt(positionIds[1]);

    const conditionalTokens = await market.conditionalTokens();
    const erc1155 = new ethers.Contract(conditionalTokens, ERC1155_ABI, wallet);

    const bal0 = await safeBalanceOf(erc1155, wallet.address, pid0);
    const bal1 = await safeBalanceOf(erc1155, wallet.address, pid1);

    const hasPosition = bal0 > 0n || bal1 > 0n;

    if (hasPosition) {
      // Manage existing position
      const outcomeIndex = bal0 > 0n ? 0 : 1;
      const tokenId = bal0 > 0n ? pid0 : pid1;
      const tokenBalance = bal0 > 0n ? bal0 : bal1;

      let currentHolding = holding || {
        outcomeIndex,
        tokenId,
        cost: ethers.parseUnits(BUY_AMOUNT_USDC.toString(), decimals)
      };

      const cost = currentHolding.cost;
      const tokensNeededForCost = await market.calcSellAmount(cost, outcomeIndex);

      if (tokensNeededForCost === 0n) return;

      const positionValue = (tokenBalance * cost) / tokensNeededForCost;
      const pnlAbs = positionValue - cost;
      const pnlPct = cost > 0n ? Number((pnlAbs * 10000n) / cost) / 100 : 0;

      // Track peak PnL
      if (!currentHolding.peakPnLPct || pnlPct > currentHolding.peakPnLPct) {
        currentHolding.peakPnLPct = pnlPct;
        setHolding(wallet.address, marketAddress, currentHolding);
      }
      const peakPnLPct = currentHolding.peakPnLPct || pnlPct;

      const hoursRemaining = (expirationTimestamp - Date.now()) / (60 * 60 * 1000);

      log(wallet.address, pnlAbs >= 0n ? '📈' : '📉',
        `${title} | Phase: ${phase} | PnL: ${pnlPct.toFixed(1)}% | Peak: ${peakPnLPct.toFixed(1)}% | Hours left: ${hoursRemaining.toFixed(1)}`);

      // Determine exit conditions based on phase
      let shouldSell = false;
      let exitReason = '';

      // Get phase-specific trailing stop distance
      let trailingStopDistance;
      if (phase === 'early') trailingStopDistance = config.earlyTrailingPct;
      else if (phase === 'mid') trailingStopDistance = config.midTrailingPct;
      else trailingStopDistance = config.finalTrailingPct;

      // Trailing stop: Once we hit profit target
      if (peakPnLPct >= TARGET_PROFIT_PCT) {
        const trailingStop = peakPnLPct - trailingStopDistance;
        if (pnlPct <= trailingStop) {
          shouldSell = true;
          exitReason = `TRAILING_STOP (Peak: ${peakPnLPct.toFixed(1)}%, Drop: ${trailingStopDistance}%)`;
        }
      }

      // Hard stop loss: Only in final phase
      if (!shouldSell && phase === 'final' && pnlPct <= STOP_LOSS_PCT) {
        shouldSell = true;
        exitReason = `STOP_LOSS (Final ${config.finalPhaseHours}h)`;
      }

      if (shouldSell) {
        log(wallet.address, '🚪', `Selling: ${exitReason}`);

        // Execute sell
        const returnAmountForSell = positionValue - (positionValue / 100n);
        const tx = await market.sell(returnAmountForSell, outcomeIndex, tokenBalance, await txOverrides(provider, 300000n));

        log(wallet.address, '🧾', `Sell tx: ${tx.hash.slice(0, 10)}...`);
        await tx.wait(CONFIRMATIONS);

        const pnlAmount = Number(ethers.formatUnits(pnlAbs, decimals));
        log(wallet.address, '✅', `SOLD at ${pnlPct.toFixed(1)}% | P&L: $${pnlAmount.toFixed(2)}`);

        logTrade(wallet.address, marketAddress, title, outcomeIndex, 'SELL', Number(ethers.formatUnits(cost, decimals)));

        setHolding(wallet.address, marketAddress, null);
        markMarketCompleted(wallet.address, marketAddress);
      } else {
        log(wallet.address, '⏳', `Holding - ${phase} phase`);
      }

    } else {
      // No position - consider entry
      // For now, skip automatic entries - focus on managing existing positions
      // You can add entry logic here later based on your strategy
    }

  } catch (err) {
    console.error(`Error processing market ${marketData.title}:`, err.message);
  }
}

// ========= Main =========
async function main() {
  console.log('🚀 Starting Long-Term Crypto Bot');
  console.log(`📅 Frequency: ${FREQUENCY.toUpperCase()}`);
  console.log(`💰 Position size: $${BUY_AMOUNT_USDC}`);
  console.log(`📈 Target: ${TARGET_PROFIT_PCT}% | Stop loss: ${STOP_LOSS_PCT}% (final phase only)`);
  console.log(`🎯 Trailing stops: Early ${config.earlyTrailingPct}% → Mid ${config.midTrailingPct}% → Final ${config.finalTrailingPct}%`);
  console.log('');

  loadState();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallets = PRIVATE_KEYS.map(pk => new ethers.Wallet(pk, provider));

  if (wallets.length === 0) {
    console.error('❌ No private keys configured');
    process.exit(1);
  }

  async function tick() {
    console.log(`\n🔄 [${new Date().toISOString()}] Checking ${FREQUENCY} crypto markets...\n`);

    const markets = await fetchCryptoMarkets();

    if (markets.length === 0) {
      console.log('⏸️  No active markets found');
      return;
    }

    for (const wallet of wallets) {
      for (const marketData of markets) {
        await processMarket(wallet, provider, marketData);
      }
    }
  }

  await tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

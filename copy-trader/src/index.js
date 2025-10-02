require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Load ABIs from parent directory
const MARKET_ABI = require('../../src/abis/Market.json');
const ERC20_ABI = require('../../src/abis/ERC20.json');
const ERC1155_ABI = require('../../src/abis/ERC1155.json');

// ========= Configuration =========
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '8453', 10);
const TARGET_WALLET = process.env.TARGET_WALLET?.toLowerCase();
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Copy trading settings
const COPY_RATIO = process.env.COPY_RATIO ? Number(process.env.COPY_RATIO) : 1.0;
const FIXED_POSITION_SIZE_USDC = process.env.FIXED_POSITION_SIZE_USDC ? Number(process.env.FIXED_POSITION_SIZE_USDC) : null;
const MIN_POSITION_SIZE_USDC = process.env.MIN_POSITION_SIZE_USDC ? Number(process.env.MIN_POSITION_SIZE_USDC) : 1;
const MAX_POSITION_SIZE_USDC = process.env.MAX_POSITION_SIZE_USDC ? Number(process.env.MAX_POSITION_SIZE_USDC) : 100;

// Execution settings
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS || '150', 10);
const MAX_GAS_ETH = process.env.MAX_GAS_ETH ? Number(process.env.MAX_GAS_ETH) : 0.015;
const MAX_GAS_WEI = ethers.parseEther(String(MAX_GAS_ETH));
const GAS_PRICE_GWEI = process.env.GAS_PRICE_GWEI ? String(process.env.GAS_PRICE_GWEI) : '0.005';
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || '1', 10);

// Risk management
const AUTO_CLOSE_ON_TARGET_EXIT = process.env.AUTO_CLOSE_ON_TARGET_EXIT !== 'false';
const STOP_LOSS_PCT = process.env.STOP_LOSS_PCT ? Number(process.env.STOP_LOSS_PCT) : 0;
const TAKE_PROFIT_PCT = process.env.TAKE_PROFIT_PCT ? Number(process.env.TAKE_PROFIT_PCT) : 0;
const MAX_CONCURRENT_POSITIONS = process.env.MAX_CONCURRENT_POSITIONS ? Number(process.env.MAX_CONCURRENT_POSITIONS) : 10;

// Filtering
const ALLOWED_CATEGORIES = (process.env.ALLOWED_CATEGORIES || '').split(',').map(s => s.trim()).filter(Boolean);
const IGNORED_CATEGORIES = (process.env.IGNORED_CATEGORIES || '').split(',').map(s => s.trim()).filter(Boolean);
const MIN_MARKET_LIQUIDITY = process.env.MIN_MARKET_LIQUIDITY ? Number(process.env.MIN_MARKET_LIQUIDITY) : 1000;

// Logging
const VERBOSE_LOGGING = process.env.VERBOSE_LOGGING === 'true';
const STATE_FILE = process.env.STATE_FILE || path.join('data', 'copy-state.json');
const TRADES_LOG_FILE = process.env.TRADES_LOG_FILE || path.join('data', 'copy-trades.log');
const TRADES_CSV_FILE = process.env.TRADES_CSV_FILE || path.join('data', 'copy-trades.csv');

// Simulation mode
const SIMULATION_MODE = process.env.SIMULATION_MODE === 'true';
const SIMULATION_BALANCE_USDC = process.env.SIMULATION_BALANCE_USDC ? Number(process.env.SIMULATION_BALANCE_USDC) : 1000;

// Validation
if (!RPC_URL) {
  console.error('❌ RPC_URL is required');
  process.exit(1);
}
if (!TARGET_WALLET || !ethers.isAddress(TARGET_WALLET)) {
  console.error('❌ Valid TARGET_WALLET address is required');
  process.exit(1);
}
if (!SIMULATION_MODE && !PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY is required (unless in SIMULATION_MODE)');
  process.exit(1);
}

// ========= State Management =========
const copiedPositions = new Map(); // key: marketAddress-outcomeIndex, value: position details
const targetPositionsSnapshot = new Map(); // Track target's positions
let simulationBalance = SIMULATION_BALANCE_USDC;

function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);

    if (data.copiedPositions) {
      for (const [key, value] of Object.entries(data.copiedPositions)) {
        copiedPositions.set(key, value);
      }
    }
    if (data.targetPositionsSnapshot) {
      for (const [key, value] of Object.entries(data.targetPositionsSnapshot)) {
        targetPositionsSnapshot.set(key, value);
      }
    }
    if (data.simulationBalance !== undefined) {
      simulationBalance = data.simulationBalance;
    }

    console.log(`📂 Loaded state: ${copiedPositions.size} copied positions`);
  } catch (e) {
    console.warn('⚠️ Load state failed:', e.message);
  }
}

function saveState() {
  try {
    ensureDirSync(path.dirname(STATE_FILE));
    const data = {
      copiedPositions: Object.fromEntries(copiedPositions),
      targetPositionsSnapshot: Object.fromEntries(targetPositionsSnapshot),
      simulationBalance,
      lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('⚠️ Save state failed:', e.message);
  }
}

// ========= Logging =========
function log(emoji, msg) {
  const timestamp = new Date().toISOString();
  console.log(`${emoji} [${timestamp}] ${msg}`);
}

function logTrade(action, marketTitle, outcome, amount, details = {}) {
  const timestamp = new Date().toISOString();
  const logLine = `${timestamp} | ${action} | ${marketTitle} | Outcome: ${outcome} | Amount: $${amount} | ${JSON.stringify(details)}\n`;

  try {
    ensureDirSync(path.dirname(TRADES_LOG_FILE));
    fs.appendFileSync(TRADES_LOG_FILE, logLine);
  } catch (e) {
    console.warn('⚠️ Failed to write trade log:', e.message);
  }
}

// ========= API Functions =========
async function fetchTargetPositions() {
  try {
    const url = `https://api.limitless.exchange/portfolio/${TARGET_WALLET}/positions`;
    const response = await axios.get(url, { timeout: 15000 });

    if (VERBOSE_LOGGING) {
      log('📊', `Fetched ${response.data?.length || 0} positions from target wallet`);
    }

    return response.data || [];
  } catch (e) {
    console.error('❌ Failed to fetch target positions:', e.message);
    return [];
  }
}

async function fetchMarketDetails(marketAddress) {
  try {
    const url = `https://api.limitless.exchange/markets/${marketAddress}`;
    const response = await axios.get(url, { timeout: 10000 });
    return response.data;
  } catch (e) {
    console.error(`❌ Failed to fetch market ${marketAddress}:`, e.message);
    return null;
  }
}

// ========= Contract Functions =========
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

async function ensureUsdcApproval(wallet, usdc, marketAddress, amount) {
  try {
    const current = await usdc.allowance(wallet.address, marketAddress);
    if (current >= amount) return true;

    log('🔓', `Approving USDC for market ${marketAddress.slice(0, 8)}...`);

    // Reset to 0 if needed
    if (current > 0n) {
      const tx0 = await usdc.approve(marketAddress, 0n, await txOverrides(wallet.provider, 100000n));
      await tx0.wait(CONFIRMATIONS);
    }

    const tx = await usdc.approve(marketAddress, amount, await txOverrides(wallet.provider, 100000n));
    await tx.wait(CONFIRMATIONS);

    log('✅', 'USDC approval completed');
    return true;
  } catch (e) {
    console.error('❌ USDC approval failed:', e.message);
    return false;
  }
}

async function ensureErc1155Approval(wallet, erc1155, operator) {
  try {
    const approved = await erc1155.isApprovedForAll(wallet.address, operator);
    if (approved) return true;

    log('🔓', `Approving ERC1155 for operator ${operator.slice(0, 8)}...`);
    const tx = await erc1155.setApprovalForAll(operator, true, await txOverrides(wallet.provider, 100000n));
    await tx.wait(CONFIRMATIONS);
    log('✅', 'ERC1155 approval completed');
    return true;
  } catch (e) {
    console.error('❌ ERC1155 approval failed:', e.message);
    return false;
  }
}

// ========= Copy Trading Logic =========
function calculateCopyAmount(targetAmount) {
  let amount;

  if (FIXED_POSITION_SIZE_USDC) {
    amount = FIXED_POSITION_SIZE_USDC;
  } else {
    amount = targetAmount * COPY_RATIO;
  }

  // Apply limits
  if (amount < MIN_POSITION_SIZE_USDC) return 0;
  if (amount > MAX_POSITION_SIZE_USDC) amount = MAX_POSITION_SIZE_USDC;

  return amount;
}

function shouldCopyPosition(position, marketDetails) {
  // Check category filters
  if (ALLOWED_CATEGORIES.length > 0) {
    const category = marketDetails?.category?.toLowerCase();
    if (!category || !ALLOWED_CATEGORIES.includes(category)) {
      log('⏭️', `Skipping - category "${category}" not in allowed list`);
      return false;
    }
  }

  if (IGNORED_CATEGORIES.length > 0) {
    const category = marketDetails?.category?.toLowerCase();
    if (category && IGNORED_CATEGORIES.includes(category)) {
      log('⏭️', `Skipping - category "${category}" is ignored`);
      return false;
    }
  }

  // Check liquidity
  const liquidity = marketDetails?.liquidityUSD || marketDetails?.liquidity || 0;
  if (liquidity < MIN_MARKET_LIQUIDITY) {
    log('⏭️', `Skipping - liquidity $${liquidity} < minimum $${MIN_MARKET_LIQUIDITY}`);
    return false;
  }

  return true;
}

async function copyPosition(position, wallet, provider) {
  const marketAddress = position.market.address.toLowerCase();
  const outcomeIndex = position.outcomeIndex;
  const positionKey = `${marketAddress}-${outcomeIndex}`;

  // Check if already copied
  if (copiedPositions.has(positionKey)) {
    return;
  }

  // Check max concurrent positions
  if (copiedPositions.size >= MAX_CONCURRENT_POSITIONS) {
    log('🚫', `Max concurrent positions (${MAX_CONCURRENT_POSITIONS}) reached`);
    return;
  }

  log('🎯', `New target position detected: ${position.market.title} - Outcome ${outcomeIndex}`);

  // Fetch market details
  const marketDetails = await fetchMarketDetails(marketAddress);
  if (!marketDetails) {
    log('❌', 'Failed to fetch market details');
    return;
  }

  // Check if should copy
  if (!shouldCopyPosition(position, marketDetails)) {
    return;
  }

  // Calculate copy amount
  const targetAmount = Number(position.collateralAmount || position.amount || 0);
  const copyAmount = calculateCopyAmount(targetAmount);

  if (copyAmount === 0) {
    log('⏭️', `Skipping - amount $${targetAmount} below minimum`);
    return;
  }

  log('🔄', `Copying position: $${copyAmount} (target: $${targetAmount}, ratio: ${COPY_RATIO})`);

  if (SIMULATION_MODE) {
    // Simulation mode
    if (simulationBalance < copyAmount) {
      log('⚠️', `[SIM] Insufficient balance: ${simulationBalance.toFixed(2)}`);
      return;
    }

    simulationBalance -= copyAmount;
    log('✅', `[SIM] Copied position | Balance: ${simulationBalance.toFixed(2)}`);

    copiedPositions.set(positionKey, {
      marketAddress,
      outcomeIndex,
      amount: copyAmount,
      entryTime: Date.now(),
      entryPrice: marketDetails.prices?.[outcomeIndex] || 0,
      marketTitle: position.market.title,
      targetAmount
    });

    logTrade('COPY_BUY', position.market.title, outcomeIndex, copyAmount, {
      targetAmount,
      simulation: true
    });

  } else {
    // Real mode - execute trade
    try {
      const collateralTokenAddress = marketDetails.collateralToken.address;
      const market = new ethers.Contract(marketAddress, MARKET_ABI, wallet);
      const usdc = new ethers.Contract(collateralTokenAddress, ERC20_ABI, wallet);

      const decimals = Number(await usdc.decimals());
      const investment = ethers.parseUnits(copyAmount.toString(), decimals);

      // Check balance
      const usdcBal = await usdc.balanceOf(wallet.address);
      if (usdcBal < investment) {
        log('❌', 'Insufficient USDC balance');
        return;
      }

      // Approve USDC
      const approved = await ensureUsdcApproval(wallet, usdc, marketAddress, investment);
      if (!approved) return;

      // Calculate tokens
      const expectedTokens = await market.calcBuyAmount(investment, outcomeIndex);
      const minTokens = expectedTokens - (expectedTokens * BigInt(SLIPPAGE_BPS)) / 10000n;

      // Execute buy
      log('📝', `Executing buy transaction...`);
      const tx = await market.buy(investment, outcomeIndex, minTokens, await txOverrides(wallet.provider, 300000n));
      log('🧾', `Tx: ${tx.hash}`);
      await tx.wait(CONFIRMATIONS);
      log('✅', 'Position copied successfully');

      copiedPositions.set(positionKey, {
        marketAddress,
        outcomeIndex,
        amount: copyAmount,
        entryTime: Date.now(),
        entryPrice: marketDetails.prices?.[outcomeIndex] || 0,
        marketTitle: position.market.title,
        targetAmount,
        txHash: tx.hash
      });

      logTrade('COPY_BUY', position.market.title, outcomeIndex, copyAmount, {
        targetAmount,
        txHash: tx.hash
      });

    } catch (e) {
      console.error('❌ Failed to copy position:', e.message);
    }
  }

  saveState();
}

async function closePosition(positionKey, reason, wallet, provider) {
  const position = copiedPositions.get(positionKey);
  if (!position) return;

  log('🚪', `Closing position: ${position.marketTitle} - ${reason}`);

  if (SIMULATION_MODE) {
    // Simulate close with random P&L
    const variance = (Math.random() - 0.5) * 0.2; // -10% to +10%
    const proceeds = position.amount * (1 + variance);
    simulationBalance += proceeds;
    const pnl = proceeds - position.amount;
    const pnlPct = (pnl / position.amount * 100).toFixed(2);

    log('✅', `[SIM] Closed position | PnL: ${pnlPct}% | Balance: ${simulationBalance.toFixed(2)}`);

    logTrade('COPY_SELL', position.marketTitle, position.outcomeIndex, proceeds, {
      reason,
      pnl: pnlPct,
      simulation: true
    });

  } else {
    // Real mode - execute sell
    try {
      const marketDetails = await fetchMarketDetails(position.marketAddress);
      if (!marketDetails) {
        log('❌', 'Failed to fetch market details for close');
        return;
      }

      const market = new ethers.Contract(position.marketAddress, MARKET_ABI, wallet);
      const conditionalTokensAddress = await market.conditionalTokens();
      const erc1155 = new ethers.Contract(conditionalTokensAddress, ERC1155_ABI, wallet);

      const positionIds = marketDetails.positionIds || [];
      const tokenId = BigInt(positionIds[position.outcomeIndex]);
      const balance = await erc1155.balanceOf(wallet.address, tokenId);

      if (balance === 0n) {
        log('⚠️', 'No tokens to sell');
        copiedPositions.delete(positionKey);
        saveState();
        return;
      }

      // Approve ERC1155
      const approved = await ensureErc1155Approval(wallet, erc1155, position.marketAddress);
      if (!approved) return;

      // Sell all tokens
      const decimals = 6; // USDC
      const cost = ethers.parseUnits(position.amount.toString(), decimals);
      const tokensNeeded = await market.calcSellAmount(cost, position.outcomeIndex);
      const positionValue = (balance * cost) / tokensNeeded;
      const returnAmount = positionValue - (positionValue / 100n);

      log('📝', `Executing sell transaction...`);
      const tx = await market.sell(returnAmount, position.outcomeIndex, balance, await txOverrides(wallet.provider, 300000n));
      log('🧾', `Tx: ${tx.hash}`);
      await tx.wait(CONFIRMATIONS);
      log('✅', 'Position closed successfully');

      const pnlAbs = positionValue - cost;
      const pnlPct = cost > 0n ? Number((pnlAbs * 10000n) / cost) / 100 : 0;

      logTrade('COPY_SELL', position.marketTitle, position.outcomeIndex, Number(ethers.formatUnits(positionValue, decimals)), {
        reason,
        pnl: pnlPct.toFixed(2),
        txHash: tx.hash
      });

    } catch (e) {
      console.error('❌ Failed to close position:', e.message);
      return;
    }
  }

  copiedPositions.delete(positionKey);
  saveState();
}

// ========= Main Loop =========
async function monitorAndCopy(wallet, provider) {
  try {
    // Fetch target's current positions
    const targetPositions = await fetchTargetPositions();

    // Create map of current target positions
    const currentTargetPositions = new Map();
    for (const pos of targetPositions) {
      const key = `${pos.market.address.toLowerCase()}-${pos.outcomeIndex}`;
      currentTargetPositions.set(key, pos);
    }

    // Check for new positions to copy
    for (const [key, position] of currentTargetPositions.entries()) {
      if (!targetPositionsSnapshot.has(key)) {
        // New position detected
        await copyPosition(position, wallet, provider);
      }
    }

    // Check for closed positions (if auto-close enabled)
    if (AUTO_CLOSE_ON_TARGET_EXIT) {
      for (const [key, position] of targetPositionsSnapshot.entries()) {
        if (!currentTargetPositions.has(key)) {
          // Target closed this position
          if (copiedPositions.has(key)) {
            await closePosition(key, 'TARGET_EXIT', wallet, provider);
          }
        }
      }
    }

    // Update snapshot
    targetPositionsSnapshot.clear();
    for (const [key, pos] of currentTargetPositions.entries()) {
      targetPositionsSnapshot.set(key, pos);
    }

    // Check stop loss / take profit on our positions
    for (const [key, position] of copiedPositions.entries()) {
      const marketDetails = await fetchMarketDetails(position.marketAddress);
      if (!marketDetails) continue;

      const currentPrice = marketDetails.prices?.[position.outcomeIndex] || 0;
      const entryPrice = position.entryPrice || 50;
      const priceDiff = currentPrice - entryPrice;
      const pnlPct = (priceDiff / entryPrice) * 100;

      if (STOP_LOSS_PCT !== 0 && pnlPct <= STOP_LOSS_PCT) {
        await closePosition(key, `STOP_LOSS (${pnlPct.toFixed(1)}%)`, wallet, provider);
      } else if (TAKE_PROFIT_PCT !== 0 && pnlPct >= TAKE_PROFIT_PCT) {
        await closePosition(key, `TAKE_PROFIT (${pnlPct.toFixed(1)}%)`, wallet, provider);
      }
    }

  } catch (e) {
    console.error('❌ Monitor error:', e.message);
  }
}

// ========= Main =========
async function main() {
  console.log('🚀 Starting Limitless Copy Trader');
  console.log(SIMULATION_MODE ? '🎮 SIMULATION MODE - NO REAL TRADES' : '🎯 LIVE TRADING MODE');
  console.log(`👤 Target Wallet: ${TARGET_WALLET}`);
  console.log(`💰 Copy Settings: ${FIXED_POSITION_SIZE_USDC ? `Fixed $${FIXED_POSITION_SIZE_USDC}` : `Ratio ${COPY_RATIO}x`}`);
  console.log(`📊 Limits: Min $${MIN_POSITION_SIZE_USDC} | Max $${MAX_POSITION_SIZE_USDC}`);
  console.log(`🛡️ Risk: Stop Loss ${STOP_LOSS_PCT}% | Take Profit ${TAKE_PROFIT_PCT}%`);
  console.log(`🔄 Auto-close on target exit: ${AUTO_CLOSE_ON_TARGET_EXIT}`);
  console.log(`⏱️ Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log('');

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  let wallet;
  if (SIMULATION_MODE) {
    wallet = { address: '0xSimulation', provider };
    console.log(`💵 Starting balance: $${SIMULATION_BALANCE_USDC}`);
  } else {
    const key = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : '0x' + PRIVATE_KEY;
    wallet = new ethers.Wallet(key, provider);
    console.log(`🔑 Wallet: ${wallet.address}`);

    // Verify network
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== CHAIN_ID) {
      console.error(`❌ Wrong network: expected ${CHAIN_ID}, got ${net.chainId}`);
      process.exit(1);
    }
    console.log(`🌐 Connected to chainId=${net.chainId}`);
  }

  // Load state
  loadState();

  // Start monitoring
  log('👀', 'Starting to monitor target wallet...');

  const interval = setInterval(async () => {
    await monitorAndCopy(wallet, provider);
  }, POLL_INTERVAL_MS);

  // Initial check
  await monitorAndCopy(wallet, provider);

  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down...');
    clearInterval(interval);
    saveState();

    if (SIMULATION_MODE) {
      const pnl = simulationBalance - SIMULATION_BALANCE_USDC;
      const pnlPct = (pnl / SIMULATION_BALANCE_USDC * 100).toFixed(2);
      console.log(`\n💼 Final Balance: $${simulationBalance.toFixed(2)}`);
      console.log(`📊 PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pnlPct}%)`);
      console.log(`📈 Positions copied: ${copiedPositions.size}\n`);
    }

    process.exit(0);
  });
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});

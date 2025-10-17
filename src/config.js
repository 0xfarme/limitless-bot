import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

// ========= RPC Configuration =========
export const RPC_URLS = (process.env.RPC_URL || '').split(',').map(s => s.trim()).filter(Boolean);
export const CHAIN_ID = parseInt(process.env.CHAIN_ID || '8453', 10);

// ========= Market Selection =========
export const PRICE_ORACLE_IDS = (process.env.PRICE_ORACLE_ID || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);
export const FREQUENCY = (process.env.FREQUENCY || 'hourly').toLowerCase();

// ========= Wallet Configuration =========
export const PRIVATE_KEYS = (process.env.PRIVATE_KEYS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ========= Trading Parameters =========
export const BUY_AMOUNT_USDC = parseFloat(process.env.BUY_AMOUNT_USDC || '25');
export const TARGET_PROFIT_PCT = parseInt(process.env.TARGET_PROFIT_PCT || '20', 10);
export const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS || '100', 10);
export const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '10000', 10);

// ========= Gas Configuration =========
export const MAX_GAS_ETH = parseFloat(process.env.MAX_GAS_ETH || '0.015');
export const GAS_PRICE_GWEI = parseFloat(process.env.GAS_PRICE_GWEI || '0.005');
export const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || '1', 10);

// ========= Timing Settings =========
export const BUY_WINDOW_MINUTES = parseInt(process.env.BUY_WINDOW_MINUTES || '13', 10);
export const NO_BUY_FINAL_MINUTES = parseInt(process.env.NO_BUY_FINAL_MINUTES || '2', 10);
export const MIN_MARKET_AGE_MINUTES = parseInt(process.env.MIN_MARKET_AGE_MINUTES || '10', 10);

// ========= Odds Configuration =========
export const MIN_ODDS = parseInt(process.env.MIN_ODDS || '75', 10);
export const MAX_ODDS = parseInt(process.env.MAX_ODDS || '95', 10);

// ========= Stop Loss Settings =========
export const STOP_LOSS_ENABLED = (process.env.STOP_LOSS_ENABLED || 'true').toLowerCase() === 'true';
export const STOP_LOSS_PNL_PCT = parseInt(process.env.STOP_LOSS_PNL_PCT || '-50', 10);
export const STOP_LOSS_MINUTES = parseInt(process.env.STOP_LOSS_MINUTES || '2', 10);

// ========= Early Contrarian Strategy =========
export const EARLY_STRATEGY_ENABLED = (process.env.EARLY_STRATEGY_ENABLED || 'true').toLowerCase() === 'true';
export const EARLY_WINDOW_MINUTES = parseInt(process.env.EARLY_WINDOW_MINUTES || '30', 10);
export const EARLY_TRIGGER_ODDS = parseInt(process.env.EARLY_TRIGGER_ODDS || '70', 10);
export const EARLY_PROFIT_TARGET_PCT = parseInt(process.env.EARLY_PROFIT_TARGET_PCT || '20', 10);

// ========= Moonshot Strategy =========
export const MOONSHOT_ENABLED = (process.env.MOONSHOT_ENABLED || 'true').toLowerCase() === 'true';
export const MOONSHOT_WINDOW_MINUTES = parseInt(process.env.MOONSHOT_WINDOW_MINUTES || '2', 10);
export const MOONSHOT_MAX_ODDS = parseInt(process.env.MOONSHOT_MAX_ODDS || '10', 10);
export const MOONSHOT_AMOUNT_USDC = parseFloat(process.env.MOONSHOT_AMOUNT_USDC || '1');
export const MOONSHOT_PROFIT_TARGET_PCT = parseInt(process.env.MOONSHOT_PROFIT_TARGET_PCT || '100', 10);

// ========= Redemption Settings =========
export const AUTO_REDEEM_ENABLED = (process.env.AUTO_REDEEM_ENABLED || 'true').toLowerCase() === 'true';
export const REDEEM_WINDOW_START = parseInt(process.env.REDEEM_WINDOW_START || '6', 10);
export const REDEEM_WINDOW_END = parseInt(process.env.REDEEM_WINDOW_END || '10', 10);

// ========= Simulation Mode =========
export const SIMULATION_MODE = (process.env.SIMULATION_MODE || 'false').toLowerCase() === 'true';

// ========= File Paths =========
const dataDir = SIMULATION_MODE ? 'simulation' : 'data';
export const STATE_FILE = process.env.STATE_FILE || path.join(dataDir, 'state.json');
export const TRADES_LOG_FILE = process.env.TRADES_LOG_FILE || path.join(dataDir, 'trades.jsonl');
export const STATS_FILE = process.env.STATS_FILE || path.join(dataDir, 'stats.json');
export const REDEMPTION_LOG_FILE = process.env.REDEMPTION_LOG_FILE || path.join(dataDir, 'redemptions.jsonl');

// ========= Contract Addresses =========
export const ROUTER_ADDRESS = '0x7a85e5df79295714f36e1be47df12336d670564a';
export const LIMITLESS_API = 'https://api.limitless.exchange';

// Validation
if (PRIVATE_KEYS.length === 0) {
  throw new Error('No PRIVATE_KEYS configured in .env file');
}

if (RPC_URLS.length === 0) {
  throw new Error('No RPC_URL configured in .env file');
}

if (PRICE_ORACLE_IDS.length === 0) {
  throw new Error('No PRICE_ORACLE_ID configured in .env file');
}

import fs from 'fs';
import path from 'path';
import { STATE_FILE, TRADES_LOG_FILE, STATS_FILE, REDEMPTION_LOG_FILE } from '../config.js';

// Ensure directories exist
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ========= State Management =========
export function loadState() {
  ensureDir(STATE_FILE);
  if (!fs.existsSync(STATE_FILE)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveState(state) {
  ensureDir(STATE_FILE);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ========= Trade Logging =========
export function logTrade(tradeData) {
  ensureDir(TRADES_LOG_FILE);
  const line = JSON.stringify({ ...tradeData, timestamp: new Date().toISOString() });
  fs.appendFileSync(TRADES_LOG_FILE, line + '\n', 'utf8');
}

// ========= Redemption Logging =========
export function logRedemption(redemptionData) {
  ensureDir(REDEMPTION_LOG_FILE);
  const line = JSON.stringify({ ...redemptionData, timestamp: new Date().toISOString() });
  fs.appendFileSync(REDEMPTION_LOG_FILE, line + '\n', 'utf8');
}

// ========= Stats Management =========
export function loadStats() {
  ensureDir(STATS_FILE);
  if (!fs.existsSync(STATS_FILE)) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnL: 0,
      winRate: 0,
      avgPnL: 0
    };
  }
  try {
    const raw = fs.readFileSync(STATS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnL: 0,
      winRate: 0,
      avgPnL: 0
    };
  }
}

export function saveStats(stats) {
  ensureDir(STATS_FILE);
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf8');
}

export function updateStats(pnlUSDC) {
  const stats = loadStats();
  stats.totalTrades = (stats.totalTrades || 0) + 1;
  stats.totalPnL = (stats.totalPnL || 0) + pnlUSDC;

  if (pnlUSDC > 0) {
    stats.wins = (stats.wins || 0) + 1;
  } else {
    stats.losses = (stats.losses || 0) + 1;
  }

  stats.winRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades * 100) : 0;
  stats.avgPnL = stats.totalTrades > 0 ? (stats.totalPnL / stats.totalTrades) : 0;

  saveStats(stats);
  return stats;
}

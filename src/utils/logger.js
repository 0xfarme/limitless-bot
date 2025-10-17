import chalk from 'chalk';

const EMOJI_MAP = {
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
  success: '✅',
  trade: '💰',
  profit: '💎',
  loss: '📉'
};

export function log(walletAddress, emoji, message) {
  const shortAddr = walletAddress ? `[${walletAddress.substring(0, 8)}...]` : '';
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} ${emoji}  ${shortAddr} ${message}`);
}

export function logInfo(walletAddress, emoji, message) {
  log(walletAddress, emoji, message);
}

export function logWarn(walletAddress, emoji, message) {
  log(walletAddress, emoji, chalk.yellow(message));
}

export function logError(walletAddress, emoji, message) {
  log(walletAddress, emoji, chalk.red(message));
}

export function logSuccess(walletAddress, emoji, message) {
  log(walletAddress, emoji, chalk.green(message));
}

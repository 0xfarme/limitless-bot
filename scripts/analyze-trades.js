#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const TRADES_LOG = process.env.TRADES_LOG_FILE || path.join(__dirname, '../data/trades.jsonl');

function analyzeTrades() {
  if (!fs.existsSync(TRADES_LOG)) {
    console.log('❌ No trades log found at:', TRADES_LOG);
    console.log('💡 The bot will create this file after the first trade.');
    return;
  }

  const lines = fs.readFileSync(TRADES_LOG, 'utf8').trim().split('\n').filter(Boolean);

  if (lines.length === 0) {
    console.log('📭 No trades recorded yet.');
    return;
  }

  const trades = lines.map(line => JSON.parse(line));

  const buys = trades.filter(t => t.type === 'BUY');
  const redeems = trades.filter(t => t.type === 'REDEEM');
  const wins = redeems.filter(t => t.result === 'WON');
  const losses = redeems.filter(t => t.result === 'LOST');
  const sells = trades.filter(t => t.type === 'SELL_PROFIT' || t.type === 'SELL_STOP_LOSS');

  console.log('\n📊 ========= TRADE ANALYSIS =========\n');

  console.log('📈 Total Events:', trades.length);
  console.log('🛒 Buys:', buys.length);
  console.log('💰 Redemptions:', redeems.length);
  console.log('💸 Early Sells:', sells.length);

  console.log('\n🎯 Results:');
  console.log('  ✅ Wins:', wins.length);
  console.log('  ❌ Losses:', losses.length);

  if (redeems.length > 0) {
    const winRate = ((wins.length / redeems.length) * 100).toFixed(2);
    console.log('  📊 Win Rate:', winRate + '%');
  }

  console.log('\n💵 Profit & Loss:');

  const totalRedemptionPnL = redeems.reduce((sum, t) => sum + parseFloat(t.pnlUSDC || 0), 0);
  const totalSellPnL = sells.reduce((sum, t) => sum + parseFloat(t.pnlUSDC || 0), 0);
  const totalPnL = totalRedemptionPnL + totalSellPnL;

  const totalProfit = [...redeems, ...sells]
    .filter(t => parseFloat(t.pnlUSDC || 0) > 0)
    .reduce((sum, t) => sum + parseFloat(t.pnlUSDC), 0);

  const totalLoss = [...redeems, ...sells]
    .filter(t => parseFloat(t.pnlUSDC || 0) < 0)
    .reduce((sum, t) => sum + Math.abs(parseFloat(t.pnlUSDC)), 0);

  console.log('  💰 Total Profit: $' + totalProfit.toFixed(4) + ' USDC');
  console.log('  💸 Total Loss: $' + totalLoss.toFixed(4) + ' USDC');
  console.log('  📊 Net P&L: ' + (totalPnL >= 0 ? '+' : '') + '$' + totalPnL.toFixed(4) + ' USDC');

  // Strategy breakdown
  console.log('\n🎯 Strategy Performance:');
  const strategies = {};
  buys.forEach(buy => {
    const strat = buy.strategy || 'default';
    if (!strategies[strat]) {
      strategies[strat] = { buys: 0, wins: 0, losses: 0, pnl: 0 };
    }
    strategies[strat].buys++;
  });

  redeems.forEach(redeem => {
    // Find corresponding buy
    const buy = buys.find(b => b.marketAddress === redeem.marketAddress && b.timestamp < redeem.timestamp);
    const strat = buy?.strategy || 'default';

    if (strategies[strat]) {
      if (redeem.result === 'WON') strategies[strat].wins++;
      if (redeem.result === 'LOST') strategies[strat].losses++;
      strategies[strat].pnl += parseFloat(redeem.pnlUSDC || 0);
    }
  });

  Object.entries(strategies).forEach(([strat, stats]) => {
    const winRate = stats.wins + stats.losses > 0
      ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(2)
      : 'N/A';
    console.log(`  ${strat}:`);
    console.log(`    Buys: ${stats.buys} | Wins: ${stats.wins} | Losses: ${stats.losses}`);
    console.log(`    Win Rate: ${winRate}% | P&L: $${stats.pnl.toFixed(4)}`);
  });

  // Recent trades
  console.log('\n📜 Last 5 Redemptions:');
  const recentRedeems = redeems.slice(-5).reverse();
  recentRedeems.forEach((t, i) => {
    const emoji = t.result === 'WON' ? '🎉' : '😢';
    const pnl = parseFloat(t.pnlUSDC);
    const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(4);
    console.log(`  ${emoji} ${t.marketTitle?.substring(0, 40) || 'Unknown'}`);
    console.log(`     ${t.result} | PnL: $${pnlStr} (${t.pnlPercent}%) | ${new Date(t.timestamp).toLocaleString()}`);
  });

  console.log('\n=====================================\n');
}

try {
  analyzeTrades();
} catch (err) {
  console.error('❌ Error analyzing trades:', err.message);
  process.exit(1);
}

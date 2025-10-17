import axios from 'axios';
import { LIMITLESS_API, PRICE_ORACLE_IDS, FREQUENCY } from '../config.js';
import { logInfo, logWarn } from '../utils/logger.js';

export async function fetchActiveMarkets() {
  const markets = [];

  for (const oracleId of PRICE_ORACLE_IDS) {
    const url = `${LIMITLESS_API}/markets/prophet?priceOracleId=${oracleId}&frequency=${FREQUENCY}`;

    try {
      const resp = await axios.get(url, { timeout: 10000 });

      if (resp.data && Array.isArray(resp.data)) {
        for (const m of resp.data) {
          if (m.deadline && new Date(m.deadline) > new Date()) {
            markets.push({
              address: m.address,
              title: m.title,
              deadline: m.deadline,
              outcomesSupply: m.outcomesSupply,
              prices: m.prices,
              collateralToken: m.collateralToken,
              conditionId: m.conditionId,
              questionId: m.questionId,
              oracleId
            });
          }
        }
      }
    } catch (err) {
      logWarn(null, '⚠️', `Failed to fetch markets for oracle ${oracleId}: ${err.message}`);
    }
  }

  return markets;
}

export function getMarketAge(market) {
  // Market age based on when first liquidity was added (approximated by deadline - 1 hour)
  const deadline = new Date(market.deadline);
  const now = new Date();
  const marketStart = new Date(deadline.getTime() - 60 * 60 * 1000); // Assume market starts 1 hour before deadline
  const ageMs = now.getTime() - marketStart.getTime();
  return Math.floor(ageMs / 60000); // Minutes
}

export function getTimeToDeadline(market) {
  const deadline = new Date(market.deadline);
  const now = new Date();
  return deadline.getTime() - now.getTime(); // Milliseconds
}

export function isMarketActive(market) {
  return getTimeToDeadline(market) > 0;
}

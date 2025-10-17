import { ethers } from 'ethers';
import { GAS_PRICE_GWEI } from '../config.js';

export function parseUnitsPrec(value, decimals, precision = 4) {
  try {
    const str = typeof value === 'string' ? value : String(value);
    const rounded = parseFloat(str).toFixed(precision);
    return ethers.parseUnits(rounded, decimals);
  } catch {
    return ethers.parseUnits('0', decimals);
  }
}

export function fmtUnitsPrec(value, decimals, precision = 4) {
  const formatted = ethers.formatUnits(value, decimals);
  return parseFloat(formatted).toFixed(precision);
}

export async function txOverrides(provider, gasLimit) {
  const gasPriceWei = ethers.parseUnits(String(GAS_PRICE_GWEI), 'gwei');
  return {
    gasPrice: gasPriceWei,
    gasLimit
  };
}

export function ensureHexPrefix(key) {
  return key.startsWith('0x') ? key : `0x${key}`;
}

export async function getProvider(rpcUrls) {
  for (const url of rpcUrls) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      await provider.getBlockNumber();
      return provider;
    } catch (err) {
      console.warn(`RPC ${url} failed, trying next...`);
    }
  }
  throw new Error('All RPC providers failed');
}

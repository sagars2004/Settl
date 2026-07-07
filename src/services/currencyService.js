// ---------------------------------------------------------------------------
// Currency service — live FX conversion.
// ---------------------------------------------------------------------------
// Uses the Frankfurter API (ECB rates, no key required) by default. Falls back
// to 1:1 when the API is unreachable so logging never blocks on FX.
// ---------------------------------------------------------------------------

const rateCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const FX_API_BASE = process.env.FX_API_BASE || 'https://api.frankfurter.app';

/**
 * Convert an amount from one currency to another using a live rate.
 * @param {number} amount
 * @param {string} fromCurrency  ISO 4217 (e.g. "EUR")
 * @param {string} toCurrency    ISO 4217 (e.g. "USD")
 * @returns {Promise<{ amount: number, rate: number, from: string, to: string, converted: boolean }>}
 */
export async function convertCurrency(amount, fromCurrency, toCurrency) {
  const from = fromCurrency?.toUpperCase();
  const to = toCurrency?.toUpperCase();

  if (!from || !to || from === to) {
    return { amount, rate: 1, from, to, converted: false };
  }

  const rate = await getExchangeRate(from, to);
  return {
    amount: Number((amount * rate).toFixed(2)),
    rate,
    from,
    to,
    converted: rate !== 1 || from !== to,
  };
}

/**
 * Fetch (or return cached) exchange rate for a currency pair.
 * @param {string} from
 * @param {string} to
 * @returns {Promise<number>}
 */
export async function getExchangeRate(from, to) {
  const key = `${from}:${to}`;
  const cached = rateCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rate;
  }

  let rate = 1;
  try {
    const url = `${FX_API_BASE}/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      throw new Error(`FX API ${response.status}`);
    }
    const data = await response.json();
    rate = data.rates?.[to];
    if (typeof rate !== 'number') {
      throw new Error(`No rate for ${from}->${to}`);
    }
  } catch (error) {
    console.warn(`[currencyService] FX lookup failed (${from}->${to}):`, error.message);
    rate = 1;
  }

  rateCache.set(key, { rate, fetchedAt: Date.now() });
  return rate;
}

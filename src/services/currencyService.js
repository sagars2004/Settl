// ---------------------------------------------------------------------------
// Currency service — live FX conversion via the Real-Time Search (RTS) API.
// ---------------------------------------------------------------------------
// When an expense is logged in a non-base currency (e.g. "€120 for the
// Amsterdam dinner"), Settl fetches the live rate and converts to the group's
// base currency. Rates are cached briefly to avoid hammering the API within a
// single interactive session.
// ---------------------------------------------------------------------------

// Simple in-memory cache: `${from}:${to}` -> { rate, fetchedAt }.
const rateCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Convert an amount from one currency to another using a live rate.
 * @param {number} amount
 * @param {string} fromCurrency  ISO 4217 (e.g. "EUR")
 * @param {string} toCurrency    ISO 4217 (e.g. "USD")
 * @returns {Promise<{ amount: number, rate: number, from: string, to: string }>}
 */
export async function convertCurrency(amount, fromCurrency, toCurrency) {
  if (!fromCurrency || fromCurrency === toCurrency) {
    return { amount, rate: 1, from: fromCurrency, to: toCurrency };
  }
  const rate = await getExchangeRate(fromCurrency, toCurrency);
  return {
    amount: Number((amount * rate).toFixed(2)),
    rate,
    from: fromCurrency,
    to: toCurrency,
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

  // TODO: query the RTS API for a live "1 <from> in <to>" rate using RTS_API_KEY,
  // parse the numeric result, and handle failures gracefully.
  const rate = 1; // placeholder until RTS integration is wired

  rateCache.set(key, { rate, fetchedAt: Date.now() });
  return rate;
}

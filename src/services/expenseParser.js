// ---------------------------------------------------------------------------
// Expense parser — Slack AI natural-language understanding layer.
// ---------------------------------------------------------------------------
// Turns free-form text ("split the $84 dinner equally among the 4 of us") into
// a structured expense object the rest of the app can persist and sync.
// Backed by Slack AI capabilities; falls back to a lightweight regex heuristic
// so the pipeline stays testable before the AI layer is fully wired.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ParsedExpense
 * @property {string} description   Human-readable label (e.g. "Team dinner").
 * @property {number} amount        Total amount in the detected currency.
 * @property {string} currency      ISO 4217 code (e.g. "USD", "EUR").
 * @property {string} paidBy        Slack user id of the payer.
 * @property {string[]} participants Slack user ids sharing the cost.
 * @property {'equal'|'custom'} splitType How the total is divided.
 * @property {Array<{userId: string, amount: number}>} [customSplits] Per-user amounts.
 */

/**
 * Parse a natural-language expense message into structured data.
 *
 * @param {string} text  Raw message text from the mention/DM/slash command.
 * @param {{ channelId: string, authorId: string }} context
 * @returns {Promise<ParsedExpense|null>}
 */
export async function parseExpense(text, context) {
  // TODO: Call the Slack AI layer with a structured-output prompt/schema.
  //   const result = await slackAi.complete({ prompt: buildPrompt(text), schema });
  //   return normalizeParsed(result, context);
  //
  // Interim heuristic below extracts just an amount + currency so downstream
  // wiring can be exercised end-to-end.
  const { amount, currency } = extractAmount(text);

  return {
    description: text.slice(0, 80),
    amount,
    currency,
    paidBy: context.authorId,
    participants: [], // TODO: resolve @mentions or channel members
    splitType: 'equal',
  };
}

/**
 * Very small amount/currency extractor used until Slack AI is connected.
 * Recognizes "$94", "94 USD", "€120", etc.
 * @param {string} text
 * @returns {{ amount: number|null, currency: string }}
 */
function extractAmount(text) {
  const symbolMap = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
  const match = text.match(/([$€£¥])?\s?(\d+(?:\.\d{1,2})?)\s?([A-Za-z]{3})?/);
  if (!match) return { amount: null, currency: process.env.DEFAULT_BASE_CURRENCY || 'USD' };

  const [, symbol, value, code] = match;
  const currency =
    (code && code.toUpperCase()) ||
    symbolMap[symbol] ||
    process.env.DEFAULT_BASE_CURRENCY ||
    'USD';

  return { amount: Number(value), currency };
}

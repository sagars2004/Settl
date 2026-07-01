// ---------------------------------------------------------------------------
// Expense parser — Slack AI natural-language understanding layer.
// ---------------------------------------------------------------------------
// Turns free-form text ("split the $84 dinner equally among the 4 of us") into
// a structured expense object the rest of the app can persist and sync.
// Backed by Slack AI capabilities; falls back to a lightweight regex heuristic
// so the pipeline stays testable before the AI layer is fully wired.
// ---------------------------------------------------------------------------

import { SLACK_MENTION_PATTERN, BARE_MENTION_PATTERN } from '../utils/groupParser.js';

/**
 * @typedef {Object} ParsedExpense
 * @property {string} description   Human-readable label (e.g. "Team dinner").
 * @property {number|null} amount   Total amount in the detected currency.
 * @property {string} currency      ISO 4217 code (e.g. "USD", "EUR").
 * @property {string} paidBy        Slack user id of the payer.
 * @property {string[]} participants Slack user ids sharing the cost.
 * @property {string[]} slackMentions Resolved Slack-encoded @mentions.
 * @property {string[]} bareHandles Plain @handles to resolve via users.list.
 * @property {number|null} waysCount Parsed "N ways" count, if present.
 * @property {'equal'|'custom'} splitType How the total is divided.
 * @property {Array<{userId: string, amount: number}>} [customSplits] Per-user amounts.
 */

/**
 * Parse a natural-language expense message into structured data.
 *
 * @param {string} text  Raw message text from the mention/DM/slash command.
 * @param {{ channelId: string, authorId: string, botUserId?: string }} context
 * @returns {Promise<ParsedExpense>}
 */
export async function parseExpense(text, context) {
  // TODO: Call the Slack AI layer with a structured-output prompt/schema.
  let cleaned = text.trim();
  if (context.botUserId) {
    cleaned = cleaned
      .replace(new RegExp(`<@${context.botUserId}(?:\\|[^>]+)?>`, 'gi'), ' ')
      .trim();
  }

  const slackMentions = [];
  for (const match of cleaned.matchAll(SLACK_MENTION_PATTERN)) {
    if (match[1] !== context.botUserId) {
      slackMentions.push(match[1]);
    }
  }

  let remainder = cleaned.replace(SLACK_MENTION_PATTERN, ' ');

  const bareHandles = [];
  for (const match of remainder.matchAll(BARE_MENTION_PATTERN)) {
    bareHandles.push(match[1]);
  }
  remainder = remainder.replace(BARE_MENTION_PATTERN, ' ');

  const waysMatch = remainder.match(/(\d+)\s*ways?/i);
  const waysCount = waysMatch ? Number.parseInt(waysMatch[1], 10) : null;

  const { amount, currency, matchedText } = extractAmount(remainder);
  const description = extractDescription(remainder, matchedText);

  return {
    description,
    amount,
    currency,
    paidBy: context.authorId,
    participants: slackMentions,
    slackMentions,
    bareHandles,
    waysCount,
    splitType: 'equal',
  };
}

/**
 * Very small amount/currency extractor used until Slack AI is connected.
 * Recognizes "$94", "94 USD", "€120", etc.
 * @param {string} text
 * @returns {{ amount: number|null, currency: string, matchedText: string|null }}
 */
function extractAmount(text) {
  const symbolMap = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
  const fallbackCurrency = process.env.DEFAULT_BASE_CURRENCY || 'USD';

  // Require a word boundary after an optional ISO code so "dinner" isn't read as "DIN".
  const match = text.match(
    /([$€£¥])?\s?(\d+(?:\.\d{1,2})?)(?:\s+([A-Za-z]{3})\b)?/,
  );
  if (!match) return { amount: null, currency: fallbackCurrency, matchedText: null };

  const [, symbol, value, code] = match;
  const currency =
    (code && code.toUpperCase()) || symbolMap[symbol] || fallbackCurrency;

  return { amount: Number(value), currency, matchedText: match[0] };
}

/**
 * Pull a short description from the message after stripping amount/split noise.
 * @param {string} text
 * @param {string|null} amountText
 */
function extractDescription(text, amountText) {
  let desc = text;
  if (amountText) desc = desc.replace(amountText, ' ');
  desc = desc
    .replace(/\d+\s*ways?/gi, ' ')
    .replace(/\b(split|equally|among|between|evenly|for)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!desc) return 'Expense';
  return desc.slice(0, 80);
}

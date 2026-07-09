// ---------------------------------------------------------------------------
// Expense parser — Slack AI natural-language understanding layer.
// ---------------------------------------------------------------------------
// Turns free-form text ("split the $84 dinner equally among the 4 of us") into
// a structured expense object the rest of the app can persist and sync.
// Slack-encoded @mentions are extracted with regex (they are precise), while
// the amount / description / currency / intent are extracted by an LLM when a
// provider is configured, with a regex heuristic fallback so the pipeline works
// with zero configuration.
// ---------------------------------------------------------------------------

import { SLACK_MENTION_PATTERN, BARE_MENTION_PATTERN } from '../utils/groupParser.js';
import { aiParseExpense } from './aiParser.js';

/**
 * @typedef {Object} ParsedExpense
 * @property {'log_expense'|'summary'|'settle'|'help'} intent  Detected intent.
 * @property {string} description   Human-readable label (e.g. "Team dinner").
 * @property {number|null} amount   Total amount in the detected currency.
 * @property {string} currency      ISO 4217 code (e.g. "USD", "EUR").
 * @property {string} paidBy        Slack user id of the payer.
 * @property {string[]} participants Slack user ids sharing the cost.
 * @property {string[]} slackMentions Resolved Slack-encoded @mentions.
 * @property {string[]} bareHandles Plain @handles to resolve via users.list.
 * @property {string[]} coPayerBareHandles Bare names detected as co-payers.
 * @property {string[]} coPayerMentionIds Slack ids @mentioned as co-payers.
 * @property {string[]} payers  Resolved payer ids (filled in pipeline).
 * @property {number|null} waysCount Parsed "N ways" count, if present.
 * @property {'equal'|'custom'} splitType How the total is divided.
 * @property {'ai'|'regex'} parsedVia Which layer produced the fields.
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
  let cleaned = (text ?? '').trim();
  if (context.botUserId) {
    cleaned = cleaned
      .replace(new RegExp(`<@${context.botUserId}(?:\\|[^>]+)?>`, 'gi'), ' ')
      .trim();
  }

  // Slack-encoded @mentions are precise — always extract with regex.
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
  remainder = remainder.replace(BARE_MENTION_PATTERN, ' ').trim();

  // Try the AI layer first for amount/description/currency/waysCount/intent.
  const ai = await aiParseExpense(remainder);

  const paidContext = /\b(paid|spent|covered|bought)\b/i.test(remainder);
  const coPayerBareHandles = [
    ...extractCoPayerBareHandles(remainder),
    ...(ai?.coPayerNames ?? []),
  ].filter(Boolean);
  const coPayerBareSet = new Set(coPayerBareHandles.map((h) => h.toLowerCase()));

  // In "X and I paid" messages, @mentions are co-payers — not split participants.
  const coPayerMentionIds = paidContext && slackMentions.length ? [...slackMentions] : [];
  const participantBareHandles = bareHandles.filter((h) => !coPayerBareSet.has(h.toLowerCase()));

  // Regex heuristics (used as fallback and to fill any gaps the AI left null).
  const regexWays = matchWaysCount(remainder);
  const { amount: regexAmount, currency: regexCurrency, matchedText } = extractAmount(remainder);
  const regexDescription = extractDescription(remainder, matchedText);

  const parsedVia = ai ? 'ai' : 'regex';

  const amount = ai?.amount ?? regexAmount;
  const currency = (ai?.currency ?? regexCurrency) || process.env.DEFAULT_BASE_CURRENCY || 'USD';
  const description = ai?.description || regexDescription;
  const waysCount = ai?.waysCount ?? regexWays;

  const intent = reconcileIntent(ai?.intent ?? inferIntent(remainder), remainder, amount);

  return {
    intent,
    description,
    amount,
    currency,
    paidBy: context.authorId,
    participants: coPayerMentionIds.length ? [] : slackMentions,
    slackMentions: coPayerMentionIds.length ? [] : slackMentions,
    bareHandles: participantBareHandles,
    coPayerBareHandles: [...new Set(coPayerBareHandles)],
    coPayerMentionIds,
    payers: [],
    waysCount,
    splitType: 'equal',
    parsedVia,
  };
}

/**
 * Detect bare names in "Tim and I paid" / "I and Tim paid" patterns.
 * @param {string} text
 * @returns {string[]}
 */
function extractCoPayerBareHandles(text) {
  const handles = [];
  const patterns = [
    /([A-Za-z][\w.-]*)\s+and\s+I\s+paid/i,
    /I\s+and\s+([A-Za-z][\w.-]*)\s+paid/i,
    /([A-Za-z][\w.-]*)\s+and\s+me\s+paid/i,
    /me\s+and\s+([A-Za-z][\w.-]*)\s+paid/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) handles.push(match[1]);
  }
  return handles;
}

/**
 * Correct obvious intent misfires. A message that states a NEW amount plus
 * expense language ("split", "for", "dinner"…) is a log_expense — even if the
 * model guessed settle/summary (the word "split" often trips small models).
 * @param {'log_expense'|'summary'|'settle'|'help'} intent
 * @param {string} text
 * @param {number|null} amount
 * @returns {'log_expense'|'summary'|'settle'|'help'}
 */
function reconcileIntent(intent, text, amount) {
  if (intent === 'log_expense') return intent;
  if (amount == null || amount <= 0) return intent;

  const lower = text.toLowerCase();
  // Genuine settle/summary phrases keep their intent even with an amount.
  const explicitSettle = /\b(settle|paid?\s+(back|off)|pay(ing)?\s+(back|up)|square\s+up|owe you|owe him|owe her|owe them)\b/.test(lower);
  if (explicitSettle) return intent;

  // "Split", a purchase verb, or a description keyword => new expense.
  const looksLikeExpense = /\b(split|spent|bought|cost|for|paid for|grabbed|covered|dinner|lunch|groceries|drinks|coffee|rent|uber|taxi|bill|tab)\b/.test(lower);
  if (looksLikeExpense) return 'log_expense';

  return intent;
}

/**
 * Lightweight regex intent classifier (fallback when AI is unavailable).
 * @param {string} text
 * @returns {'log_expense'|'summary'|'settle'|'help'}
 */
function inferIntent(text) {
  const lower = text.toLowerCase();
  if (/\b(settle|pay(ing)? (up|back)|square up|mark.*paid)\b/.test(lower)) return 'settle';
  if (/\b(summary|tab|balance|who owes|what do i owe|how much)\b/.test(lower)) return 'summary';
  if (/\d/.test(lower) || /\b(split|paid|spent|cost|bought|covered|expense)\b/.test(lower)) {
    return 'log_expense';
  }
  return 'help';
}

/**
 * @param {string} text
 * @returns {number|null}
 */
function matchWaysCount(text) {
  const waysMatch = text.match(/(\d+)\s*(?:ways?|people|persons?)/i);
  return waysMatch ? Number.parseInt(waysMatch[1], 10) : null;
}

/**
 * Very small amount/currency extractor used when the AI layer is unavailable.
 * Recognizes "$94", "94 USD", "€120", etc.
 * @param {string} text
 * @returns {{ amount: number|null, currency: string, matchedText: string|null }}
 */
function extractAmount(text) {
  const symbolMap = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
  const fallbackCurrency = process.env.DEFAULT_BASE_CURRENCY || 'USD';

  // Require a word boundary after an optional ISO code so "dinner" isn't read as "DIN".
  const match = text.match(/([$€£¥])?\s?(\d+(?:\.\d{1,2})?)(?:\s+([A-Za-z]{3})\b)?/);
  if (!match) return { amount: null, currency: fallbackCurrency, matchedText: null };

  const [, symbol, value, code] = match;
  const currency = (code && code.toUpperCase()) || symbolMap[symbol] || fallbackCurrency;

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
    .replace(/\d+\s*(?:ways?|people|persons?)/gi, ' ')
    .replace(/\b(split|equally|among|between|evenly|for|the|paid|spent|covered)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!desc) return 'Expense';
  return desc.slice(0, 80);
}

// ---------------------------------------------------------------------------
// Expense pipeline — shared parse → validate → split → persist → confirm flow.
// ---------------------------------------------------------------------------
// Used by @Settl mentions, DMs, and `/settl add`.
// ---------------------------------------------------------------------------

import { parseExpense } from './expenseParser.js';
import { convertCurrency } from './currencyService.js';
import {
  createExpense,
  getGroupByChannel,
  getGroupExpenses,
} from './datastoreService.js';
import { syncExpenseToSplitwise } from './splitwiseMCP.js';
import { calculateBalances } from '../utils/balanceCalculator.js';
import { buildExpenseConfirmation } from '../utils/formatter.js';
import { validateExpense } from '../utils/expenseValidator.js';
import { computeSplits } from '../utils/splitCalculator.js';
import { resolveUserHandles } from '../utils/userResolver.js';

/**
 * Parse, validate, split, persist, and confirm an expense.
 *
 * @param {object} input
 * @param {string} input.text          Raw expense text.
 * @param {string} input.channelId     Slack channel id.
 * @param {string} input.userId        Slack user id of the payer / author.
 * @param {import('@slack/web-api').WebClient} input.client
 * @param {(payload: object) => Promise<void>} input.reply  say() or respond()
 * @param {string} [input.threadTs]    Thread timestamp for in-channel replies.
 * @param {string} [input.botUserId]   Bot user id (strips @Settl from mentions).
 * @param {import('@slack/bolt').Logger} [input.logger]
 * @returns {Promise<{ ok: boolean, expense?: object }>}
 */
export async function logExpense({
  text,
  channelId,
  userId,
  client,
  reply,
  threadTs,
  botUserId,
  logger,
}) {
  const parsed = await parseExpense(text, {
    channelId,
    authorId: userId,
    botUserId,
  });

  const group = await getGroupByChannel(channelId);

  const { resolved, unresolved } = await resolveUserHandles(client, parsed.bareHandles);
  if (unresolved.length) {
    await reply({
      thread_ts: threadTs,
      text: `Couldn't find ${unresolved.map((handle) => `@${handle}`).join(', ')}. Use Slack's @ menu to pick users.`,
    });
    return { ok: false };
  }

  const explicitParticipants = [...new Set([...parsed.slackMentions, ...resolved])];
  parsed.participants = explicitParticipants.length
    ? explicitParticipants
    : (group?.members ?? []);

  const validation = validateExpense(parsed, group);
  if (!validation.ok) {
    await reply({ thread_ts: threadTs, text: validation.error });
    return { ok: false };
  }

  let amount = parsed.amount;
  let currency = parsed.currency;
  const baseCurrency = group.base_currency || process.env.DEFAULT_BASE_CURRENCY || 'USD';

  if (currency && currency !== baseCurrency) {
    const converted = await convertCurrency(amount, currency, baseCurrency);
    amount = converted.amount;
    currency = baseCurrency;
  }

  const splits = computeSplits({
    amount,
    splitType: parsed.splitType,
    participants: validation.participants,
    customSplits: parsed.customSplits,
  });

  const expense = await createExpense({
    description: parsed.description,
    amount,
    currency,
    paidBy: parsed.paidBy,
    groupId: group.group_id,
    splits,
  });

  await syncExpenseToSplitwise(expense, userId).catch((err) =>
    logger?.warn('[expensePipeline] Splitwise sync skipped:', err.message),
  );

  const allExpenses = await getGroupExpenses(group.group_id);
  const balances = calculateBalances(group, allExpenses);

  await reply({
    thread_ts: threadTs,
    blocks: buildExpenseConfirmation(expense, balances, group),
    text: `Logged ${currency} ${amount} — ${expense.description}`,
  });

  return { ok: true, expense };
}

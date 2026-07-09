// ---------------------------------------------------------------------------
// Expense pipeline — shared parse → validate → split → persist → confirm flow.
// ---------------------------------------------------------------------------
// Used by @Settl mentions, DMs, the Assistant, and `/settl add`.
// When no @mentions are provided, shows an interactive review card first so
// the user can pick who's in before splitting equally or entering custom amounts.
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
import {
  buildExpenseConfirmation,
  buildExpenseReviewMessage,
  buildErrorMessage,
} from '../utils/formatter.js';
import { validateExpense } from '../utils/expenseValidator.js';
import { computeSplits } from '../utils/splitCalculator.js';
import { resolveUserHandles } from '../utils/userResolver.js';
import { createPendingReview } from './pendingExpenseStore.js';

/**
 * Parse, validate, split, persist, and confirm an expense.
 *
 * @param {object} input
 * @param {string} input.text          Raw expense text.
 * @param {string} input.channelId     Slack channel id the group is bound to.
 * @param {string} input.userId        Slack user id of the payer / author.
 * @param {import('@slack/web-api').WebClient} input.client
 * @param {(payload: object) => Promise<void>} input.reply  say() or respond()
 * @param {string} [input.threadTs]    Thread timestamp for in-channel replies.
 * @param {string} [input.assistantChannelId] Assistant/DM channel for button follow-ups.
 * @param {string} [input.assistantThreadTs]  Assistant thread ts for button follow-ups.
 * @param {string} [input.botUserId]   Bot user id (strips @Settl from mentions).
 * @param {object} [input.parsed]      Pre-parsed expense (skips re-parsing / re-calling AI).
 * @param {(status: string) => Promise<void>} [input.setStatus]  Assistant status hook.
 * @param {boolean} [input.skipReview] Force immediate commit (slash command fast path).
 * @param {import('@slack/bolt').Logger} [input.logger]
 * @returns {Promise<{ ok: boolean, expense?: object, balances?: object, group?: object, pending?: boolean }>}
 */
export async function logExpense({
  text,
  channelId,
  userId,
  client,
  reply,
  threadTs,
  botUserId,
  parsed: preParsed,
  setStatus,
  skipReview = false,
  assistantChannelId,
  assistantThreadTs,
  logger,
}) {
  await setStatus?.('Reading your expense…');

  const parsed =
    preParsed ??
    (await parseExpense(text, { channelId, authorId: userId, botUserId }));

  const group = await getGroupByChannel(channelId);

  const { resolved: participantResolved, unresolved: participantUnresolved } =
    await resolveUserHandles(client, parsed.bareHandles);
  const { resolved: coPayerResolved, unresolved: coPayerUnresolved } =
    await resolveUserHandles(client, parsed.coPayerBareHandles);
  const unresolved = [...participantUnresolved, ...coPayerUnresolved];
  if (unresolved.length) {
    await reply({
      thread_ts: threadTs,
      blocks: buildErrorMessage(
        "Couldn't find everyone",
        `I couldn't match ${unresolved.map((h) => `\`@${h}\``).join(', ')}. Pick people from Slack's @ menu so I get the right users.`,
      ),
      text: `Couldn't find ${unresolved.map((h) => `@${h}`).join(', ')}.`,
    });
    return { ok: false };
  }

  parsed.payers = [
    ...new Set([parsed.paidBy, ...parsed.coPayerMentionIds, ...coPayerResolved]),
  ].filter(Boolean);

  if (!parsed.paidBy && parsed.payers.length > 0) {
    parsed.paidBy = parsed.payers[0];
  }

  const explicitParticipants = [...new Set([...parsed.slackMentions, ...participantResolved])];
  const hasExplicitParticipants = explicitParticipants.length > 0;
  const consumers = hasExplicitParticipants ? explicitParticipants : (group?.members ?? []);
  parsed.participants = consumers;
  parsed.consumers = consumers;

  const validation = validateExpense(parsed, group);
  if (!validation.ok) {
    await reply({
      thread_ts: threadTs,
      blocks: buildErrorMessage("Couldn't log that", validation.error),
      text: validation.error,
    });
    return { ok: false };
  }

  let amount = parsed.amount;
  let currency = parsed.currency;
  const baseCurrency = group.base_currency || process.env.DEFAULT_BASE_CURRENCY || 'USD';
  let conversion;

  if (currency && currency !== baseCurrency) {
    await setStatus?.(`Converting ${currency} → ${baseCurrency}…`);
    const converted = await convertCurrency(amount, currency, baseCurrency);
    conversion = {
      originalAmount: amount,
      originalCurrency: currency,
      fxRate: converted.rate,
      fxFallback: converted.fxFallback,
    };
    amount = converted.amount;
    currency = baseCurrency;
  }

  const shouldReview =
    !skipReview &&
    !hasExplicitParticipants &&
    (group?.members?.length ?? 0) > 1;

  if (shouldReview) {
    const consumersForReview = pickConsumers(consumers, parsed.paidBy, parsed.waysCount);
    const selectedMembers = pickDefaultDebtors(consumersForReview, parsed.payers);
    const reviewId = createPendingReview({
      parsed: { ...parsed, amount, currency, parsedVia: parsed.parsedVia },
      group,
      channelId,
      userId,
      conversion,
      consumers: consumersForReview,
      payers: parsed.payers,
      selectedMembers,
      assistantChannelId: assistantChannelId ?? channelId,
      assistantThreadTs: assistantThreadTs ?? threadTs,
    });

    await reply({
      thread_ts: threadTs,
      blocks: buildExpenseReviewMessage({
        reviewId,
        group,
        amount,
        currency,
        description: parsed.description,
        paidBy: parsed.paidBy || parsed.payers[0] || userId,
        payers: parsed.payers,
        consumers: consumersForReview,
        selectedMembers,
        conversion,
      }),
      text: `Review ${currency} ${amount} — ${parsed.description}`,
    });
    return { ok: false, pending: true };
  }

  return commitExpense({
    parsed: { ...parsed, amount, currency, debtors: pickDefaultDebtors(consumers, parsed.payers) },
    group,
    participants: validation.participants,
    userId,
    client,
    reply,
    threadTs,
    conversion,
    setStatus,
    logger,
  });
}

/**
 * Persist a reviewed or explicit-participant expense and post confirmation.
 * @param {object} input
 */
export async function commitExpense({
  parsed,
  group,
  participants,
  userId,
  client,
  reply,
  threadTs,
  conversion,
  setStatus,
  logger,
  splitType = 'equal',
  customSplits,
}) {
  const splits = computeSplits({
    amount: parsed.amount,
    splitType,
    participants,
    customSplits,
  });

  const payers = parsed.payers ?? [];
  const payerSet = new Set(payers);
  const debtors =
    parsed.debtors?.length > 0
      ? parsed.debtors
      : participants.filter((id) => !payerSet.has(id));

  await setStatus?.('Saving to the tab…');
  const expense = await createExpense({
    description: parsed.description,
    amount: parsed.amount,
    currency: parsed.currency,
    paidBy: parsed.paidBy,
    groupId: group.group_id,
    splits,
    payers,
    debtors,
  });

  let splitwise = { synced: false, reason: 'not_linked' };
  try {
    await setStatus?.('Syncing to Splitwise…');
    splitwise = await syncExpenseToSplitwise(expense, userId, client);
  } catch (err) {
    splitwise = { synced: false, reason: 'error', message: err.message };
    logger?.warn('[expensePipeline] Splitwise sync skipped:', err.message);
  }

  const allExpenses = await getGroupExpenses(group.group_id);
  const balances = calculateBalances(group, allExpenses);

  await reply({
    thread_ts: threadTs,
    blocks: buildExpenseConfirmation(expense, balances, group, {
      conversion,
      parsedVia: parsed.parsedVia,
      splitwise,
    }),
    text: `Logged ${parsed.currency} ${parsed.amount} — ${expense.description}`,
  });

  return { ok: true, expense, balances, group };
}

/**
 * Everyone sharing the cost (denominator for per-person share).
 * @param {string[]} members
 * @param {string} paidBy
 * @param {number|null} waysCount
 */
function pickConsumers(members, paidBy, waysCount) {
  const roster = [...new Set(members.filter(Boolean))];
  if (!waysCount || waysCount >= roster.length) return roster;

  const others = roster.filter((id) => id !== paidBy).slice(0, Math.max(waysCount - 1, 0));
  return [...new Set([paidBy, ...others])];
}

/**
 * Default members who still owe money (excludes co-payers).
 * @param {string[]} consumers
 * @param {string[]} payers
 */
function pickDefaultDebtors(consumers, payers) {
  const payerSet = new Set(payers);
  return consumers.filter((id) => !payerSet.has(id));
}

// ---------------------------------------------------------------------------
// Mention listeners — the primary, zero-friction expense input surface.
// ---------------------------------------------------------------------------
// Handles `app_mention` events (e.g. "@Settl grabbed dinner, $94, split 4 ways")
// and 1:1 DM messages. The raw text is handed to the Slack AI parser, converted
// to a structured expense, persisted, optionally synced to Splitwise, and
// confirmed back to the user in-thread with a Block Kit summary.
// ---------------------------------------------------------------------------

import { parseExpense } from '../services/expenseParser.js';
import { convertCurrency } from '../services/currencyService.js';
import { createExpense, getGroupByChannel } from '../services/datastoreService.js';
import { syncExpenseToSplitwise } from '../services/splitwiseMCP.js';
import { calculateBalances } from '../utils/balanceCalculator.js';
import { buildExpenseConfirmation } from '../utils/formatter.js';

/**
 * Attach mention/DM handlers to the Bolt app.
 * @param {import('@slack/bolt').App} app
 */
export function registerMentionListeners(app) {
  // Fired when a user @mentions the Settl bot in a channel.
  app.event('app_mention', async ({ event, client, say, logger }) => {
    try {
      await handleExpenseMessage({ event, client, say, logger });
    } catch (error) {
      logger.error('[mentions] app_mention handler failed:', error);
      await say({
        thread_ts: event.ts,
        text: "Sorry — I couldn't log that expense. Mind rephrasing it?",
      });
    }
  });

  // Fired for direct messages to the bot (im). Enables private, 1:1 logging.
  app.message(async ({ message, client, say, logger }) => {
    // Ignore bot echoes, edits, and non-standard message subtypes.
    if (message.subtype || message.bot_id) return;
    try {
      await handleExpenseMessage({ event: message, client, say, logger });
    } catch (error) {
      logger.error('[mentions] DM handler failed:', error);
    }
  });
}

/**
 * Shared pipeline: parse -> convert currency -> resolve group -> persist ->
 * sync -> confirm. Stubbed; wiring only.
 */
async function handleExpenseMessage({ event, client, say, logger }) {
  // 1. Parse the natural-language message via Slack AI into a structured shape.
  const parsed = await parseExpense(event.text, {
    channelId: event.channel,
    authorId: event.user,
  });

  // 2. If the amount is in a non-base currency, fetch a live FX rate.
  if (parsed?.currency && parsed.currency !== process.env.DEFAULT_BASE_CURRENCY) {
    // TODO: apply converted amount to `parsed` once currencyService is live.
    await convertCurrency(parsed.amount, parsed.currency, process.env.DEFAULT_BASE_CURRENCY);
  }

  // 3. Resolve which expense group this channel maps to.
  const group = await getGroupByChannel(event.channel);
  // TODO: if no group exists, prompt the user to run `/settl create`.

  // 4. Persist the expense to the Slack Datastore ledger.
  const expense = await createExpense({ ...parsed, groupId: group?.group_id });

  // 5. Best-effort push to Splitwise if the payer has linked their account.
  await syncExpenseToSplitwise(expense, event.user).catch((err) =>
    logger.warn('[mentions] Splitwise sync skipped:', err.message),
  );

  // 6. Recompute balances and confirm back in-thread with a rich summary.
  const balances = calculateBalances(group, [expense]);
  await say({
    thread_ts: event.ts,
    blocks: buildExpenseConfirmation(expense, balances),
    text: 'Expense logged.',
  });
}

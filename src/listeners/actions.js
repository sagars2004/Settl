// ---------------------------------------------------------------------------
// Action listeners — Block Kit interactive button handlers.
// ---------------------------------------------------------------------------
// Confirmation and summary messages render buttons ("Mark as Settled",
// "Send Venmo Request", "Dismiss"). Slack posts an interaction payload here
// when a user clicks one. `action_id` values must match those emitted by the
// builders in utils/formatter.js.
// ---------------------------------------------------------------------------

import { markBalanceSettled } from '../services/datastoreService.js';
import { syncSettlementToSplitwise } from '../services/splitwiseMCP.js';
import { buildVenmoLink } from '../utils/venmoLink.js';

// Canonical action_id constants shared with the formatter.
export const ACTION_IDS = {
  MARK_SETTLED: 'settl_mark_settled',
  SEND_VENMO: 'settl_send_venmo',
  DISMISS: 'settl_dismiss',
};

/**
 * Attach Block Kit action handlers to the Bolt app.
 * @param {import('@slack/bolt').App} app
 */
export function registerActionListeners(app) {
  // "Mark as Settled" — clears the outstanding balance and updates the message.
  app.action(ACTION_IDS.MARK_SETTLED, async ({ ack, body, action, respond, logger }) => {
    await ack();
    try {
      // `action.value` carries the encoded { groupId, counterpartyId } payload.
      const { groupId, counterpartyId } = JSON.parse(action.value ?? '{}');
      await markBalanceSettled(groupId, counterpartyId);
      await syncSettlementToSplitwise(groupId, counterpartyId).catch((e) =>
        logger.warn('[actions] Splitwise settlement sync skipped:', e.message),
      );
      await respond({ replace_original: true, text: '✅ Balance cleared. Tab updated.' });
    } catch (error) {
      logger.error('[actions] mark_settled failed:', error);
      await respond({ replace_original: false, text: "Couldn't settle that balance." });
    }
  });

  // "Send Venmo Request" — surfaces a pre-filled Venmo deep link.
  app.action(ACTION_IDS.SEND_VENMO, async ({ ack, action, respond, logger }) => {
    await ack();
    try {
      const { username, amount, note } = JSON.parse(action.value ?? '{}');
      const link = buildVenmoLink({ username, amount, note });
      await respond({ replace_original: false, text: `Tap to pay on Venmo: ${link}` });
    } catch (error) {
      logger.error('[actions] send_venmo failed:', error);
    }
  });

  // "Dismiss" — quietly removes the interactive prompt.
  app.action(ACTION_IDS.DISMISS, async ({ ack, respond }) => {
    await ack();
    await respond({ delete_original: true, text: '' });
  });
}

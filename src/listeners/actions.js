// ---------------------------------------------------------------------------
// Action listeners — Block Kit interactive button handlers.
// ---------------------------------------------------------------------------
// Confirmation, summary, and review messages render buttons. In the Assistant
// split-view, follow-ups must be posted with chat.postMessage into the same
// thread — respond() alone routes to the app's Messages tab.
// ---------------------------------------------------------------------------

import {
  markBalanceSettled,
  getGroup,
  getGroupExpenses,
} from '../services/datastoreService.js';
import { commitExpense } from '../services/expensePipeline.js';
import {
  deletePendingReview,
  getPendingReview,
  updatePendingReview,
} from '../services/pendingExpenseStore.js';
import { syncSettlementToSplitwise } from '../services/splitwiseMCP.js';
import { calculateBalances, findDebtBetweenUsers } from '../utils/balanceCalculator.js';
import { buildVenmoLink } from '../utils/venmoLink.js';
import {
  buildSummaryMessage,
  buildSettleMessage,
  buildExpenseReviewMessage,
  buildCustomSplitModal,
  buildErrorMessage,
} from '../utils/formatter.js';
import { postFollowUp, updateSourceMessage } from '../utils/interactionReply.js';

// Canonical action_id constants shared with the formatter.
export const ACTION_IDS = {
  MARK_SETTLED: 'settl_mark_settled',
  SEND_VENMO: 'settl_send_venmo',
  DISMISS: 'settl_dismiss',
  VIEW_TAB: 'settl_view_tab',
  SUMMARY_SETTLE: 'settl_summary_settle',
  OPEN_SPLITWISE: 'settl_open_splitwise',
  TOGGLE_PARTICIPANT: 'settl_toggle_participant',
  CONFIRM_EQUAL_SPLIT: 'settl_confirm_equal_split',
  OPEN_CUSTOM_SPLIT: 'settl_open_custom_split',
  CANCEL_REVIEW: 'settl_cancel_review',
};

export const VIEW_IDS = {
  CUSTOM_SPLIT: 'settl_custom_split_modal',
};

/**
 * Attach Block Kit action handlers to the Bolt app.
 * @param {import('@slack/bolt').App} app
 */
export function registerActionListeners(app) {
  app.action(ACTION_IDS.MARK_SETTLED, async ({ ack, body, action, client, respond, logger }) => {
    await ack();
    try {
      const { groupId, debtorId, creditorId } = JSON.parse(action.value ?? '{}');
      const result = await markBalanceSettled(groupId, debtorId, creditorId);
      await syncSettlementToSplitwise(groupId, debtorId).catch((e) =>
        logger.warn('[actions] Splitwise settlement sync skipped:', e.message),
      );
      await postFollowUp({
        client,
        body,
        respond,
        payload: {
          text: `✅ Settled ${result.settledSplitCount} share${result.settledSplitCount === 1 ? '' : 's'}. Run \`/settl summary\` or ask "what's the tab?" to refresh.`,
        },
      });
    } catch (error) {
      logger.error('[actions] mark_settled failed:', error);
      await postFollowUp({
        client,
        body,
        respond,
        payload: { text: "Couldn't settle that balance." },
      });
    }
  });

  app.action(ACTION_IDS.SEND_VENMO, async ({ ack, action, client, body, respond, logger }) => {
    await ack();
    try {
      const { username, amount, note } = JSON.parse(action.value ?? '{}');
      if (!username) {
        return postFollowUp({
          client,
          body,
          respond,
          payload: {
            text: "Couldn't build a Venmo link — no Venmo username on file. Pay manually or update your Slack username to match Venmo.",
          },
        });
      }
      const link = buildVenmoLink({ username, amount, note });
      await postFollowUp({
        client,
        body,
        respond,
        payload: { text: `Tap to pay on Venmo: ${link}` },
      });
    } catch (error) {
      logger.error('[actions] send_venmo failed:', error);
    }
  });

  app.action(ACTION_IDS.DISMISS, async ({ ack, body, client, respond }) => {
    await ack();
    const channel = body.channel?.id;
    const ts = body.message?.ts;
    if (channel && ts) {
      await client.chat.delete({ channel, ts });
      return;
    }
    await respond({ delete_original: true, text: '' });
  });

  app.action(ACTION_IDS.VIEW_TAB, async ({ ack, action, client, body, respond, logger }) => {
    await ack();
    try {
      const { groupId } = JSON.parse(action.value ?? '{}');
      const group = await getGroup(groupId);
      const expenses = await getGroupExpenses(groupId);
      const balances = calculateBalances(group, expenses);
      await postFollowUp({
        client,
        body,
        respond,
        payload: {
          blocks: buildSummaryMessage(group, balances, { expenseCount: expenses.length }),
          text: 'Current tab',
        },
      });
    } catch (error) {
      logger.error('[actions] view_tab failed:', error);
    }
  });

  app.action(ACTION_IDS.SUMMARY_SETTLE, async ({ ack, body, action, client, respond, logger }) => {
    await ack();
    try {
      const { groupId, debtorId, creditorId } = JSON.parse(action.value ?? '{}');
      const group = await getGroup(groupId);
      const expenses = await getGroupExpenses(groupId);
      const balances = calculateBalances(group, expenses);

      const requesterId = body.user?.id ?? creditorId;
      const counterpartyId = requesterId === debtorId ? creditorId : debtorId;
      const debt = findDebtBetweenUsers(balances, requesterId, counterpartyId);

      let venmoRecipient;
      if (debt && debt.to === requesterId) {
        const info = await client.users.info({ user: requesterId });
        venmoRecipient = info.user?.name ?? null;
      }

      await postFollowUp({
        client,
        body,
        respond,
        payload: {
          blocks: buildSettleMessage({ group, requesterId, counterpartyId, debt, venmoRecipient }),
          text: 'Settle up',
        },
      });
    } catch (error) {
      logger.error('[actions] summary_settle failed:', error);
      await postFollowUp({
        client,
        body,
        respond,
        payload: {
          blocks: buildErrorMessage('Settle failed', "Couldn't open the settle card. Try `/settl settle @user`."),
          text: "Couldn't settle.",
        },
      });
    }
  });

  app.action(ACTION_IDS.TOGGLE_PARTICIPANT, async ({ ack, body, action, client, logger }) => {
    await ack();
    try {
      const { reviewId, memberId } = JSON.parse(action.value ?? '{}');
      const draft = getPendingReview(reviewId);
      if (!draft) return;

      const selected = new Set(draft.selectedMembers ?? []);
      if (selected.has(memberId)) {
        if (selected.size > 1) selected.delete(memberId);
      } else {
        selected.add(memberId);
      }

      const updated = updatePendingReview(reviewId, { selectedMembers: [...selected] });
      await updateSourceMessage({
        client,
        body,
        payload: {
          blocks: buildExpenseReviewMessage({
            reviewId,
            group: updated.group,
            amount: updated.parsed.amount,
            currency: updated.parsed.currency,
            description: updated.parsed.description,
            paidBy: updated.parsed.paidBy,
            selectedMembers: updated.selectedMembers,
            conversion: updated.conversion,
          }),
          text: 'Review expense',
        },
      });
    } catch (error) {
      logger.error('[actions] toggle_participant failed:', error);
    }
  });

  app.action(ACTION_IDS.CONFIRM_EQUAL_SPLIT, async ({ ack, body, action, client, respond, logger }) => {
    await ack();
    try {
      const { reviewId } = JSON.parse(action.value ?? '{}');
      const draft = getPendingReview(reviewId);
      if (!draft) {
        return updateSourceMessage({
          client,
          body,
          payload: {
            blocks: buildErrorMessage('Expired', 'This review expired — log the expense again.'),
            text: 'Review expired',
          },
        });
      }

      if (!draft.selectedMembers?.length) {
        return postFollowUp({
          client,
          body,
          respond,
          payload: { text: 'Pick at least one person to include in the split.' },
        });
      }

      deletePendingReview(reviewId);
      await commitExpense({
        parsed: draft.parsed,
        group: draft.group,
        participants: draft.selectedMembers,
        userId: draft.userId,
        client,
        reply: (payload) => updateSourceMessage({ client, body, payload }),
        conversion: draft.conversion,
        logger,
      });
    } catch (error) {
      logger.error('[actions] confirm_equal_split failed:', error);
    }
  });

  app.action(ACTION_IDS.OPEN_CUSTOM_SPLIT, async ({ ack, body, action, client, logger }) => {
    await ack();
    try {
      const { reviewId } = JSON.parse(action.value ?? '{}');
      const draft = getPendingReview(reviewId);
      if (!draft || !draft.selectedMembers?.length) return;

      const memberNames = {};
      await Promise.all(
        draft.selectedMembers.map(async (userId) => {
          const info = await client.users.info({ user: userId });
          memberNames[userId] = info.user?.real_name || info.user?.name || userId;
        }),
      );

      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildCustomSplitModal({
          reviewId,
          amount: draft.parsed.amount,
          currency: draft.parsed.currency,
          selectedMembers: draft.selectedMembers,
          memberNames,
        }),
      });
    } catch (error) {
      logger.error('[actions] open_custom_split failed:', error);
    }
  });

  app.action(ACTION_IDS.CANCEL_REVIEW, async ({ ack, body, action, client }) => {
    await ack();
    const { reviewId } = JSON.parse(action.value ?? '{}');
    deletePendingReview(reviewId);
    await updateSourceMessage({
      client,
      body,
      payload: {
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: ':no_entry_sign: Expense cancelled.' } }],
        text: 'Cancelled',
      },
    });
  });

  app.action(ACTION_IDS.OPEN_SPLITWISE, async ({ ack }) => {
    await ack();
  });

  app.view(VIEW_IDS.CUSTOM_SPLIT, async ({ ack, body, view, client, logger }) => {
    try {
      const { reviewId } = JSON.parse(view.private_metadata ?? '{}');
      const draft = getPendingReview(reviewId);
      if (!draft) {
        await ack();
        return;
      }

      const customSplits = (draft.selectedMembers ?? []).map((userId) => {
        const block = view.state.values[`member_${userId}`];
        const raw = block?.amount?.value ?? '0';
        return { user_id: userId, amount: Number.parseFloat(raw) || 0 };
      });

      const total = customSplits.reduce((sum, split) => sum + split.amount, 0);
      const expected = Number(draft.parsed.amount);
      if (Math.abs(total - expected) > 0.02) {
        await ack({
          response_action: 'errors',
          errors: {
            [`member_${draft.selectedMembers[0]}`]: `Shares must add up to ${expected.toFixed(2)} (currently ${total.toFixed(2)}).`,
          },
        });
        return;
      }

      deletePendingReview(reviewId);

      await commitExpense({
        parsed: draft.parsed,
        group: draft.group,
        participants: draft.selectedMembers,
        userId: body.user.id,
        client,
        reply: async (payload) => {
          if (draft.assistantChannelId && draft.assistantThreadTs) {
            await client.chat.postMessage({
              channel: draft.assistantChannelId,
              thread_ts: draft.assistantThreadTs,
              ...payload,
            });
          }
        },
        conversion: draft.conversion,
        splitType: 'custom',
        customSplits,
        logger,
      });

      await ack();
    } catch (error) {
      logger.error('[actions] custom_split submit failed:', error);
      await ack();
    }
  });
}

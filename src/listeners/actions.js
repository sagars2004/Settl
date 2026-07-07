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

const EXPIRED_REVIEW_MESSAGE = buildErrorMessage(
  'Review expired',
  'This review expired or the app restarted — log the expense again.',
);

/**
 * Safely parse a button `value` JSON payload.
 * @param {string|undefined} raw
 * @returns {{ ok: true, data: object } | { ok: false }}
 */
function parseActionValue(raw) {
  try {
    return { ok: true, data: JSON.parse(raw ?? '{}') };
  } catch {
    return { ok: false };
  }
}

/**
 * Show a Block Kit error in-thread when a button payload is invalid.
 */
async function showInvalidAction({ client, body, respond }) {
  await postFollowUp({
    client,
    body,
    respond,
    payload: {
      blocks: buildErrorMessage(
        'Invalid button',
        'That action is stale — refresh the tab or log the expense again.',
      ),
      text: 'Invalid button state.',
    },
  });
}

/**
 * Replace a review card when its pending draft no longer exists.
 */
async function showExpiredReview({ client, body }) {
  await updateSourceMessage({
    client,
    body,
    payload: { blocks: EXPIRED_REVIEW_MESSAGE, text: 'Review expired' },
  });
}

/**
 * Standard action-handler error feedback.
 */
async function showActionError({ client, body, respond, title, message }) {
  await postFollowUp({
    client,
    body,
    respond,
    payload: {
      blocks: buildErrorMessage(title, message),
      text: title,
    },
  });
}

/**
 * Commit a pending review and delete the draft only after success.
 * @param {string} reviewId
 * @param {() => Promise<{ ok?: boolean }>} commit
 */
async function finalizeReviewCommit(reviewId, commit) {
  const result = await commit();
  if (result?.ok) {
    deletePendingReview(reviewId);
  }
  return result;
}

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
    const parsed = parseActionValue(action.value);
    if (!parsed.ok) {
      return showInvalidAction({ client, body, respond });
    }
    try {
      const { groupId, debtorId, creditorId } = parsed.data;
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
      await showActionError({
        client,
        body,
        respond,
        title: "Couldn't settle",
        message: "That balance couldn't be cleared. Try `/settl settle @user` or ask what's the tab.",
      });
    }
  });

  app.action(ACTION_IDS.SEND_VENMO, async ({ ack, action, client, body, respond, logger }) => {
    await ack();
    const parsed = parseActionValue(action.value);
    if (!parsed.ok) {
      return showInvalidAction({ client, body, respond });
    }
    try {
      const { username, amount, note } = parsed.data;
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
      await showActionError({
        client,
        body,
        respond,
        title: "Couldn't open Venmo",
        message: 'Something went wrong building the payment link. Try again or pay manually.',
      });
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
    const parsed = parseActionValue(action.value);
    if (!parsed.ok) {
      return showInvalidAction({ client, body, respond });
    }
    try {
      const { groupId } = parsed.data;
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
      await showActionError({
        client,
        body,
        respond,
        title: "Couldn't load tab",
        message: 'Try `/settl summary` or ask "what\'s the tab?" in the Assistant.',
      });
    }
  });

  app.action(ACTION_IDS.SUMMARY_SETTLE, async ({ ack, body, action, client, respond, logger }) => {
    await ack();
    const parsed = parseActionValue(action.value);
    if (!parsed.ok) {
      return showInvalidAction({ client, body, respond });
    }
    try {
      const { groupId, debtorId, creditorId } = parsed.data;
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
      await showActionError({
        client,
        body,
        respond,
        title: 'Settle failed',
        message: "Couldn't open the settle card. Try `/settl settle @user`.",
      });
    }
  });

  app.action(ACTION_IDS.TOGGLE_PARTICIPANT, async ({ ack, body, action, client, respond, logger }) => {
    await ack();
    const parsed = parseActionValue(action.value);
    if (!parsed.ok) {
      return showInvalidAction({ client, body, respond });
    }
    try {
      const { reviewId, memberId } = parsed.data;
      const draft = getPendingReview(reviewId);
      if (!draft) {
        return showExpiredReview({ client, body });
      }

      const selected = new Set(draft.selectedMembers ?? []);
      if (selected.has(memberId)) {
        if (selected.size > 1) selected.delete(memberId);
      } else {
        selected.add(memberId);
      }

      const updated = updatePendingReview(reviewId, { selectedMembers: [...selected] });
      if (!updated) {
        return showExpiredReview({ client, body });
      }

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
      await showActionError({
        client,
        body,
        respond,
        title: "Couldn't update split",
        message: 'Try toggling members again or log the expense from scratch.',
      });
    }
  });

  app.action(ACTION_IDS.CONFIRM_EQUAL_SPLIT, async ({ ack, body, action, client, respond, logger }) => {
    await ack();
    const parsed = parseActionValue(action.value);
    if (!parsed.ok) {
      return showInvalidAction({ client, body, respond });
    }
    try {
      const { reviewId } = parsed.data;
      const draft = getPendingReview(reviewId);
      if (!draft) {
        return showExpiredReview({ client, body });
      }

      if (!draft.selectedMembers?.length) {
        return postFollowUp({
          client,
          body,
          respond,
          payload: { text: 'Pick at least one person to include in the split.' },
        });
      }

      await finalizeReviewCommit(reviewId, () =>
        commitExpense({
          parsed: draft.parsed,
          group: draft.group,
          participants: draft.selectedMembers,
          userId: draft.userId,
          client,
          reply: (payload) => updateSourceMessage({ client, body, payload }),
          conversion: draft.conversion,
          logger,
        }),
      );
    } catch (error) {
      logger.error('[actions] confirm_equal_split failed:', error);
      await showActionError({
        client,
        body,
        respond,
        title: "Couldn't log expense",
        message: 'Something went wrong saving that split. Your review card is still open — try again.',
      });
    }
  });

  app.action(ACTION_IDS.OPEN_CUSTOM_SPLIT, async ({ ack, body, action, client, respond, logger }) => {
    await ack();
    const parsed = parseActionValue(action.value);
    if (!parsed.ok) {
      return showInvalidAction({ client, body, respond });
    }
    try {
      const { reviewId } = parsed.data;
      const draft = getPendingReview(reviewId);
      if (!draft) {
        return showExpiredReview({ client, body });
      }
      if (!draft.selectedMembers?.length) {
        return postFollowUp({
          client,
          body,
          respond,
          payload: { text: 'Pick at least one person before setting custom amounts.' },
        });
      }

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
      await showActionError({
        client,
        body,
        respond,
        title: "Couldn't open custom split",
        message: 'Try again or use Split equally on the review card.',
      });
    }
  });

  app.action(ACTION_IDS.CANCEL_REVIEW, async ({ ack, body, action, client, respond }) => {
    await ack();
    const parsed = parseActionValue(action.value);
    if (!parsed.ok) {
      return showInvalidAction({ client, body, respond });
    }
    const { reviewId } = parsed.data;
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
    let reviewId;
    try {
      const meta = JSON.parse(view.private_metadata ?? '{}');
      reviewId = meta.reviewId;
    } catch {
      await ack({
        response_action: 'errors',
        errors: {
          [`member_${Object.keys(view.state?.values ?? {})[0] ?? 'member_unknown'}`]:
            'Invalid form state — close and open Custom amounts again.',
        },
      });
      return;
    }

    try {
      const draft = getPendingReview(reviewId);
      if (!draft) {
        const firstBlock = Object.keys(view.state?.values ?? {})[0] ?? 'member_unknown';
        await ack({
          response_action: 'errors',
          errors: {
            [firstBlock]: 'This review expired — close and log the expense again.',
          },
        });
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

      await finalizeReviewCommit(reviewId, () =>
        commitExpense({
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
        }),
      );

      await ack();
    } catch (error) {
      logger.error('[actions] custom_split submit failed:', error);
      const firstBlock = Object.keys(view.state?.values ?? {})[0];
      await ack({
        response_action: 'errors',
        errors: {
          [firstBlock ?? 'member_unknown']: "Couldn't save that split — adjust amounts and try again.",
        },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Assistant listener — Settl's native AI surface (split-view container).
// ---------------------------------------------------------------------------
// Handles the Slack Assistant lifecycle: greets the user with Block Kit and
// suggested prompts on open, then routes each message through the Slack AI
// parser to the right flow (log expense, show tab, settle up, or help).
// ---------------------------------------------------------------------------

import pkg from '@slack/bolt';

import { parseExpense } from '../services/expenseParser.js';
import { logExpense } from '../services/expensePipeline.js';
import {
  getGroupByChannel,
  getGroupExpenses,
} from '../services/datastoreService.js';
import { calculateBalances, findDebtBetweenUsers } from '../utils/balanceCalculator.js';
import { parseSettleTarget } from '../utils/groupParser.js';
import { resolveUserHandles } from '../utils/userResolver.js';
import {
  buildAssistantWelcome,
  buildSummaryMessage,
  buildSettleMessage,
  buildErrorMessage,
} from '../utils/formatter.js';

const { Assistant } = pkg;

const NO_GROUP_MESSAGE = buildErrorMessage(
  'No group in this channel yet',
  'Open Settl from a channel that has a group, or run `/settl create [name] @members` there first.',
);

/**
 * Attach the Assistant to the Bolt app.
 * @param {import('@slack/bolt').App} app
 */
export function registerAssistant(app) {
  const assistant = new Assistant({
    threadStarted: async ({ event, say, setSuggestedPrompts, saveThreadContext, logger }) => {
      try {
        const contextChannel = event.assistant_thread?.context?.channel_id;
        const group = contextChannel ? await getGroupByChannel(contextChannel) : null;

        await say({ blocks: buildAssistantWelcome(group), text: "Hi, I'm Settl." });
        await saveThreadContext();

        await setSuggestedPrompts({
          title: 'Try one of these',
          prompts: [
            { title: 'Split a dinner', message: 'Split $84 dinner 3 ways' },
            { title: 'Log in plain English', message: 'I paid forty bucks for groceries' },
            { title: "See who owes what", message: "What's the tab?" },
          ],
        });
      } catch (error) {
        logger.error('[assistant] threadStarted failed:', error);
        await say({
          blocks: buildErrorMessage(
            "Couldn't start Settl",
            'Try closing and reopening the Agent panel from the channel.',
          ),
          text: "Couldn't start Settl.",
        });
      }
    },

    threadContextChanged: async ({ saveThreadContext, logger }) => {
      try {
        await saveThreadContext();
      } catch (error) {
        logger.error('[assistant] threadContextChanged failed:', error);
      }
    },

    userMessage: async ({ message, client, say, setStatus, getThreadContext, logger }) => {
      logger.info('[assistant] userMessage received:', message.text, 'subtype:', message.subtype);
      if (message.subtype) return;

      try {
        const threadContext = await getThreadContext();
        const contextChannel = threadContext?.channel_id;

        if (!contextChannel) {
          await say({
            blocks: buildErrorMessage(
              'Which channel?',
              "I couldn't tell which channel's tab you mean. Open Settl from inside a channel that has a group.",
            ),
            text: 'Open Settl from a channel with a group.',
          });
          return;
        }

        await setStatus('is thinking…');

        const parsed = await parseExpense(message.text ?? '', {
          channelId: contextChannel,
          authorId: message.user,
        });

        switch (parsed.intent) {
          case 'summary':
            await respondWithSummary({ contextChannel, say });
            break;

          case 'settle':
            await respondWithSettle({
              contextChannel,
              messageText: message.text ?? '',
              userId: message.user,
              client,
              say,
              parsed,
            });
            break;

          case 'log_expense':
            await logExpense({
              text: message.text ?? '',
              channelId: contextChannel,
              userId: message.user,
              client,
              parsed,
              assistantChannelId: message.channel,
              assistantThreadTs: message.thread_ts ?? message.ts,
              reply: (payload) => say(payload),
              setStatus: (status) => setStatus(status),
              logger,
            });
            break;

          default:
            await respondWithHelp({ contextChannel, say });
        }
      } catch (error) {
        logger.error('[assistant] userMessage failed:', error);
        await say({
          blocks: buildErrorMessage(
            'Something went wrong',
            "I couldn't process that. Try rephrasing, e.g. `Split $84 dinner 3 ways`.",
          ),
          text: "I couldn't process that.",
        });
      } finally {
        await setStatus('').catch(() => {});
      }
    },
  });

  app.assistant(assistant);

  // Fallback for non-threaded DMs (e.g. typing directly in the App Home Messages tab)
  app.message(async ({ message, client, say, logger }) => {
    // Ignore threaded messages (Assistant handles those) and non-IMs
    if (message.thread_ts || message.channel_type !== 'im' || message.subtype) return;

    try {
      const parsed = await parseExpense(message.text ?? '', {
        channelId: message.channel,
        authorId: message.user,
      });

      switch (parsed.intent) {
        case 'summary':
          await respondWithSummary({ contextChannel: message.channel, say });
          break;
        case 'settle':
          await respondWithSettle({
            contextChannel: message.channel,
            messageText: message.text ?? '',
            userId: message.user,
            client,
            say,
            parsed,
          });
          break;
        case 'log_expense':
          await logExpense({
            text: message.text ?? '',
            channelId: message.channel, // DMs don't have groups, so this will cleanly return "No group in this channel"
            userId: message.user,
            client,
            parsed,
            assistantChannelId: message.channel,
            reply: (payload) => say(payload),
            logger,
          });
          break;
        default:
          await respondWithHelp({ contextChannel: null, say });
      }
    } catch (error) {
      logger.error('[assistant] fallback message failed:', error);
    }
  });
}

/**
 * @param {{ contextChannel: string, say: Function }} args
 */
async function respondWithSummary({ contextChannel, say }) {
  const group = await getGroupByChannel(contextChannel);
  if (!group) {
    await say({ blocks: NO_GROUP_MESSAGE, text: 'No group in this channel yet.' });
    return;
  }
  const expenses = await getGroupExpenses(group.group_id);
  const balances = calculateBalances(group, expenses);
  await say({
    blocks: buildSummaryMessage(group, balances, { expenseCount: expenses.length }),
    text: 'Current tab',
  });
}

/**
 * Resolve a settle counterparty from parsed mentions, bare handles, or free text.
 * @param {object} params
 */
async function resolveSettleCounterparty({ messageText, parsed, client }) {
  let counterpartyId = parsed.slackMentions?.[0] ?? null;
  let bareHandle = parsed.bareHandles?.[0] ?? null;

  if (!counterpartyId && !bareHandle) {
    const target = parseSettleTarget(messageText);
    counterpartyId = target.slackUserId;
    bareHandle = target.bareHandle;
  }

  if (!counterpartyId && bareHandle) {
    const { resolved, unresolved } = await resolveUserHandles(client, [bareHandle]);
    if (unresolved.length) {
      return { counterpartyId: null, unresolved: bareHandle };
    }
    counterpartyId = resolved[0];
  }

  return { counterpartyId, unresolved: null };
}

/**
 * @param {object} args
 */
async function respondWithSettle({ contextChannel, messageText, userId, client, say, parsed }) {
  const group = await getGroupByChannel(contextChannel);
  if (!group) {
    await say({ blocks: NO_GROUP_MESSAGE, text: 'No group in this channel yet.' });
    return;
  }

  const { counterpartyId, unresolved } = await resolveSettleCounterparty({
    messageText,
    parsed,
    client,
  });

  if (unresolved) {
    await say({
      blocks: buildErrorMessage(
        'Who to settle with?',
        `Couldn't find \`@${unresolved}\`. @mention them, e.g. _"settle with @phillip"_.`,
      ),
      text: "Couldn't find that person.",
    });
    return;
  }

  if (!counterpartyId) {
    const expenses = await getGroupExpenses(group.group_id);
    const balances = calculateBalances(group, expenses);
    await say({
      blocks: [
        ...buildSummaryMessage(group, balances, { expenseCount: expenses.length }),
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'To settle with someone, say _"settle with @phillip"_ or use `/settl settle @user`.',
            },
          ],
        },
      ],
      text: 'Current tab',
    });
    return;
  }

  if (counterpartyId === userId) {
    await say({
      blocks: buildErrorMessage("Can't settle with yourself", 'Pick someone else from the group.'),
      text: "You can't settle with yourself.",
    });
    return;
  }

  if (!group.members.includes(counterpartyId)) {
    await say({
      blocks: buildErrorMessage(
        'Not in group',
        `<@${counterpartyId}> isn't in *${group.name}*. Run \`/settl members\` to see the roster.`,
      ),
      text: 'Not in group.',
    });
    return;
  }

  const expenses = await getGroupExpenses(group.group_id);
  const balances = calculateBalances(group, expenses);
  const debt = findDebtBetweenUsers(balances, userId, counterpartyId);

  let venmoRecipient;
  if (debt && debt.to === userId) {
    const info = await client.users.info({ user: userId });
    venmoRecipient = info.user?.name ?? null;
  }

  await say({
    blocks: buildSettleMessage({
      group,
      requesterId: userId,
      counterpartyId,
      debt,
      venmoRecipient,
    }),
    text: debt ? 'Settle up' : 'All square',
  });
}

/**
 * @param {{ contextChannel: string, say: Function }} args
 */
async function respondWithHelp({ contextChannel, say }) {
  const group = contextChannel ? await getGroupByChannel(contextChannel) : null;
  await say({ blocks: buildAssistantWelcome(group), text: "Here's what I can do." });
}

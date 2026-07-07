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
import { calculateBalances } from '../utils/balanceCalculator.js';
import {
  buildAssistantWelcome,
  buildSummaryMessage,
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
          case 'settle':
            await respondWithSummary({ contextChannel, say });
            return;

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
            return;

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
      }
    },
  });

  app.assistant(assistant);
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
 * @param {{ contextChannel: string, say: Function }} args
 */
async function respondWithHelp({ contextChannel, say }) {
  const group = contextChannel ? await getGroupByChannel(contextChannel) : null;
  await say({ blocks: buildAssistantWelcome(group), text: 'Here\'s what I can do.' });
}

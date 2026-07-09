// ---------------------------------------------------------------------------
// Mention listeners — @Settl expense logging in channels.
// ---------------------------------------------------------------------------
// Handles `app_mention` events (e.g. "@Settl grabbed dinner, $94, split 4 ways").
// The raw text is parsed (Slack AI + regex fallback), converted to a structured
// expense, persisted, optionally synced to Splitwise, and confirmed in-thread
// with a Block Kit summary. Direct messages are handled by the Assistant
// (see listeners/assistant.js) so they aren't double-processed here.
// ---------------------------------------------------------------------------

import { logExpense } from '../services/expensePipeline.js';
import { parseExpense } from '../services/expenseParser.js';
import { buildErrorMessage } from '../utils/formatter.js';

/**
 * Attach the channel @mention handler to the Bolt app.
 * @param {import('@slack/bolt').App} app
 */
export function registerMentionListeners(app) {
  // Fired when a user @mentions the Settl bot in a channel.
  app.event('app_mention', async ({ event, client, say, context, logger }) => {
    try {
      const parsed = await parseExpense(event.text ?? '', {
        channelId: event.channel,
        authorId: event.user,
        botUserId: context.botUserId,
      });

      if (parsed.intent !== 'log_expense') {
        // Not an expense, but they mentioned the bot in a channel.
        // For now, just silently ignore or give a generic help message,
        // since the slash command handles /settl summary.
        await say({
          thread_ts: event.ts,
          text: "Hi! To see the tab or settle up, you can use the `/settl` command or DM me directly. To log an expense, include an amount (e.g. `@Settl split $50 dinner`).",
        });
        return;
      }

      await logExpense({
        text: event.text,
        channelId: event.channel,
        userId: event.user,
        client,
        botUserId: context.botUserId,
        threadTs: event.ts,
        assistantChannelId: event.channel,
        assistantThreadTs: event.thread_ts ?? event.ts,
        reply: (payload) => say(payload),
        parsed, // pass the parsed object so logExpense doesn't parse again
        logger,
      });
    } catch (error) {
      logger.error('[mentions] app_mention handler failed:', error);
      await say({
        thread_ts: event.ts,
        blocks: buildErrorMessage(
          "Couldn't log that",
          "Mind rephrasing? Try `@Settl split $84 dinner 3 ways`.",
        ),
        text: "Sorry — I couldn't log that expense.",
      });
    }
  });
}

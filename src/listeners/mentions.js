// ---------------------------------------------------------------------------
// Mention listeners — the primary, zero-friction expense input surface.
// ---------------------------------------------------------------------------
// Handles `app_mention` events (e.g. "@Settl grabbed dinner, $94, split 4 ways")
// and 1:1 DM messages. The raw text is handed to the Slack AI parser, converted
// to a structured expense, persisted, optionally synced to Splitwise, and
// confirmed back to the user in-thread with a Block Kit summary.
// ---------------------------------------------------------------------------

import { logExpense } from '../services/expensePipeline.js';

/**
 * Attach mention/DM handlers to the Bolt app.
 * @param {import('@slack/bolt').App} app
 */
export function registerMentionListeners(app) {
  // Fired when a user @mentions the Settl bot in a channel.
  app.event('app_mention', async ({ event, client, say, context, logger }) => {
    try {
      await logExpense({
        text: event.text,
        channelId: event.channel,
        userId: event.user,
        client,
        botUserId: context.botUserId,
        threadTs: event.ts,
        reply: (payload) => say(payload),
        logger,
      });
    } catch (error) {
      logger.error('[mentions] app_mention handler failed:', error);
      await say({
        thread_ts: event.ts,
        text: "Sorry — I couldn't log that expense. Mind rephrasing it?",
      });
    }
  });

  // Fired for direct messages to the bot (im). Enables private, 1:1 logging.
  app.message(async ({ message, client, say, context, logger }) => {
    // Ignore bot echoes, edits, and non-standard message subtypes.
    if (message.subtype || message.bot_id) return;
    try {
      await logExpense({
        text: message.text ?? '',
        channelId: message.channel,
        userId: message.user,
        client,
        botUserId: context.botUserId,
        threadTs: message.ts,
        reply: (payload) => say(payload),
        logger,
      });
    } catch (error) {
      logger.error('[mentions] DM handler failed:', error);
      await say({ text: "Sorry — I couldn't log that expense. Mind rephrasing it?" });
    }
  });
}

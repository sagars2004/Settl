// ---------------------------------------------------------------------------
// Interaction reply helpers — post follow-ups in the right Slack surface.
// ---------------------------------------------------------------------------
// In the Assistant split-view, `respond()` often routes to the app's Messages
// tab instead of the active assistant thread. These helpers always post back
// into the same thread the user clicked from.
// ---------------------------------------------------------------------------

/**
 * Post a follow-up message in the interaction's thread (Assistant-safe).
 * @param {object} args
 * @param {import('@slack/web-api').WebClient} args.client
 * @param {object} args.body  Slack interaction payload
 * @param {(payload: object) => Promise<void>} args.respond  Bolt respond()
 * @param {object} args.payload  blocks/text/etc.
 */
export async function postFollowUp({ client, body, respond, payload }) {
  const channel = body.channel?.id;
  const threadTs = body.message?.thread_ts ?? body.container?.thread_ts;

  if (channel && threadTs) {
    return client.chat.postMessage({ channel, thread_ts: threadTs, ...payload });
  }

  return respond({ replace_original: false, ...payload });
}

/**
 * Replace the message that contained the clicked button (e.g. review card).
 * @param {object} args
 * @param {import('@slack/web-api').WebClient} args.client
 * @param {object} args.body
 * @param {object} args.payload
 */
export async function updateSourceMessage({ client, body, payload }) {
  const channel = body.channel?.id;
  const ts = body.message?.ts;

  if (channel && ts) {
    return client.chat.update({ channel, ts, ...payload });
  }
}

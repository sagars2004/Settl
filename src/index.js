// ---------------------------------------------------------------------------
// Settl — App entry point
// ---------------------------------------------------------------------------
// Boots the Bolt for JavaScript app, wires up every listener group (mentions,
// slash commands, Block Kit actions, assistant), starts the proactive nudge
// scheduler, and begins listening for Slack events (Socket Mode by default).
// ---------------------------------------------------------------------------

import 'dotenv/config';
import pkg from '@slack/bolt';

import { registerMentionListeners } from './listeners/mentions.js';
import { registerCommandListeners } from './listeners/commands.js';
import { registerActionListeners } from './listeners/actions.js';
import { startNudgeAgent } from './agents/nudgeAgent.js';

const { App, LogLevel } = pkg;

// Instantiate the Bolt app. Socket Mode lets us run locally without a public
// HTTP endpoint; flip SLACK_SOCKET_MODE to "false" to serve over HTTP + ngrok.
const socketMode = process.env.SLACK_SOCKET_MODE !== 'false';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode,
  appToken: socketMode ? process.env.SLACK_APP_TOKEN : undefined,
  logLevel: process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
});

// Register every listener group. Each module attaches its own handlers to the
// shared `app` instance so that wiring lives close to the feature it serves.
registerMentionListeners(app); // @Settl natural-language expense logging
registerCommandListeners(app); // /settl slash command subcommands
registerActionListeners(app); // Block Kit button interactions

// Global error handler — keeps a single expense failure from crashing the app.
app.error(async (error) => {
  // TODO: forward to structured logging / error reporting once observability
  // is wired up. For now, surface to the console.
  console.error('[settl] Uncaught listener error:', error);
});

// Boot sequence.
(async () => {
  const port = Number(process.env.PORT) || 3000;
  await app.start(socketMode ? undefined : port);

  // Kick off the background scheduler that pings channels with aging balances.
  startNudgeAgent(app);

  console.log(
    `⚡️ Settl is running (${socketMode ? 'Socket Mode' : `HTTP :${port}`})`,
  );
})();

export { app };

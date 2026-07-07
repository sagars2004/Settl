// ---------------------------------------------------------------------------
// Settl — App entry point
// ---------------------------------------------------------------------------
// Boots the Bolt for JavaScript app, wires up every listener group (mentions,
// slash commands, Block Kit actions, assistant), starts the proactive nudge
// scheduler, and begins listening for Slack events (Socket Mode by default).
// ---------------------------------------------------------------------------

import { config } from 'dotenv';
import pkg from '@slack/bolt';

import { registerMentionListeners } from './listeners/mentions.js';
import { registerCommandListeners } from './listeners/commands.js';
import { registerActionListeners } from './listeners/actions.js';
import { registerAssistant } from './listeners/assistant.js';
import { startNudgeAgent } from './agents/nudgeAgent.js';
import { bindDatastoreClient } from './services/datastoreClient.js';
import { registerOAuthRoutes } from './routes/oauth.js';

const { App, LogLevel } = pkg;

// Load .env without overriding tokens the Slack CLI injects during `slack run`.
config({ override: false });

// Prefer CLI-injected tokens (slack run) over .env placeholders.
const botToken = process.env.SLACK_CLI_XOXB ?? process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_CLI_XAPP ?? process.env.SLACK_APP_TOKEN;

if (!botToken || !appToken) {
  console.warn(
    '[settl] Missing bot/app token. When using `slack run`, leave SLACK_BOT_TOKEN and SLACK_APP_TOKEN blank in .env so the CLI can inject them.',
  );
}

// Socket Mode avoids a public HTTP endpoint during local dev.
const socketMode = process.env.SLACK_SOCKET_MODE !== 'false';

const app = new App({
  token: botToken,
  ...(process.env.SLACK_SIGNING_SECRET
    ? { signingSecret: process.env.SLACK_SIGNING_SECRET }
    : {}),
  socketMode,
  appToken: socketMode ? appToken : undefined,
  logLevel: process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
});

// Register every listener group. Each module attaches its own handlers to the
// shared `app` instance so that wiring lives close to the feature it serves.
registerMentionListeners(app); // @Settl natural-language expense logging
registerCommandListeners(app); // /settl slash command subcommands
registerActionListeners(app); // Block Kit button interactions
registerAssistant(app); // Slack Assistant (AI split-view surface)

if (!socketMode) {
  registerOAuthRoutes(app);
}

// Wire the Slack WebClient into the datastore layer.
bindDatastoreClient(app.client);

// Global error handler — keeps a single expense failure from crashing the app.
app.error(async (error) => {
  // TODO: forward to structured logging / error reporting once observability
  // is wired up. For now, surface to the console.
  console.error('[settl] Uncaught listener error:', error);
});

// Boot sequence.
(async () => {
  if (socketMode) {
    await app.start();
  } else {
    const port = Number(process.env.PORT) || 3000;
    await app.start(port);
  }

  // Kick off the background scheduler that pings channels with aging balances.
  startNudgeAgent(app);

  console.log(
    `⚡️ Settl is running (${socketMode ? 'Socket Mode' : `HTTP :${process.env.PORT || 3000}`})`,
  );
})();

export { app };

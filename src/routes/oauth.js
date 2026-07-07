// ---------------------------------------------------------------------------
// Splitwise OAuth callback — HTTP redirect handler for OAuth completion.
// ---------------------------------------------------------------------------

import { completeSplitwiseOAuth } from '../services/splitwiseMCP.js';

/**
 * Register the Splitwise OAuth callback route on the Bolt receiver.
 * @param {import('@slack/bolt').App} app
 */
export function registerOAuthRoutes(app) {
  app.receiver.router.get('/oauth/splitwise/callback', async (req, res) => {
    const code = req.query.code;
    const slackUserId = req.query.state;

    if (!code || !slackUserId) {
      res.status(400).send('Missing code or state.');
      return;
    }

    try {
      const result = await completeSplitwiseOAuth(String(slackUserId), String(code));
      res.send(
        `Splitwise linked for ${result.firstName}. You can close this tab and return to Slack.`,
      );
    } catch (error) {
      res.status(500).send(`Splitwise link failed: ${error.message}`);
    }
  });
}

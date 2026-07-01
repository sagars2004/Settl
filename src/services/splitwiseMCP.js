// ---------------------------------------------------------------------------
// Splitwise MCP client — bidirectional expense/settlement sync.
// ---------------------------------------------------------------------------
// Thin wrapper around the Splitwise MCP server (tarunn2799/splitwise-mcp).
// Connects over the MCP protocol and exposes the handful of tools Settl needs:
//   - create_splitwise_expense   push a new expense to Splitwise
//   - fetch_friends_data         resolve @mentions -> Splitwise friend ids
//   - get_expenses_last_n_days   recent history for summaries
//   - create_splitwise_group     mirror a Settl group in Splitwise
// OAuth tokens are stored per user in the Slack Datastore.
// ---------------------------------------------------------------------------

import { getUserToken, saveUserToken } from './datastoreService.js';

// Lazily-initialized MCP client singleton.
let mcpClient = null;

/**
 * Establish (or reuse) a connection to the Splitwise MCP server.
 * @returns {Promise<object>} the connected MCP client
 */
async function getMcpClient() {
  if (mcpClient) return mcpClient;
  // TODO: instantiate the MCP SDK client and connect to SPLITWISE_MCP_URL.
  //   const client = new Client({ name: 'settl', version: '1.0.0' });
  //   await client.connect(new StreamableHTTPClientTransport(new URL(process.env.SPLITWISE_MCP_URL)));
  //   mcpClient = client;
  return mcpClient;
}

/**
 * Push a locally-logged expense to Splitwise for a linked user.
 * No-op (resolves) when the user has not connected Splitwise.
 * @param {object} expense  A persisted settl_expenses record.
 * @param {string} slackUserId
 */
export async function syncExpenseToSplitwise(expense, slackUserId) {
  const token = await getUserToken(slackUserId);
  if (!token?.splitwise_access_token) return; // user hasn't linked Splitwise

  const client = await getMcpClient();
  // TODO: await client.callTool({ name: 'create_splitwise_expense', arguments: {...} });
  return { synced: false, expenseId: expense?.expense_id, client: !!client };
}

/**
 * Mark a settlement as resolved on the Splitwise side.
 * @param {string} groupId
 * @param {string} counterpartyId
 */
export async function syncSettlementToSplitwise(groupId, counterpartyId) {
  const client = await getMcpClient();
  // TODO: call the appropriate settle/expense-update MCP tool.
  return { synced: false, groupId, counterpartyId, client: !!client };
}

/**
 * Resolve Slack @mentions to Splitwise friend ids.
 * @param {string} slackUserId  the requesting (linked) user
 * @returns {Promise<Array>}
 */
export async function fetchFriends(slackUserId) {
  const client = await getMcpClient();
  // TODO: await client.callTool({ name: 'fetch_friends_data', arguments: {} });
  return [];
}

/**
 * Fetch recent Splitwise expenses to enrich summaries.
 * @param {string} slackUserId
 * @param {number} days
 */
export async function getRecentSplitwiseExpenses(slackUserId, days = 30) {
  const client = await getMcpClient();
  // TODO: await client.callTool({ name: 'get_expenses_last_n_days', arguments: { days } });
  return [];
}

/**
 * Begin the Splitwise OAuth 2.0 flow for a Slack user.
 * @param {string} slackUserId
 * @returns {Promise<string>} the authorization URL to present to the user
 */
export async function startSplitwiseOAuth(slackUserId) {
  // TODO: build the Splitwise authorize URL with SPLITWISE_CONSUMER_KEY,
  // a redirect URI, and a `state` value encoding `slackUserId`.
  return `https://secure.splitwise.com/oauth/authorize?client_id=${process.env.SPLITWISE_CONSUMER_KEY ?? ''}&state=${slackUserId}`;
}

/**
 * Complete OAuth: exchange the code for a token and persist it.
 * Invoked by the OAuth redirect handler (to be added when serving over HTTP).
 * @param {string} slackUserId
 * @param {string} code
 */
export async function completeSplitwiseOAuth(slackUserId, code) {
  // TODO: exchange `code` at Splitwise's token endpoint using the consumer
  // secret, then persist the access token.
  await saveUserToken(slackUserId, { splitwise_access_token: 'TODO', splitwise_user_id: 'TODO' });
}

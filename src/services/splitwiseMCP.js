// ---------------------------------------------------------------------------
// Splitwise integration — OAuth, REST API sync, optional MCP client.
// ---------------------------------------------------------------------------
// Per-user OAuth tokens live in settl_user_tokens. Expense sync uses the
// Splitwise REST API with the payer's token. When SPLITWISE_MCP_URL is set,
// an MCP client is also available for friend/group resolution tools.
// ---------------------------------------------------------------------------

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getUserToken, saveUserToken, updateExpense, getGroup } from './datastoreService.js';

const SPLITWISE_API = 'https://secure.splitwise.com/api/v3.0';
const SPLITWISE_OAUTH_AUTHORIZE = 'https://secure.splitwise.com/oauth/authorize';
const SPLITWISE_OAUTH_TOKEN = 'https://secure.splitwise.com/oauth/token';

let mcpClient = null;
let mcpConnectPromise = null;

function redirectUri() {
  return (
    process.env.SPLITWISE_REDIRECT_URI ||
    `http://localhost:${process.env.PORT || 3000}/oauth/splitwise/callback`
  );
}

function isConfigured() {
  const key = process.env.SPLITWISE_CONSUMER_KEY;
  return Boolean(key && key !== '...');
}

/**
 * @param {string} accessToken
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function splitwiseFetch(accessToken, path, init = {}) {
  const response = await fetch(`${SPLITWISE_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(10000),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Splitwise API ${response.status}: ${formatSplitwiseErrors(body)}`);
  }
  if (body?.errors && Object.keys(body.errors).length) {
    throw new Error(`Splitwise API error: ${formatSplitwiseErrors(body)}`);
  }
  return body;
}

/**
 * @param {object} body
 */
function formatSplitwiseErrors(body) {
  if (body?.errors) {
    if (Array.isArray(body.errors)) {
      return body.errors.map((err) => err.message ?? JSON.stringify(err)).join('; ');
    }
    if (typeof body.errors === 'object') {
      return Object.entries(body.errors)
        .map(([key, value]) => `${key}: ${value}`)
        .join('; ');
    }
  }
  return body?.error ?? 'Bad Request';
}

/**
 * Establish (or reuse) a connection to the Splitwise MCP server.
 * @returns {Promise<object|null>}
 */
async function getMcpClient() {
  const url = process.env.SPLITWISE_MCP_URL;
  if (!url) return null;

  if (mcpClient) return mcpClient;
  if (mcpConnectPromise) return mcpConnectPromise;

  mcpConnectPromise = (async () => {
    const client = new Client({ name: 'settl', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    mcpClient = client;
    return client;
  })().catch((error) => {
    mcpConnectPromise = null;
    console.warn('[splitwiseMCP] MCP connect failed:', error.message);
    return null;
  });

  return mcpConnectPromise;
}

/**
 * @param {object} client
 * @param {string} name
 * @param {object} args
 */
async function callMcpTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((part) => part.type === 'text')?.text;
  if (!text) return result.structuredContent ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Map Settl splits to Splitwise user shares.
 * @param {object} expense
 * @param {string} payerSlackId
 * @param {object} payerToken
 * @param {import('@slack/web-api').WebClient} [client]
 */
async function buildSplitwiseUsers(expense, payerSlackId, payerToken, client) {
  const users = [];

  for (const split of expense.splits ?? []) {
    const owedShare = Number(split.amount).toFixed(2);
    const paidShare =
      split.user_id === payerSlackId ? Number(expense.total_amount).toFixed(2) : '0.00';

    let splitwiseUserId = null;
    if (split.user_id === payerSlackId) {
      splitwiseUserId = Number(payerToken.splitwise_user_id);
    } else {
      const memberToken = await getUserToken(split.user_id);
      if (memberToken?.splitwise_user_id) {
        splitwiseUserId = Number(memberToken.splitwise_user_id);
      }
    }

    if (splitwiseUserId) {
      users.push({ user_id: splitwiseUserId, paid_share: paidShare, owed_share: owedShare });
      continue;
    }

    if (client) {
      const info = await client.users.info({ user: split.user_id });
      const profile = info.user?.profile ?? {};
      const email = profile.email;
      if (email) {
        const [firstName = 'Friend', ...rest] = (info.user?.real_name ?? 'Friend').split(' ');
        users.push({
          email,
          first_name: profile.first_name || firstName,
          last_name: profile.last_name || rest.join(' '),
          paid_share: paidShare,
          owed_share: owedShare,
        });
        continue;
      }
    }

    throw new Error(
      `<@${split.user_id}> is not linked to Splitwise and has no email visible to Settl`,
    );
  }

  return users;
}

/**
 * Flatten user shares into Splitwise's users__{index}__{field} request shape.
 * @param {object} payload
 * @param {object[]} users
 */
function appendUsersToPayload(payload, users) {
  users.forEach((user, index) => {
    for (const [key, value] of Object.entries(user)) {
      payload[`users__${index}__${key}`] = value;
    }
  });
  return payload;
}

/**
 * Push a locally-logged expense to Splitwise for a linked user.
 * @param {object} expense  A persisted settl_expenses record.
 * @param {string} slackUserId
 * @param {import('@slack/web-api').WebClient} [client]
 */
export async function syncExpenseToSplitwise(expense, slackUserId, client) {
  const token = await getUserToken(slackUserId);
  if (!token?.splitwise_access_token) return { synced: false, reason: 'not_linked' };

  const group = await getGroup(expense.group_id);
  const cost = Number(expense.total_amount).toFixed(2);
  const description = expense.description || 'Settl expense';
  const currency_code = expense.currency || 'USD';

  let payload;
  if (group?.splitwise_group_id) {
    payload = {
      cost,
      description,
      currency_code,
      group_id: Number(group.splitwise_group_id),
      split_equally: true,
    };
  } else {
    const users = await buildSplitwiseUsers(expense, slackUserId, token, client);
    payload = appendUsersToPayload(
      {
        cost,
        description,
        currency_code,
        group_id: 0,
      },
      users,
    );
  }

  const body = await splitwiseFetch(token.splitwise_access_token, '/create_expense', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  const splitwiseExpenseId = body?.expenses?.[0]?.id ?? body?.expense?.id ?? null;
  if (splitwiseExpenseId && expense.expense_id) {
    await updateExpense(expense.expense_id, {
      splitwise_expense_id: String(splitwiseExpenseId),
    });
  }

  return { synced: true, splitwiseExpenseId, via: 'rest' };
}

/**
 * Best-effort settlement sync — Splitwise ledger is updated locally; no remote call yet.
 * @param {string} groupId
 * @param {string} debtorId
 */
export async function syncSettlementToSplitwise(groupId, debtorId) {
  return { synced: false, groupId, debtorId };
}

/**
 * Resolve Slack @mentions to Splitwise friend ids via MCP (when available).
 * @param {string} slackUserId
 * @returns {Promise<Array>}
 */
export async function fetchFriends(slackUserId) {
  const token = await getUserToken(slackUserId);
  if (!token?.splitwise_access_token) return [];

  try {
    const body = await splitwiseFetch(token.splitwise_access_token, '/get_friends');
    return body?.friends ?? [];
  } catch {
    const client = await getMcpClient();
    if (!client) return [];
    return callMcpTool(client, 'get-friends', {}) ?? [];
  }
}

/**
 * Fetch recent Splitwise expenses for summaries.
 * @param {string} slackUserId
 * @param {number} days
 */
export async function getRecentSplitwiseExpenses(slackUserId, days = 30) {
  const token = await getUserToken(slackUserId);
  if (!token?.splitwise_access_token) return [];

  const datedAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const body = await splitwiseFetch(
    token.splitwise_access_token,
    `/get_expenses?dated_after=${encodeURIComponent(datedAfter)}&limit=50`,
  );
  return body?.expenses ?? [];
}

/**
 * Begin the Splitwise OAuth 2.0 flow for a Slack user.
 * @param {string} slackUserId
 * @returns {Promise<string|null>}
 */
export async function startSplitwiseOAuth(slackUserId) {
  if (!isConfigured()) {
    return null;
  }

  const params = new URLSearchParams({
    client_id: process.env.SPLITWISE_CONSUMER_KEY,
    redirect_uri: redirectUri(),
    response_type: 'code',
    state: slackUserId,
  });

  return `${SPLITWISE_OAUTH_AUTHORIZE}?${params.toString()}`;
}

/**
 * Exchange an OAuth code for a token and persist it.
 * @param {string} slackUserId
 * @param {string} code
 */
export async function completeSplitwiseOAuth(slackUserId, code) {
  if (!isConfigured()) {
    throw new Error('Splitwise OAuth is not configured. Set SPLITWISE_CONSUMER_KEY and SPLITWISE_CONSUMER_SECRET.');
  }

  const body = new URLSearchParams({
    client_id: process.env.SPLITWISE_CONSUMER_KEY,
    client_secret: process.env.SPLITWISE_CONSUMER_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  });

  const response = await fetch(SPLITWISE_OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error ?? `Splitwise token exchange failed (${response.status})`);
  }

  const currentUser = await splitwiseFetch(data.access_token, '/get_current_user');
  const splitwiseUserId = String(currentUser?.user?.id ?? '');

  await saveUserToken(slackUserId, {
    splitwise_access_token: data.access_token,
    splitwise_user_id: splitwiseUserId,
  });

  return { splitwiseUserId, firstName: currentUser?.user?.first_name ?? 'user' };
}

/**
 * Check whether a Slack user has linked Splitwise.
 * @param {string} slackUserId
 */
export async function isSplitwiseLinked(slackUserId) {
  const token = await getUserToken(slackUserId);
  return Boolean(token?.splitwise_access_token);
}

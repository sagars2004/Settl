// ---------------------------------------------------------------------------
// Datastore service — CRUD helpers over Slack Datastores.
// ---------------------------------------------------------------------------
// Wraps the apps.datastore.* Web API methods (put / get / query / delete) for
// the three datastores defined in datastores/schema.js:
//   - settl_groups        expense groups bound to channels
//   - settl_expenses      individual logged expenses + splits
//   - settl_user_tokens   per-user Splitwise OAuth tokens
// Every function is a stub returning shapes matching the PRD data model.
// ---------------------------------------------------------------------------

import { DATASTORES } from '../../datastores/schema.js';

/**
 * Generate a short, prefixed id (e.g. "grp_ab12cd", "exp_9f8e7d").
 * @param {string} prefix
 * @returns {string}
 */
function generateId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- Groups (settl_groups) --------------------------------------------------

/**
 * Create a new expense group bound to a channel.
 * @param {{ name: string, channelId: string, members: string[], baseCurrency?: string }} input
 * @returns {Promise<object>} the created settl_groups record
 */
export async function createGroup({ name, channelId, members, baseCurrency }) {
  const record = {
    group_id: generateId('grp'),
    name,
    channel_id: channelId,
    members,
    base_currency: baseCurrency || process.env.DEFAULT_BASE_CURRENCY || 'USD',
    created_at: new Date().toISOString(),
    splitwise_group_id: null,
  };
  // TODO: await client.apps.datastore.put({ datastore: DATASTORES.GROUPS, item: record });
  return record;
}

/**
 * Look up the group associated with a Slack channel.
 * @param {string} channelId
 * @returns {Promise<object|null>}
 */
export async function getGroupByChannel(channelId) {
  // TODO: query DATASTORES.GROUPS with an expression on `channel_id`.
  return null;
}

/**
 * List members for a group (returns Slack user ids).
 * @param {string} groupId
 * @returns {Promise<string[]>}
 */
export async function listGroupMembers(groupId) {
  // TODO: get the group record and return its `members` array.
  return [];
}

// --- Expenses (settl_expenses) ----------------------------------------------

/**
 * Persist a parsed expense to the ledger.
 * @param {object} parsed  Output of expenseParser (+ resolved groupId).
 * @returns {Promise<object>} the created settl_expenses record
 */
export async function createExpense(parsed) {
  const record = {
    expense_id: generateId('exp'),
    group_id: parsed.groupId ?? null,
    description: parsed.description ?? '',
    total_amount: parsed.amount ?? 0,
    currency: parsed.currency ?? 'USD',
    paid_by: parsed.paidBy ?? null,
    splits: parsed.customSplits ?? [],
    created_at: new Date().toISOString(),
    settled: false,
    splitwise_expense_id: null,
  };
  // TODO: await client.apps.datastore.put({ datastore: DATASTORES.EXPENSES, item: record });
  return record;
}

/**
 * Fetch all expenses for a group.
 * @param {string} groupId
 * @returns {Promise<object[]>}
 */
export async function getGroupExpenses(groupId) {
  if (!groupId) return [];
  // TODO: query DATASTORES.EXPENSES on `group_id`.
  return [];
}

/**
 * Mark all outstanding expenses between the current user and a counterparty
 * as settled.
 * @param {string} groupId
 * @param {string} counterpartyId
 */
export async function markBalanceSettled(groupId, counterpartyId) {
  // TODO: query the relevant expenses and put updated `settled: true` records.
  return { groupId, counterpartyId, settled: true };
}

// --- User tokens (settl_user_tokens) ----------------------------------------

/**
 * Fetch a user's stored Splitwise token record.
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function getUserToken(userId) {
  // TODO: get DATASTORES.USER_TOKENS by primary key `user_id`.
  return null;
}

/**
 * Persist a user's Splitwise token record.
 * @param {string} userId
 * @param {{ splitwise_access_token: string, splitwise_user_id: string }} token
 */
export async function saveUserToken(userId, token) {
  const record = { user_id: userId, ...token };
  // TODO: await client.apps.datastore.put({ datastore: DATASTORES.USER_TOKENS, item: record });
  return record;
}

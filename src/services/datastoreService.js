// ---------------------------------------------------------------------------
// Datastore service — CRUD helpers over Slack Datastores.
// ---------------------------------------------------------------------------
// Wraps apps.datastore.* for settl_groups, settl_expenses, and
// settl_user_tokens. Requires bindDatastoreClient() before use.
// ---------------------------------------------------------------------------

import { DATASTORES } from '../../datastores/schema.js';
import { getItem, putItem, queryItems } from './datastoreClient.js';

/**
 * Generate a short, prefixed id (e.g. "grp_ab12cd", "exp_9f8e7d").
 * @param {string} prefix
 * @returns {string}
 */
function generateId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

/** @param {object|null|undefined} item */
function hydrateGroup(item) {
  if (!item) return null;
  return {
    ...item,
    members: item.members ?? [],
    splitwise_group_id: item.splitwise_group_id || null,
  };
}

/** @param {object} item */
function hydrateExpense(item) {
  let splits = [];
  if (item.splits_json) {
    try {
      splits = JSON.parse(item.splits_json);
    } catch {
      splits = [];
    }
  }
  return {
    ...item,
    splits,
    settled: Boolean(item.settled),
    splitwise_expense_id: item.splitwise_expense_id || null,
  };
}

// --- Groups (settl_groups) --------------------------------------------------

/**
 * Create a new expense group bound to a channel.
 * @param {{ name: string, channelId: string, members: string[], baseCurrency?: string }} input
 * @returns {Promise<object>} the created settl_groups record
 */
export async function createGroup({ name, channelId, members, baseCurrency }) {
  const existing = await getGroupByChannel(channelId);
  if (existing) {
    const err = new Error(`A group already exists for this channel: "${existing.name}"`);
    err.code = 'group_exists';
    err.group = existing;
    throw err;
  }

  const record = {
    group_id: generateId('grp'),
    name,
    channel_id: channelId,
    members: [...new Set(members)],
    base_currency: baseCurrency || process.env.DEFAULT_BASE_CURRENCY || 'USD',
    created_at: new Date().toISOString(),
    splitwise_group_id: '',
  };

  await putItem(DATASTORES.GROUPS, record);
  return hydrateGroup(record);
}

/**
 * Fetch a group by primary key.
 * @param {string} groupId
 * @returns {Promise<object|null>}
 */
export async function getGroup(groupId) {
  if (!groupId) return null;
  const item = await getItem(DATASTORES.GROUPS, groupId);
  return hydrateGroup(item);
}

/**
 * Look up the group associated with a Slack channel.
 * @param {string} channelId
 * @returns {Promise<object|null>}
 */
export async function getGroupByChannel(channelId) {
  if (!channelId) return null;
  const items = await queryItems(DATASTORES.GROUPS, {
    expression: '#channel_id = :channel_id',
    expression_attributes: { '#channel_id': 'channel_id' },
    expression_values: { ':channel_id': channelId },
  });
  return hydrateGroup(items[0] ?? null);
}

/**
 * List all groups (used by the nudge agent sweep).
 * @returns {Promise<object[]>}
 */
export async function listGroups() {
  const items = await queryItems(DATASTORES.GROUPS, {});
  return items.map(hydrateGroup);
}

/**
 * List members for a group (returns Slack user ids).
 * @param {string} groupId
 * @returns {Promise<string[]>}
 */
export async function listGroupMembers(groupId) {
  const group = await getGroup(groupId);
  return group?.members ?? [];
}

// --- Expenses (settl_expenses) ----------------------------------------------

/**
 * Persist a parsed expense to the ledger.
 * @param {object} parsed  Output of expenseParser (+ resolved groupId).
 * @returns {Promise<object>} the created settl_expenses record
 */
export async function createExpense(parsed) {
  const splits = parsed.customSplits ?? parsed.splits ?? [];
  const record = {
    expense_id: generateId('exp'),
    group_id: parsed.groupId ?? '',
    description: parsed.description ?? '',
    total_amount: parsed.amount ?? 0,
    currency: parsed.currency ?? 'USD',
    paid_by: parsed.paidBy ?? '',
    splits_json: JSON.stringify(splits),
    created_at: new Date().toISOString(),
    settled: false,
    splitwise_expense_id: '',
  };

  await putItem(DATASTORES.EXPENSES, record);
  return hydrateExpense(record);
}

/**
 * Fetch all expenses for a group.
 * @param {string} groupId
 * @returns {Promise<object[]>}
 */
export async function getGroupExpenses(groupId) {
  if (!groupId) return [];
  const items = await queryItems(DATASTORES.EXPENSES, {
    expression: '#group_id = :group_id',
    expression_attributes: { '#group_id': 'group_id' },
    expression_values: { ':group_id': groupId },
  });
  return items.map(hydrateExpense);
}

/**
 * Mark all outstanding expenses involving a counterparty as settled.
 * @param {string} groupId
 * @param {string} counterpartyId
 */
export async function markBalanceSettled(groupId, counterpartyId) {
  const expenses = await getGroupExpenses(groupId);
  const toSettle = expenses.filter(
    (exp) =>
      !exp.settled &&
      (exp.paid_by === counterpartyId ||
        exp.splits.some((s) => s.user_id === counterpartyId)),
  );

  for (const expense of toSettle) {
    await putItem(DATASTORES.EXPENSES, {
      ...expense,
      splits_json: JSON.stringify(expense.splits),
      settled: true,
    });
  }

  return { groupId, counterpartyId, settledCount: toSettle.length };
}

// --- User tokens (settl_user_tokens) ----------------------------------------

/**
 * Fetch a user's stored Splitwise token record.
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function getUserToken(userId) {
  if (!userId) return null;
  return getItem(DATASTORES.USER_TOKENS, userId);
}

/**
 * Persist a user's Splitwise token record.
 * @param {string} userId
 * @param {{ splitwise_access_token: string, splitwise_user_id: string }} token
 */
export async function saveUserToken(userId, token) {
  const record = { user_id: userId, ...token };
  await putItem(DATASTORES.USER_TOKENS, record);
  return record;
}

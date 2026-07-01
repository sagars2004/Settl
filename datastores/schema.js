// ---------------------------------------------------------------------------
// Datastore schema definitions.
// ---------------------------------------------------------------------------
// Declares the three Slack Datastores backing Settl. These definitions double
// as documentation for datastoreService.js and can be merged into the Slack app
// manifest's `datastores` block when deploying via the Slack CLI.
//
// Datastore attribute types follow Slack's supported set: "string", "integer",
// "double", "boolean", "array", "object", "timestamp".
// ---------------------------------------------------------------------------

// Canonical datastore names referenced throughout the app.
export const DATASTORES = {
  GROUPS: 'settl_groups',
  EXPENSES: 'settl_expenses',
  USER_TOKENS: 'settl_user_tokens',
};

// settl_groups — an expense group bound to a Slack channel.
export const settlGroups = {
  name: DATASTORES.GROUPS,
  primary_key: 'group_id',
  attributes: {
    group_id: { type: 'string' },
    name: { type: 'string' },
    channel_id: { type: 'string' },
    members: { type: 'array', items: { type: 'string' } },
    base_currency: { type: 'string' },
    created_at: { type: 'string' }, // ISO 8601 timestamp
    splitwise_group_id: { type: 'string' }, // nullable
  },
};

// settl_expenses — a single logged expense with its per-user splits.
export const settlExpenses = {
  name: DATASTORES.EXPENSES,
  primary_key: 'expense_id',
  attributes: {
    expense_id: { type: 'string' },
    group_id: { type: 'string' },
    description: { type: 'string' },
    total_amount: { type: 'double' },
    currency: { type: 'string' },
    paid_by: { type: 'string' },
    splits: { type: 'array', items: { type: 'object' } }, // { user_id, amount }
    created_at: { type: 'string' },
    settled: { type: 'boolean' },
    splitwise_expense_id: { type: 'string' }, // nullable
  },
};

// settl_user_tokens — per-user Splitwise OAuth credentials.
export const settlUserTokens = {
  name: DATASTORES.USER_TOKENS,
  primary_key: 'user_id',
  attributes: {
    user_id: { type: 'string' },
    splitwise_access_token: { type: 'string' }, // store encrypted at rest
    splitwise_user_id: { type: 'string' },
  },
};

// Convenience export for manifest generation / bulk registration.
export const ALL_DATASTORES = [settlGroups, settlExpenses, settlUserTokens];

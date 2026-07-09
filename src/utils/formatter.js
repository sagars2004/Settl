// ---------------------------------------------------------------------------
// Formatter — Block Kit message builders.
// ---------------------------------------------------------------------------
// Centralizes all Slack UI construction so listeners stay logic-focused. Each
// builder returns an array of Block Kit blocks. Interactive buttons use the
// shared ACTION_IDS from listeners/actions.js so clicks route correctly.
// ---------------------------------------------------------------------------

import { ACTION_IDS, VIEW_IDS } from '../listeners/actions.js';

/**
 * Format a currency amount for display.
 * @param {string} currency
 * @param {number} amount
 */
export function formatMoney(currency, amount) {
  const symbolMap = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
  const symbol = symbolMap[currency] ?? `${currency} `;
  const formatted = Number(amount).toFixed(2).replace(/\.00$/, '');
  return `${symbol}${formatted}`;
}

/**
 * Build a short context badge line describing how the expense was processed.
 * @param {{ parsedVia?: 'ai'|'regex', splitwise?: object, conversion?: object }} meta
 * @returns {string}
 */
function buildBadges(meta = {}) {
  const badges = [];
  if (meta.parsedVia === 'ai') badges.push(':sparkles: Parsed by Slack AI');
  if (meta.conversion?.fxFallback) {
    badges.push(':warning: FX rate unavailable — used 1:1 estimate');
  }
  if (meta.splitwise?.synced) {
    const via = meta.splitwise.via === 'mcp' ? 'Splitwise MCP' : 'Splitwise';
    badges.push(`:white_check_mark: Synced to ${via}`);
  } else if (meta.splitwise?.reason === 'error') {
    badges.push(':warning: Splitwise sync skipped');
  } else if (meta.splitwise?.reason === 'not_linked') {
    badges.push(':information_source: Logged locally — Splitwise not linked');
  }
  return badges.join('  ·  ');
}

/**
 * Format the FX conversion subtitle for confirmation/review cards.
 * @param {object} conversion
 * @param {string} targetCurrency
 * @returns {string|null}
 */
function formatConversionLine(conversion, targetCurrency) {
  if (
    !conversion?.originalCurrency ||
    conversion.originalCurrency === targetCurrency ||
    conversion.originalAmount == null
  ) {
    return null;
  }
  if (conversion.fxFallback) {
    return `_Converted from ${formatMoney(conversion.originalCurrency, conversion.originalAmount)} · :warning: live rate unavailable (1:1 estimate)_`;
  }
  return `_Converted from ${formatMoney(conversion.originalCurrency, conversion.originalAmount)} · rate ${conversion.fxRate}_`;
}

/**
 * Confirmation shown after an expense is logged (posted in-thread).
 * @param {object} expense   persisted settl_expenses record
 * @param {import('./balanceCalculator.js').BalanceResult} balances
 * @param {object} [group]   settl_groups record
 * @param {{ conversion?: object, parsedVia?: 'ai'|'regex', splitwise?: object }} [meta]
 * @returns {object[]} Block Kit blocks
 */
export function buildExpenseConfirmation(expense, balances, group, meta = {}) {
  const { conversion } = meta;
  const currency = expense.currency;
  const payers = new Set(expense.payers ?? []);

  const payerLine = `• <@${expense.paid_by}> paid *${formatMoney(currency, expense.total_amount)}*`;

  const shareLines = (expense.splits ?? [])
    .filter((split) => split.user_id !== expense.paid_by && split.amount >= 0.01)
    .map((split) => {
      if (payers.has(split.user_id)) {
        return `• <@${split.user_id}> :credit_card: already paid _(portion ${formatMoney(currency, split.amount)})_`;
      }
      return `• <@${split.user_id}> owes *${formatMoney(currency, split.amount)}*`;
    });

  const payerShare = (expense.splits ?? []).find((split) => split.user_id === expense.paid_by);
  const payerNet =
    payerShare && payerShare.amount > 0
      ? Number((expense.total_amount - payerShare.amount).toFixed(2))
      : null;
  const payerNetLine =
    payerNet != null && payerNet >= 0.01
      ? `• <@${expense.paid_by}> nets *${formatMoney(currency, payerNet)}* after their portion`
      : null;

  const splitText = [payerLine, payerNetLine, ...shareLines].filter(Boolean).join('\n');

  const conversionLine = formatConversionLine(conversion, currency);

  const headline = conversionLine
    ? `:receipt: Logged *${formatMoney(currency, expense.total_amount)}* — _${expense.description}_\n${conversionLine}`
    : `:receipt: Logged *${formatMoney(currency, expense.total_amount)}* — _${expense.description}_`;

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: headline } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `*This expense*\n${splitText}` } },
  ];

  const tabLines = (balances.netBalances ?? [])
    .filter((entry) => Math.abs(entry.net) >= 0.01)
    .map((entry) =>
      entry.net > 0
        ? `• <@${entry.userId}> is owed *${formatMoney(currency, entry.net)}*`
        : `• <@${entry.userId}> owes *${formatMoney(currency, Math.abs(entry.net))}*`,
    );

  if (tabLines.length) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Running tab — ${group?.name ?? 'This channel'}*\n${tabLines.join('\n')}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View full tab', emoji: true },
            action_id: ACTION_IDS.VIEW_TAB,
            value: JSON.stringify({ groupId: group?.group_id }),
          },
        ],
      },
    );
  }

  const badges = buildBadges({ ...meta, conversion });
  if (badges) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: badges }] });
  }

  return blocks;
}

/**
 * Full balance summary for `/settl summary`.
 * @param {object|null} group
 * @param {import('./balanceCalculator.js').BalanceResult} balances
 * @param {{ expenseCount?: number }} [options]
 * @returns {object[]}
 */
export function buildSummaryMessage(group, balances, options = {}) {
  const currency = group?.base_currency ?? 'USD';
  const debts = balances.debts ?? [];
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Tab — ${group?.name ?? 'This channel'}`, emoji: true },
    },
  ];

  if (debts.length) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:bar_chart: *${debts.length} outstanding balance${debts.length === 1 ? '' : 's'}*`,
      },
    });
    blocks.push({ type: 'divider' });

    for (const debt of debts) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:money_with_wings: <@${debt.from}> → <@${debt.to}>\n*${formatMoney(currency, debt.amount)}*`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Settle', emoji: true },
          style: 'primary',
          action_id: ACTION_IDS.SUMMARY_SETTLE,
          value: JSON.stringify({
            groupId: group.group_id,
            debtorId: debt.from,
            creditorId: debt.to,
          }),
        },
      });
    }
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':tada: *Everyone is square* — no outstanding balances.',
      },
    });
  }

  const contextParts = [];
  if (options.expenseCount != null) {
    const count = options.expenseCount;
    contextParts.push(`${count} expense${count === 1 ? '' : 's'} logged`);
  }
  contextParts.push(`Base currency ${currency}`);

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: contextParts.join('  ·  ') }],
  });

  return blocks;
}

/**
 * Interactive review card shown before logging when no @mentions were provided.
 * @param {object} params
 * @param {string} params.reviewId
 * @param {object} params.group
 * @param {number} params.amount
 * @param {string} params.currency
 * @param {string} params.description
 * @param {string} params.paidBy
 * @param {string[]} params.selectedMembers  Slack user ids included in the split
 * @param {object} [params.conversion]
 * @returns {object[]}
 */
export function buildExpenseReviewMessage({
  reviewId,
  group,
  amount,
  currency,
  description,
  paidBy,
  payers = [],
  consumers = [],
  selectedMembers,
  conversion,
}) {
  const payerSet = new Set(payers);
  const selected = new Set(selectedMembers);
  const consumerCount = consumers.length || group.members?.length || 1;
  const perShare = formatMoney(currency, amount / consumerCount);
  const owingCount = selectedMembers.length;

  const conversionLine = formatConversionLine(conversion, currency);

  const headline = conversionLine
    ? `:memo: *Review expense* — ${formatMoney(currency, amount)} _${description}_\n${conversionLine}`
    : `:memo: *Review expense* — ${formatMoney(currency, amount)} _${description}_`;

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: headline } },
    { type: 'divider' },
  ];

  if (payers.length) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Already paid*\n${payers.map((id) => `:credit_card: <@${id}>`).join('  ')}`,
      },
    });
    blocks.push({ type: 'divider' });
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Who still owes?* Tap to include or exclude.\n_Share is *${perShare}* each among ${consumerCount} · ${owingCount} ${owingCount === 1 ? 'person' : 'people'} selected_`,
    },
  });

  for (const memberId of group.members ?? []) {
    if (payerSet.has(memberId)) continue;

    const included = selected.has(memberId);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: included ? `:white_check_mark: <@${memberId}>` : `:white_large_square: <@${memberId}>`,
      },
      accessory: {
        type: 'button',
        text: {
          type: 'plain_text',
          text: included ? 'Owes share' : 'Excluded',
          emoji: true,
        },
        action_id: ACTION_IDS.TOGGLE_PARTICIPANT,
        value: JSON.stringify({ reviewId, memberId }),
      },
    });
  }

  blocks.push(
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Split equally', emoji: true },
          style: 'primary',
          action_id: ACTION_IDS.CONFIRM_EQUAL_SPLIT,
          value: JSON.stringify({ reviewId }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Custom amounts…', emoji: true },
          action_id: ACTION_IDS.OPEN_CUSTOM_SPLIT,
          value: JSON.stringify({ reviewId }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel', emoji: true },
          action_id: ACTION_IDS.CANCEL_REVIEW,
          value: JSON.stringify({ reviewId }),
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `<@${paidBy}> paid · Group *${group.name}*`,
        },
      ],
    },
  );

  return blocks;
}

/**
 * Modal for per-person custom split amounts.
 * @param {object} draft  pending review draft
 * @returns {object}
 */
export function buildCustomSplitModal({
  reviewId,
  amount,
  currency,
  selectedMembers,
  consumers = [],
  memberNames = {},
}) {
  const consumerCount = consumers.length || selectedMembers.length || 1;
  const perPerson = amount / consumerCount;

  const blocks = selectedMembers.map((userId) => ({
    type: 'input',
    block_id: `member_${userId}`,
    label: {
      type: 'plain_text',
      text: memberNames[userId] ?? `Member ${userId.slice(-6)}`,
    },
    element: {
      type: 'plain_text_input',
      action_id: 'amount',
      initial_value: perPerson.toFixed(2),
    },
  }));

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `Total should equal *${formatMoney(currency, amount)}*. Adjust any share, then submit.`,
    },
  });

  return {
    type: 'modal',
    callback_id: VIEW_IDS.CUSTOM_SPLIT,
    private_metadata: JSON.stringify({ reviewId }),
    title: { type: 'plain_text', text: 'Custom split' },
    submit: { type: 'plain_text', text: 'Log expense' },
    close: { type: 'plain_text', text: 'Back' },
    blocks,
  };
}

/**
 * Settle-up prompt for `/settl settle @user`, with action buttons.
 * @param {object} params
 * @param {object} params.group
 * @param {string} params.requesterId
 * @param {string} params.counterpartyId
 * @param {import('./balanceCalculator.js').PairwiseDebt|null} params.debt
 * @param {string} [params.venmoRecipient]  Venmo username of whoever receives payment
 * @returns {object[]}
 */
export function buildSettleMessage({ group, requesterId, counterpartyId, debt, venmoRecipient }) {
  const currency = group?.base_currency ?? 'USD';

  if (!debt) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `You're all square with <@${counterpartyId}>. :handshake:`,
        },
      },
    ];
  }

  const counterpartyOwesRequester =
    debt.from === counterpartyId && debt.to === requesterId;
  const summaryText = counterpartyOwesRequester
    ? `<@${counterpartyId}> owes you *${formatMoney(currency, debt.amount)}*.`
    : `You owe <@${counterpartyId}> *${formatMoney(currency, debt.amount)}*.`;

  const venmoPayee = counterpartyOwesRequester ? venmoRecipient : null;

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Settle up', emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: summaryText },
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Mark as Settled' },
          style: 'primary',
          action_id: ACTION_IDS.MARK_SETTLED,
          value: JSON.stringify({
            groupId: group.group_id,
            debtorId: debt.from,
            creditorId: debt.to,
          }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Send Venmo Request' },
          action_id: ACTION_IDS.SEND_VENMO,
          value: JSON.stringify({
            username: venmoPayee ?? null,
            amount: debt.amount,
            note: 'Settl',
          }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Dismiss' },
          action_id: ACTION_IDS.DISMISS,
          value: 'dismiss',
        },
      ],
    },
  ];
}

/**
 * Roster for `/settl members`.
 * @param {object|null} group
 * @param {string[]} members  Slack user ids
 * @returns {object[]}
 */
export function buildMembersMessage(group, members = []) {
  if (!group) {
    return [
      { type: 'header', text: { type: 'plain_text', text: 'No group yet' } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Run `/settl create [name] @member1 @member2` to set up a group in this channel.',
        },
      },
    ];
  }

  return [
    { type: 'header', text: { type: 'plain_text', text: `Members — ${group.name}` } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${members.length} member${members.length === 1 ? '' : 's'} · base currency ${group.base_currency ?? 'USD'}`,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: members.length
          ? members.map((id) => `• <@${id}>`).join('\n')
          : 'No members yet. Add them with `/settl create [name] @user`.',
      },
    },
  ];
}

/**
 * Confirmation after `/settl create`.
 * @param {object} group  persisted settl_groups record
 * @param {string[]} [unresolvedHandles]  @handles that could not be matched
 * @returns {object[]}
 */
export function buildGroupCreatedMessage(group, unresolvedHandles = []) {
  const memberLines = (group.members ?? []).map((id) => `• <@${id}>`).join('\n');
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:tada: Created group *${group.name}* in this channel.`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Members (${group.members?.length ?? 0}):*\n${memberLines}`,
      },
    },
  ];

  if (unresolvedHandles.length) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Could not find ${unresolvedHandles.map((h) => `@${h}`).join(', ')}. Pick users from Slack's @ menu when typing the command.`,
        },
      ],
    });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Log expenses with `@Settl` or `/settl add`.' }],
  });

  return blocks;
}

/**
 * Proactive nudge message body.
 * @param {string} totalOutstanding  formatted total (e.g. "$340")
 * @returns {object[]}
 */
export function buildNudgeMessage(totalOutstanding) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:wave: Hey team — you've got *${totalOutstanding}* in unresolved expenses. Run \`/settl summary\` to review.`,
      },
    },
  ];
}

/**
 * A consistent error card so failures never appear as bare strings.
 * @param {string} title
 * @param {string} message  mrkdwn body
 * @returns {object[]}
 */
export function buildErrorMessage(title, message) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `:warning: *${title}*` } },
    { type: 'section', text: { type: 'mrkdwn', text: message } },
  ];
}

/**
 * Welcome shown when a user opens the Settl Assistant container.
 * @param {object|null} group  group bound to the context channel, if any
 * @returns {object[]}
 */
export function buildAssistantWelcome(group) {
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: ':wave: *Hi, I\'m Settl.* I turn plain-English messages into a shared tab.' } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          'Try things like:',
          '• _"Split $84 dinner 3 ways"_',
          '• _"I paid forty bucks for groceries"_',
          '• _"What\'s the tab?"_',
        ].join('\n'),
      },
    },
  ];

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: group
          ? `Tracking *${group.name}* · ${group.members?.length ?? 0} members`
          : 'No group here yet — run `/settl create [name] @members` in the channel first.',
      },
    ],
  });

  return blocks;
}

/**
 * Splitwise connect card with a link button (native, not a raw URL wall).
 * @param {string|null} authUrl
 * @param {boolean} [alreadyLinked]
 * @returns {object[]}
 */
export function buildConnectMessage(authUrl, alreadyLinked = false) {
  if (alreadyLinked) {
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: ':link: *Splitwise is already linked.* Expenses you pay will sync automatically.' },
      },
    ];
  }

  if (!authUrl) {
    return buildErrorMessage(
      'Splitwise not configured',
      'Set `SPLITWISE_CONSUMER_KEY` and `SPLITWISE_CONSUMER_SECRET` in `.env`, then try again.',
    );
  }

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: ':link: *Link your Splitwise account* to sync expenses you pay.' },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Authorize Splitwise', emoji: true },
        style: 'primary',
        url: authUrl,
        action_id: ACTION_IDS.OPEN_SPLITWISE,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'After authorizing, copy the `code` from the redirect URL and run `/settl connect splitwise <code>`.',
        },
      ],
    },
  ];
}

/**
 * Help / usage message shown for unknown or empty subcommands.
 * @returns {object[]}
 */
export function buildHelpMessage() {
  return [
    { type: 'header', text: { type: 'plain_text', text: 'Settl — commands' } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '`@Settl <expense>` — log in plain English',
          '`/settl add <expense>` — log via slash command',
          '`/settl summary` — view the running tab',
          '`/settl settle @user` — settle a balance',
          '`/settl create [name] @a @b` — create a group',
          '`/settl members` — list group members',
          '`/settl connect splitwise` — link Splitwise',
          '`/settl remind [frequency]` — set nudge cadence',
          '`/settl reset` — delete this channel\'s group (dev)',
        ].join('\n'),
      },
    },
  ];
}

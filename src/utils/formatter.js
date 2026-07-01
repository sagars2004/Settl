// ---------------------------------------------------------------------------
// Formatter — Block Kit message builders.
// ---------------------------------------------------------------------------
// Centralizes all Slack UI construction so listeners stay logic-focused. Each
// builder returns an array of Block Kit blocks. Interactive buttons use the
// shared ACTION_IDS from listeners/actions.js so clicks route correctly.
// ---------------------------------------------------------------------------

import { ACTION_IDS } from '../listeners/actions.js';

/**
 * Confirmation shown after an expense is logged (posted in-thread).
 * @param {object} expense   persisted settl_expenses record
 * @param {import('./balanceCalculator.js').BalanceResult} balances
 * @returns {object[]} Block Kit blocks
 */
export function buildExpenseConfirmation(expense, balances) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:white_check_mark: Logged *${expense.currency} ${expense.total_amount}* — _${expense.description}_`,
      },
    },
    // TODO: render per-member split lines and the updated running tab.
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Tap `/settl summary` to see the full tab.' }] },
  ];
}

/**
 * Full balance summary for `/settl summary`.
 * @param {object|null} group
 * @param {import('./balanceCalculator.js').BalanceResult} balances
 * @returns {object[]}
 */
export function buildSummaryMessage(group, balances) {
  return [
    { type: 'header', text: { type: 'plain_text', text: `Tab — ${group?.name ?? 'This channel'}` } },
    // TODO: list each debt as "A owes B $X" from balances.debts.
    { type: 'section', text: { type: 'mrkdwn', text: 'No outstanding balances yet.' } },
  ];
}

/**
 * Settle-up prompt for `/settl settle @user`, with action buttons.
 * @param {string} counterparty  raw @mention / user token
 * @param {import('./balanceCalculator.js').BalanceResult} balances
 * @returns {object[]}
 */
export function buildSettleMessage(counterparty, balances) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `Settling up with ${counterparty || 'user'}.` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Mark as Settled' },
          style: 'primary',
          action_id: ACTION_IDS.MARK_SETTLED,
          // TODO: encode { groupId, counterpartyId } once resolved.
          value: JSON.stringify({ groupId: null, counterpartyId: null }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Send Venmo Request' },
          action_id: ACTION_IDS.SEND_VENMO,
          value: JSON.stringify({ username: null, amount: null, note: 'Settl' }),
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

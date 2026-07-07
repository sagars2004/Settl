// ---------------------------------------------------------------------------
// Slash command listeners — the structured `/settl <subcommand>` surface.
// ---------------------------------------------------------------------------
// Slack delivers all subcommands under a single `/settl` command. We parse the
// leading token (add, summary, settle, create, members, connect, remind) and
// dispatch to the matching handler. Each handler is stubbed for now.
// ---------------------------------------------------------------------------

import {
  getGroupByChannel,
  createGroup,
  getGroupExpenses,
  listGroupMembers,
  resetGroupByChannel,
} from '../services/datastoreService.js';
import { calculateBalances, findDebtBetweenUsers } from '../utils/balanceCalculator.js';
import {
  buildSummaryMessage,
  buildSettleMessage,
  buildMembersMessage,
  buildGroupCreatedMessage,
  buildConnectMessage,
  buildHelpMessage,
} from '../utils/formatter.js';
import { parseCreateGroupArgs, parseSettleTarget } from '../utils/groupParser.js';
import { resolveUserHandles } from '../utils/userResolver.js';
import { startSplitwiseOAuth, completeSplitwiseOAuth, isSplitwiseLinked } from '../services/splitwiseMCP.js';
import { logExpense } from '../services/expensePipeline.js';
import { setReminderCadence } from '../agents/nudgeAgent.js';

/**
 * Attach the `/settl` command router to the Bolt app.
 * @param {import('@slack/bolt').App} app
 */
export function registerCommandListeners(app) {
  app.command('/settl', async ({ command, ack, respond, client, logger }) => {
    logger.info(`[commands] received /settl text="${command.text}"`);

    // Acknowledge within 3s to satisfy Slack's slash-command contract.
    await ack();

    const [subcommand, ...rest] = command.text.trim().split(/\s+/);
    const args = rest.join(' ');

    try {
      switch (subcommand) {
        case 'add':
          await handleAdd({ command, args, respond, client, logger });
          break;
        case 'summary':
          await handleSummary({ command, respond });
          break;
        case 'settle':
          await handleSettle({ command, args, respond, client });
          break;
        case 'create':
          await handleCreate({ command, args, respond, client });
          break;
        case 'members':
          await handleMembers({ command, respond });
          break;
        case 'connect':
          await handleConnect({ command, args, respond });
          break;
        case 'remind':
          await handleRemind({ command, args, respond });
          break;
        case 'reset':
          await handleReset({ command, respond });
          break;
        default:
          await respond({ blocks: buildHelpMessage(), text: 'Settl help' });
      }
    } catch (error) {
      logger.error(`[commands] /settl ${subcommand} failed:`, error);
      await respond({ text: `Something went wrong running \`/settl ${subcommand}\`.` });
    }
  });
}

// --- Subcommand handlers (stubs) --------------------------------------------

/** `/settl add <expense>` — structured alternative to @mention logging. */
async function handleAdd({ command, args, respond, client, logger }) {
  if (!args.trim()) {
    return respond({
      text: 'Usage: `/settl add $84 dinner split 3 ways` — or just `@Settl` in plain English.',
    });
  }

  const result = await logExpense({
    text: args,
    channelId: command.channel_id,
    userId: command.user_id,
    client,
    reply: (payload) => respond(payload),
    logger,
  });

  if (!result.ok) return;
}

/** `/settl summary` — per-channel / per-group balance breakdown. */
async function handleSummary({ command, respond }) {
  const group = await getGroupByChannel(command.channel_id);
  if (!group) {
    return respond({
      text: 'No group in this channel. Run `/settl create [name] @members` first.',
    });
  }

  const expenses = await getGroupExpenses(group.group_id);
  const balances = calculateBalances(group, expenses);
  await respond({
    blocks: buildSummaryMessage(group, balances, { expenseCount: expenses.length }),
    text: 'Current tab',
  });
}

/** `/settl settle @user` — surface a resolvable balance with action buttons. */
async function handleSettle({ command, args, respond, client }) {
  const group = await getGroupByChannel(command.channel_id);
  if (!group) {
    return respond({
      text: 'No group in this channel. Run `/settl create [name] @members` first.',
    });
  }

  const { slackUserId, bareHandle } = parseSettleTarget(args);
  if (!slackUserId && !bareHandle) {
    return respond({ text: 'Usage: `/settl settle @user` — pick someone from the group.' });
  }

  let counterpartyId = slackUserId;
  if (!counterpartyId && bareHandle) {
    const { resolved, unresolved } = await resolveUserHandles(client, [bareHandle]);
    if (unresolved.length) {
      return respond({
        text: `Couldn't find @${bareHandle}. Use Slack's @ menu to pick a user.`,
      });
    }
    counterpartyId = resolved[0];
  }

  if (counterpartyId === command.user_id) {
    return respond({ text: "You can't settle with yourself." });
  }

  if (!group.members.includes(counterpartyId)) {
    return respond({
      text: `<@${counterpartyId}> isn't in *${group.name}*. Run \`/settl members\` to see the roster.`,
    });
  }

  const expenses = await getGroupExpenses(group.group_id);
  const balances = calculateBalances(group, expenses);
  const debt = findDebtBetweenUsers(balances, command.user_id, counterpartyId);

  let venmoRecipient;
  if (debt && debt.to === command.user_id) {
    const userInfo = await client.users.info({ user: command.user_id });
    venmoRecipient = userInfo.user?.name ?? null;
  }

  await respond({
    blocks: buildSettleMessage({
      group,
      requesterId: command.user_id,
      counterpartyId,
      debt,
      venmoRecipient,
    }),
    text: debt ? 'Settle up' : 'All square',
  });
}

/** `/settl create [name] @a @b` — initialize a group bound to this channel. */
async function handleCreate({ command, args, respond, client }) {
  const parsed = parseCreateGroupArgs(args, command.user_id);
  const { resolved, unresolved } = await resolveUserHandles(client, parsed.bareHandles);
  const members = [...new Set([...parsed.members, ...resolved])];

  try {
    const group = await createGroup({
      name: parsed.name,
      channelId: command.channel_id,
      members,
    });

    let text = `Created group ${group.name} with ${group.members.length} members.`;
    if (unresolved.length) {
      text += ` Could not find: ${unresolved.map((h) => `@${h}`).join(', ')}. Use Slack's @ autocomplete to pick users.`;
    }

    await respond({
      blocks: buildGroupCreatedMessage(group, unresolved),
      text,
    });
  } catch (error) {
    if (error.code === 'group_exists') {
      return respond({
        text: `This channel already has a group: *${error.group.name}*. Run \`/settl members\` to see the roster.`,
      });
    }
    throw error;
  }
}

/** `/settl members` — show current roster and per-member totals. */
async function handleMembers({ command, respond }) {
  const group = await getGroupByChannel(command.channel_id);
  const members = group ? await listGroupMembers(group.group_id) : [];
  await respond({
    blocks: buildMembersMessage(group, members),
    text: group ? `Members of ${group.name}` : 'No group in this channel',
  });
}

/** `/settl reset` — delete this channel's group and expenses (for local dev). */
async function handleReset({ command, respond }) {
  const result = await resetGroupByChannel(command.channel_id);
  if (!result.deleted) {
    return respond({ text: 'No group in this channel to reset.' });
  }
  const expenseNote =
    result.expenseCount > 0
      ? ` and ${result.expenseCount} expense${result.expenseCount === 1 ? '' : 's'}`
      : '';
  await respond({
    text: `Reset complete — deleted *${result.groupName}*${expenseNote}. Run \`/settl create\` to start fresh.`,
  });
}

/** `/settl connect splitwise` — kick off the Splitwise OAuth flow. */
async function handleConnect({ command, args, respond }) {
  const parts = args.trim().split(/\s+/);
  const provider = parts[0]?.toLowerCase();
  const code = parts[1];

  if (provider !== 'splitwise') {
    return respond({ text: 'Usage: `/settl connect splitwise` or `/settl connect splitwise <code>`' });
  }

  if (code) {
    try {
      const result = await completeSplitwiseOAuth(command.user_id, code);
      return respond({
        text: `:link: Splitwise linked for *${result.firstName}* (id ${result.splitwiseUserId}). Expenses you log will sync to Splitwise.`,
      });
    } catch (error) {
      return respond({ text: `Couldn't link Splitwise: ${error.message}` });
    }
  }

  if (await isSplitwiseLinked(command.user_id)) {
    return respond({
      blocks: buildConnectMessage(null, true),
      text: 'Splitwise is already linked.',
    });
  }

  const authUrl = await startSplitwiseOAuth(command.user_id);
  await respond({
    blocks: buildConnectMessage(authUrl),
    text: authUrl ? 'Link your Splitwise account' : 'Splitwise is not configured.',
  });
}

/** `/settl remind [frequency]` — configure the proactive nudge cadence. */
async function handleRemind({ command, args, respond }) {
  const cadence = await setReminderCadence(command.channel_id, args);
  if (cadence === null) {
    return respond({ text: 'Nudges turned off for this channel.' });
  }
  const label = args?.trim() || 'daily';
  await respond({ text: `Reminder cadence set to *${label}* for this channel.` });
}

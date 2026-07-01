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
} from '../services/datastoreService.js';
import { calculateBalances } from '../utils/balanceCalculator.js';
import {
  buildSummaryMessage,
  buildSettleMessage,
  buildMembersMessage,
  buildHelpMessage,
} from '../utils/formatter.js';
import { startSplitwiseOAuth } from '../services/splitwiseMCP.js';
import { setReminderCadence } from '../agents/nudgeAgent.js';

/**
 * Attach the `/settl` command router to the Bolt app.
 * @param {import('@slack/bolt').App} app
 */
export function registerCommandListeners(app) {
  app.command('/settl', async ({ command, ack, respond, client, logger }) => {
    // Acknowledge within 3s to satisfy Slack's slash-command contract.
    await ack();

    const [subcommand, ...rest] = command.text.trim().split(/\s+/);
    const args = rest.join(' ');

    try {
      switch (subcommand) {
        case 'add':
          return handleAdd({ command, args, respond });
        case 'summary':
          return handleSummary({ command, respond });
        case 'settle':
          return handleSettle({ command, args, respond });
        case 'create':
          return handleCreate({ command, args, respond, client });
        case 'members':
          return handleMembers({ command, respond });
        case 'connect':
          return handleConnect({ command, args, respond });
        case 'remind':
          return handleRemind({ command, args, respond });
        default:
          return respond({ blocks: buildHelpMessage(), text: 'Settl help' });
      }
    } catch (error) {
      logger.error(`[commands] /settl ${subcommand} failed:`, error);
      await respond({ text: `Something went wrong running \`/settl ${subcommand}\`.` });
    }
  });
}

// --- Subcommand handlers (stubs) --------------------------------------------

/** `/settl add <expense>` — structured alternative to @mention logging. */
async function handleAdd({ command, args, respond }) {
  // TODO: reuse the mention pipeline (parse -> persist -> confirm) with `args`.
  await respond({ text: `TODO: parse and log expense: "${args}"` });
}

/** `/settl summary` — per-channel / per-group balance breakdown. */
async function handleSummary({ command, respond }) {
  const group = await getGroupByChannel(command.channel_id);
  const expenses = await getGroupExpenses(group?.group_id);
  const balances = calculateBalances(group, expenses);
  await respond({ blocks: buildSummaryMessage(group, balances), text: 'Current tab' });
}

/** `/settl settle @user` — surface a resolvable balance with action buttons. */
async function handleSettle({ command, args, respond }) {
  const group = await getGroupByChannel(command.channel_id);
  const expenses = await getGroupExpenses(group?.group_id);
  const balances = calculateBalances(group, expenses);
  // TODO: resolve `args` (@mention) to a user id and filter the balance.
  await respond({ blocks: buildSettleMessage(args, balances), text: 'Settle up' });
}

/** `/settl create [name] @a @b` — initialize a group bound to this channel. */
async function handleCreate({ command, args, respond, client }) {
  // TODO: extract group name and @mentioned members from `args`.
  const group = await createGroup({
    name: args,
    channelId: command.channel_id,
    members: [command.user_id],
  });
  await respond({ text: `Created group "${group?.name ?? args}". Add expenses with @Settl.` });
}

/** `/settl members` — show current roster and per-member totals. */
async function handleMembers({ command, respond }) {
  const group = await getGroupByChannel(command.channel_id);
  const members = await listGroupMembers(group?.group_id);
  await respond({ blocks: buildMembersMessage(group, members), text: 'Group members' });
}

/** `/settl connect splitwise` — kick off the Splitwise OAuth flow. */
async function handleConnect({ command, args, respond }) {
  if (args.toLowerCase() !== 'splitwise') {
    return respond({ text: 'Usage: `/settl connect splitwise`' });
  }
  const authUrl = await startSplitwiseOAuth(command.user_id);
  await respond({ text: `Link your Splitwise account: ${authUrl ?? '<oauth-url>'}` });
}

/** `/settl remind [frequency]` — configure the proactive nudge cadence. */
async function handleRemind({ command, args, respond }) {
  await setReminderCadence(command.channel_id, args);
  await respond({ text: `Reminder cadence set to: ${args || 'default'}` });
}

// ---------------------------------------------------------------------------
// Nudge agent — proactive, agent-initiated reminders.
// ---------------------------------------------------------------------------
// Periodically scans groups for balances that exceed a threshold or have been
// outstanding for X days, then posts a friendly nudge into the channel. Cadence
// is configurable per channel via `/settl remind [frequency]`.
// ---------------------------------------------------------------------------

import { getGroupExpenses, listGroups } from '../services/datastoreService.js';
import { calculateBalances } from '../utils/balanceCalculator.js';
import { buildNudgeMessage, formatMoney } from '../utils/formatter.js';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OUTSTANDING_THRESHOLD = Number(process.env.NUDGE_OUTSTANDING_THRESHOLD) || 50;
const AGE_THRESHOLD_DAYS = Number(process.env.NUDGE_AGE_THRESHOLD_DAYS) || 3;
const MIN_NUDGE_GAP_MS = Number(process.env.NUDGE_MIN_GAP_MS) || 24 * 60 * 60 * 1000;

const channelCadence = new Map(); // channelId -> intervalMs
const disabledChannels = new Set();
const lastNudgedAt = new Map(); // channelId -> timestamp

let sweepTimer = null;
let sweepIntervalMs = DEFAULT_INTERVAL_MS;

/**
 * Start the background scheduler. Called once from index.js after boot.
 * @param {import('@slack/bolt').App} app
 */
export function startNudgeAgent(app) {
  if (sweepTimer) return;
  scheduleSweep(app);
}

/** Stop the scheduler (used in tests / graceful shutdown). */
export function stopNudgeAgent() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

function scheduleSweep(app) {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(() => {
    runSweep(app).catch((err) => console.error('[nudgeAgent] sweep failed:', err));
  }, sweepIntervalMs);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

/**
 * Persist a per-channel reminder cadence.
 * @param {string} channelId
 * @param {string} frequency  e.g. "daily", "weekly", "3d", "off"
 */
export async function setReminderCadence(channelId, frequency) {
  const parsed = parseFrequency(frequency);
  if (parsed === null) {
    channelCadence.delete(channelId);
    disabledChannels.add(channelId);
    return null;
  }
  disabledChannels.delete(channelId);
  channelCadence.set(channelId, parsed);
  return parsed;
}

/**
 * One sweep across all groups: compute balances, nudge those over threshold.
 * @param {import('@slack/bolt').App} app
 */
async function runSweep(app) {
  const groups = await listGroups();
  const now = Date.now();

  for (const group of groups) {
    if (disabledChannels.has(group.channel_id)) continue;

    const cadence = channelCadence.get(group.channel_id);
    const lastNudged = lastNudgedAt.get(group.channel_id) ?? 0;
    const minGap = cadence ?? MIN_NUDGE_GAP_MS;
    if (now - lastNudged < minGap) continue;

    const expenses = await getGroupExpenses(group.group_id);
    const { debts } = calculateBalances(group, expenses);
    const total = debts.reduce((sum, debt) => sum + debt.amount, 0);

    if (!shouldNudge(total, expenses)) continue;

    const currency = group.base_currency ?? 'USD';
    await app.client.chat.postMessage({
      channel: group.channel_id,
      blocks: buildNudgeMessage(formatMoney(currency, total)),
      text: 'You have unresolved expenses.',
    });
    lastNudgedAt.set(group.channel_id, now);
  }
}

/**
 * Decide whether a group warrants a nudge.
 * @param {number} totalOutstanding
 * @param {object[]} expenses
 * @returns {boolean}
 */
function shouldNudge(totalOutstanding, expenses) {
  if (totalOutstanding < 0.01) return false;
  if (totalOutstanding >= OUTSTANDING_THRESHOLD) return true;

  const oldest = oldestUnresolvedExpenseAgeDays(expenses);
  return oldest !== null && oldest >= AGE_THRESHOLD_DAYS;
}

/**
 * @param {object[]} expenses
 * @returns {number|null}
 */
function oldestUnresolvedExpenseAgeDays(expenses) {
  const unsettled = expenses.filter((expense) => {
    if (expense.settled) return false;
    return (expense.splits ?? []).some(
      (split) => split.user_id !== expense.paid_by && !split.settled,
    );
  });

  if (!unsettled.length) return null;

  const oldestMs = unsettled.reduce((min, expense) => {
    const created = Date.parse(expense.created_at ?? '');
    return Number.isFinite(created) ? Math.min(min, created) : min;
  }, Date.now());

  return (Date.now() - oldestMs) / (24 * 60 * 60 * 1000);
}

/**
 * Convert a human frequency string into milliseconds.
 * Returns null when reminders are disabled ("off").
 * @param {string} frequency
 * @returns {number|null}
 */
function parseFrequency(frequency) {
  const value = (frequency || 'daily').trim().toLowerCase();
  if (!value || value === 'default' || value === 'daily') return DEFAULT_INTERVAL_MS;
  if (value === 'off' || value === 'none') return null;
  if (value === 'weekly') return 7 * 24 * 60 * 60 * 1000;

  const shorthand = value.match(/^(\d+)([dh])$/);
  if (shorthand) {
    const amount = Number(shorthand[1]);
    return shorthand[2] === 'h'
      ? amount * 60 * 60 * 1000
      : amount * 24 * 60 * 60 * 1000;
  }

  return DEFAULT_INTERVAL_MS;
}

/** @internal Exposed for tests. */
export { shouldNudge, parseFrequency, oldestUnresolvedExpenseAgeDays };

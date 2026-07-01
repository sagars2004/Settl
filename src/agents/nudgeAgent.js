// ---------------------------------------------------------------------------
// Nudge agent — proactive, agent-initiated reminders.
// ---------------------------------------------------------------------------
// Periodically scans groups for balances that exceed a threshold or have been
// outstanding for X days, then posts a friendly nudge into the channel. Cadence
// is configurable per channel via `/settl remind [frequency]`.
// ---------------------------------------------------------------------------

import { getGroupExpenses } from '../services/datastoreService.js';
import { calculateBalances } from '../utils/balanceCalculator.js';
import { buildNudgeMessage } from '../utils/formatter.js';

// Defaults (overridable per channel and via env in future).
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily sweep
const OUTSTANDING_THRESHOLD = 200; // amount that triggers a nudge
const AGE_THRESHOLD_DAYS = 3; // or age of oldest unresolved expense

// Per-channel cadence overrides set through `/settl remind`.
const channelCadence = new Map(); // channelId -> intervalMs

let sweepTimer = null;

/**
 * Start the background scheduler. Called once from index.js after boot.
 * @param {import('@slack/bolt').App} app
 */
export function startNudgeAgent(app) {
  if (sweepTimer) return; // idempotent
  sweepTimer = setInterval(() => {
    runSweep(app).catch((err) => console.error('[nudgeAgent] sweep failed:', err));
  }, DEFAULT_INTERVAL_MS);
  // Do not keep the process alive solely for this timer.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

/** Stop the scheduler (used in tests / graceful shutdown). */
export function stopNudgeAgent() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

/**
 * Persist a per-channel reminder cadence.
 * @param {string} channelId
 * @param {string} frequency  e.g. "daily", "weekly", "3d"
 */
export async function setReminderCadence(channelId, frequency) {
  // TODO: parse `frequency` into ms and (optionally) persist to the datastore
  // so cadence survives restarts. For now, keep it in memory.
  channelCadence.set(channelId, parseFrequency(frequency));
  return channelCadence.get(channelId);
}

/**
 * One sweep across all groups: compute balances, nudge those over threshold.
 * @param {import('@slack/bolt').App} app
 */
async function runSweep(app) {
  // TODO: enumerate all groups from the datastore (needs a list/query helper).
  const groups = []; // placeholder
  for (const group of groups) {
    const expenses = await getGroupExpenses(group.group_id);
    const { debts } = calculateBalances(group, expenses);
    const total = debts.reduce((sum, d) => sum + d.amount, 0);

    if (shouldNudge(total, expenses)) {
      await app.client.chat.postMessage({
        channel: group.channel_id,
        blocks: buildNudgeMessage(`${group.base_currency} ${total}`),
        text: 'You have unresolved expenses.',
      });
    }
  }
}

/**
 * Decide whether a group warrants a nudge.
 * @param {number} totalOutstanding
 * @param {object[]} expenses
 * @returns {boolean}
 */
function shouldNudge(totalOutstanding, expenses) {
  if (totalOutstanding >= OUTSTANDING_THRESHOLD) return true;
  // TODO: also trigger when the oldest unresolved expense exceeds AGE_THRESHOLD_DAYS.
  return false;
}

/**
 * Convert a human frequency string into milliseconds.
 * @param {string} frequency
 * @returns {number}
 */
function parseFrequency(frequency) {
  switch ((frequency || '').toLowerCase()) {
    case 'daily':
      return 24 * 60 * 60 * 1000;
    case 'weekly':
      return 7 * 24 * 60 * 60 * 1000;
    default:
      // TODO: support shorthand like "3d" / "12h".
      return DEFAULT_INTERVAL_MS;
  }
}

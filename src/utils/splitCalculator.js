// ---------------------------------------------------------------------------
// Split calculator — divide an expense total across participants.
// ---------------------------------------------------------------------------

/**
 * Compute per-user split amounts that sum exactly to `amount`.
 * @param {{ amount: number, splitType: 'equal'|'custom', participants: string[], customSplits?: Array<{userId?: string, user_id?: string, amount: number}> }} input
 * @returns {Array<{ user_id: string, amount: number }>}
 */
export function computeSplits({ amount, splitType, participants, customSplits }) {
  if (splitType === 'custom' && customSplits?.length) {
    return customSplits.map((split) => ({
      user_id: split.user_id ?? split.userId,
      amount: Number(split.amount.toFixed(2)),
      settled: Boolean(split.settled),
    }));
  }

  const ids = [...new Set(participants.filter(Boolean))];
  if (!ids.length) return [];

  const totalCents = Math.round(amount * 100);
  const baseCents = Math.floor(totalCents / ids.length);
  const remainder = totalCents - baseCents * ids.length;

  return ids.map((userId, index) => ({
    user_id: userId,
    amount: (baseCents + (index < remainder ? 1 : 0)) / 100,
    settled: false,
  }));
}

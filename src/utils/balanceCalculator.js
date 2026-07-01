// ---------------------------------------------------------------------------
// Balance calculator — derives "who owes whom" from raw expense records.
// ---------------------------------------------------------------------------
// Pure functions (no I/O) so they're trivially unit-testable. Given a group and
// its expenses, computes net balances per member and simplified pairwise debts
// for display in summaries and settle flows.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MemberBalance
 * @property {string} userId
 * @property {number} net  Positive = others owe them; negative = they owe.
 */

/**
 * @typedef {Object} PairwiseDebt
 * @property {string} from    user id who owes
 * @property {string} to      user id who is owed
 * @property {number} amount  positive amount owed
 */

/**
 * @typedef {Object} BalanceResult
 * @property {MemberBalance[]} netBalances
 * @property {PairwiseDebt[]} debts  Minimized set of transfers to settle up.
 */

/**
 * Compute net balances and simplified debts for a group.
 * @param {object|null} group    settl_groups record (for member roster).
 * @param {object[]} expenses    settl_expenses records.
 * @returns {BalanceResult}
 */
export function calculateBalances(group, expenses = []) {
  const net = new Map(); // userId -> running net balance

  for (const expense of expenses) {
    if (!expense || expense.settled) continue;
    const payer = expense.paid_by;
    // Credit the payer for the full amount they fronted.
    net.set(payer, (net.get(payer) ?? 0) + (expense.total_amount ?? 0));
    // Debit each participant for their share.
    for (const split of expense.splits ?? []) {
      net.set(split.user_id, (net.get(split.user_id) ?? 0) - (split.amount ?? 0));
    }
  }

  const netBalances = [...net.entries()].map(([userId, value]) => ({
    userId,
    net: Number(value.toFixed(2)),
  }));

  return { netBalances, debts: simplifyDebts(netBalances) };
}

/**
 * Reduce net balances to a minimal set of creditor/debtor transfers.
 * @param {MemberBalance[]} netBalances
 * @returns {PairwiseDebt[]}
 */
export function simplifyDebts(netBalances) {
  // TODO: implement greedy debt minimization (largest creditor vs largest
  // debtor). Returns an empty list until the algorithm lands.
  return [];
}

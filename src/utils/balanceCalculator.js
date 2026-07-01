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
    // Debit unsettled shares; settled shares reduce the payer's outstanding credit.
    for (const split of expense.splits ?? []) {
      if (split.settled) {
        net.set(payer, (net.get(payer) ?? 0) - (split.amount ?? 0));
      } else {
        net.set(split.user_id, (net.get(split.user_id) ?? 0) - (split.amount ?? 0));
      }
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
  const creditors = [];
  const debtors = [];

  for (const { userId, net } of netBalances) {
    if (net > 0.005) creditors.push({ userId, amount: net });
    else if (net < -0.005) debtors.push({ userId, amount: -net });
  }

  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const debts = [];
  let i = 0;
  let j = 0;

  while (i < creditors.length && j < debtors.length) {
    const creditor = creditors[i];
    const debtor = debtors[j];
    const amount = Math.min(creditor.amount, debtor.amount);

    if (amount >= 0.01) {
      debts.push({
        from: debtor.userId,
        to: creditor.userId,
        amount: Number(amount.toFixed(2)),
      });
    }

    creditor.amount -= amount;
    debtor.amount -= amount;

    if (creditor.amount < 0.01) i += 1;
    if (debtor.amount < 0.01) j += 1;
  }

  return debts;
}

/**
 * Find the simplified debt between two users, if any.
 * @param {BalanceResult} balances
 * @param {string} userA
 * @param {string} userB
 * @returns {PairwiseDebt|null}
 */
export function findDebtBetweenUsers(balances, userA, userB) {
  return (
    balances.debts.find((debt) => debt.from === userA && debt.to === userB) ??
    balances.debts.find((debt) => debt.from === userB && debt.to === userA) ??
    null
  );
}

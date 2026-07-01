// ---------------------------------------------------------------------------
// Expense validator — guardrails before persisting an expense.
// ---------------------------------------------------------------------------

/**
 * @param {object} parsed
 * @param {object|null} group
 * @returns {{ ok: true, participants: string[] } | { ok: false, error: string }}
 */
export function validateExpense(parsed, group) {
  if (!group) {
    return {
      ok: false,
      error: 'No group in this channel. Run `/settl create [name] @members` first.',
    };
  }

  if (!parsed.amount || parsed.amount <= 0) {
    return {
      ok: false,
      error: "I couldn't find an amount. Try something like `@Settl split $84 dinner`.",
    };
  }

  if (!parsed.paidBy) {
    return { ok: false, error: 'Could not determine who paid for this expense.' };
  }

  const members = new Set(group.members ?? []);
  if (!members.has(parsed.paidBy)) {
    return {
      ok: false,
      error: "You aren't in this group's member list. Ask someone to re-create the group with you included.",
    };
  }

  const participants = parsed.participants?.length ? parsed.participants : [...members];
  if (!participants.length) {
    return {
      ok: false,
      error: 'No one to split with. Add members with `/settl create [name] @user`.',
    };
  }

  for (const userId of participants) {
    if (!members.has(userId)) {
      return {
        ok: false,
        error: `<@${userId}> isn't a member of *${group.name}*.`,
      };
    }
  }

  if (parsed.waysCount && participants.length !== parsed.waysCount) {
    return {
      ok: false,
      error: `You said *${parsed.waysCount} ways* but ${participants.length} ${participants.length === 1 ? 'person is' : 'people are'} splitting. Mention who's in or match the group size (${members.size}).`,
    };
  }

  return { ok: true, participants };
}

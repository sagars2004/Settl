// ---------------------------------------------------------------------------
// Venmo deep-link generator — lightweight settlement, no API required.
// ---------------------------------------------------------------------------
// For users without Splitwise, Settl generates a pre-filled Venmo deep link so
// a payment is one tap away. No OAuth, no integration overhead.
//   venmo://paycharge?txn=pay&recipients=<user>&amount=<amt>&note=Settl
// ---------------------------------------------------------------------------

/**
 * Build a pre-filled Venmo payment deep link.
 * @param {{ username: string, amount: number, note?: string, txn?: 'pay'|'charge' }} params
 * @returns {string} a venmo:// deep link
 */
export function buildVenmoLink({ username, amount, note = 'Settl', txn = 'pay' }) {
  const query = new URLSearchParams({
    txn,
    recipients: username ?? '',
    amount: amount != null ? String(amount) : '',
    note,
  });
  return `venmo://paycharge?${query.toString()}`;
}

/**
 * Web fallback for desktop clients where the app scheme won't open.
 * @param {{ username: string, amount: number, note?: string, txn?: 'pay'|'charge' }} params
 * @returns {string} an https://venmo.com link
 */
export function buildVenmoWebLink({ username, amount, note = 'Settl', txn = 'pay' }) {
  const query = new URLSearchParams({ txn, amount: amount != null ? String(amount) : '', note });
  return `https://venmo.com/${encodeURIComponent(username ?? '')}?${query.toString()}`;
}

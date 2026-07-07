// ---------------------------------------------------------------------------
// Pending expense store — in-memory drafts awaiting split confirmation.
// ---------------------------------------------------------------------------
// When a user logs an expense without @mentions, we show a review card first.
// The draft lives here until they confirm equal split or submit custom amounts.
// ---------------------------------------------------------------------------

const TTL_MS = 30 * 60 * 1000;
/** @type {Map<string, object>} */
const pending = new Map();

function pruneExpired() {
  const now = Date.now();
  for (const [id, draft] of pending) {
    if (now - draft.createdAt > TTL_MS) pending.delete(id);
  }
}

/**
 * @param {object} draft
 * @returns {string} reviewId
 */
export function createPendingReview(draft) {
  pruneExpired();
  const reviewId = `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pending.set(reviewId, { ...draft, createdAt: Date.now() });
  return reviewId;
}

/** @param {string} reviewId */
export function getPendingReview(reviewId) {
  pruneExpired();
  return pending.get(reviewId) ?? null;
}

/**
 * @param {string} reviewId
 * @param {object} patch
 */
export function updatePendingReview(reviewId, patch) {
  const existing = getPendingReview(reviewId);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  pending.set(reviewId, updated);
  return updated;
}

/** @param {string} reviewId */
export function deletePendingReview(reviewId) {
  pending.delete(reviewId);
}

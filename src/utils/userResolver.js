// ---------------------------------------------------------------------------
// User resolver — map @handles to Slack user ids via users.list.
// ---------------------------------------------------------------------------
// Slash commands often send plain `@user1` text instead of `<@U123>`. We look
// up workspace members by username, display name, or real name.
// ---------------------------------------------------------------------------

/** @type {import('@slack/web-api').UsersListResponse['members'] | null} */
let cachedUsers = null;

/**
 * Resolve bare @handles (e.g. "user1") to Slack user ids.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string[]} handles
 * @returns {Promise<{ resolved: string[], unresolved: string[] }>}
 */
export async function resolveUserHandles(client, handles) {
  if (!handles.length) {
    return { resolved: [], unresolved: [] };
  }

  const users = await listWorkspaceUsers(client);
  const resolved = [];
  const unresolved = [];

  for (const handle of handles) {
    const user = findUserByHandle(users, handle);
    if (user) resolved.push(user.id);
    else unresolved.push(handle);
  }

  return { resolved, unresolved };
}

/**
 * @param {import('@slack/web-api').WebClient} client
 */
async function listWorkspaceUsers(client) {
  if (cachedUsers) return cachedUsers;

  /** @type {import('@slack/web-api').UsersListResponse['members']} */
  const users = [];
  let cursor;

  do {
    const result = await client.users.list({ limit: 200, cursor });
    users.push(
      ...(result.members ?? []).filter((member) => !member.is_bot && !member.deleted),
    );
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  cachedUsers = users;
  return users;
}

/** Clear cache (useful in tests or long-running dev sessions). */
export function clearUserCache() {
  cachedUsers = null;
}

/**
 * @param {import('@slack/web-api').UsersListResponse['members']} users
 * @param {string} handle
 */
function findUserByHandle(users, handle) {
  const needle = handle.toLowerCase();
  return users.find((user) => {
    const candidates = [
      user.name,
      user.profile?.display_name,
      user.profile?.real_name,
    ];
    return candidates.some((value) => value?.toLowerCase() === needle);
  });
}

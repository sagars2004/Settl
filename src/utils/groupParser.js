// ---------------------------------------------------------------------------
// Group parser — extract group name and @mentioned user ids from slash text.
// ---------------------------------------------------------------------------
// Supports Slack-encoded mentions (<@U123|display>) and plain @handles
// (e.g. @user1) which are resolved separately via users.list.
// ---------------------------------------------------------------------------

export const SLACK_MENTION_PATTERN = /<@(U[A-Z0-9]+)(?:\|[^>]+)?>/g;
export const BARE_MENTION_PATTERN = /(?:^|\s)@([\w.-]+)/g;

/**
 * Parse `/settl create [name] @a @b` into a group name and member user ids.
 * The command author is always included in the member list.
 *
 * @param {string} args       Text after "create" in the slash command.
 * @param {string} creatorId  Slack user id of whoever ran the command.
 * @returns {{ name: string, members: string[], bareHandles: string[] }}
 */
export function parseCreateGroupArgs(args, creatorId) {
  const members = new Set([creatorId]);

  for (const match of args.matchAll(SLACK_MENTION_PATTERN)) {
    members.add(match[1]);
  }

  let remainder = args.replace(SLACK_MENTION_PATTERN, ' ');

  const bareHandles = [];
  for (const match of remainder.matchAll(BARE_MENTION_PATTERN)) {
    bareHandles.push(match[1]);
  }
  remainder = remainder.replace(BARE_MENTION_PATTERN, ' ').replace(/\s+/g, ' ').trim();

  let name = remainder;
  const quoted = name.match(/^["'](.+)["']$/);
  if (quoted) {
    name = quoted[1].trim();
  }

  if (!name) {
    name = 'This channel';
  }

  return { name, members: [...members], bareHandles };
}

/**
 * Parse `/settl settle @user` into a Slack user id or bare handle.
 * @param {string} args  Text after "settle" in the slash command.
 * @returns {{ slackUserId: string|null, bareHandle: string|null }}
 */
export function parseSettleTarget(args) {
  const trimmed = args.trim();
  if (!trimmed) return { slackUserId: null, bareHandle: null };

  const encoded = trimmed.match(/<@(U[A-Z0-9]+)(?:\|[^>]+)?>/);
  if (encoded) return { slackUserId: encoded[1], bareHandle: null };

  const bare = trimmed.match(/@([\w.-]+)/);
  if (bare) return { slackUserId: null, bareHandle: bare[1] };

  if (/^[\w.-]+$/.test(trimmed)) {
    return { slackUserId: null, bareHandle: trimmed };
  }

  return { slackUserId: null, bareHandle: null };
}

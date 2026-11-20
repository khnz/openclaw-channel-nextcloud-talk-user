import { NEXTCLOUD_TALK_CHANNEL_ID, NEXTCLOUD_TALK_CHANNEL_IDENTITY } from "./channel-id.js";

export type NextcloudTalkTarget = { kind: "room"; token: string } | { kind: "user"; userId: string };

/** Channel prefixes accepted in targets: the channel id and its aliases. */
export const NEXTCLOUD_TALK_CHANNEL_PREFIX_RE = new RegExp(
  `^(${[NEXTCLOUD_TALK_CHANNEL_IDENTITY.id, ...NEXTCLOUD_TALK_CHANNEL_IDENTITY.aliases].join("|")}):`,
  "i",
);

function stripChannelPrefix(raw: string): string {
  return raw.trim().replace(NEXTCLOUD_TALK_CHANNEL_PREFIX_RE, "").trim();
}

/**
 * Send target: room token (`<token>`, `room:<token>`) or person (`user:<uid>`,
 * `users/<uid>`), each optionally with a channel prefix.
 * Person ids keep their case (Nextcloud UIDs); room tokens are lowercased.
 */
export function parseNextcloudTalkTarget(raw: string): NextcloudTalkTarget | undefined {
  const value = stripChannelPrefix(raw);
  const user = value.match(/^(?:user:|users\/)(.+)$/i);
  if (user) {
    const userId = user[1]?.trim();
    return userId ? { kind: "user", userId } : undefined;
  }
  const token = value.replace(/^room:/i, "").trim();
  return token ? { kind: "room", token } : undefined;
}

/** Room token without prefixes; undefined for person targets. */
export function stripNextcloudTalkTargetPrefix(raw: string): string | undefined {
  const target = parseNextcloudTalkTarget(raw);
  return target?.kind === "room" ? target.token : undefined;
}

export function normalizeNextcloudTalkMessagingTarget(raw: string): string | undefined {
  const target = parseNextcloudTalkTarget(raw);
  if (!target) {
    return undefined;
  }
  return target.kind === "user"
    ? `${NEXTCLOUD_TALK_CHANNEL_ID}:user:${target.userId}`
    : `${NEXTCLOUD_TALK_CHANNEL_ID}:${target.token}`.toLowerCase();
}

export function looksLikeNextcloudTalkTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (
    NEXTCLOUD_TALK_CHANNEL_PREFIX_RE.test(trimmed) ||
    /^(room|user):/i.test(trimmed) ||
    /^users\//i.test(trimmed)
  ) {
    return true;
  }

  return /^[a-z0-9]{8,}$/i.test(trimmed);
}

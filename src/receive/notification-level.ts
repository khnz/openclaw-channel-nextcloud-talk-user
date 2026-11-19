import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedNextcloudTalkAccount } from "../accounts.js";
import { resolveNextcloudTalkGroupRequireMention, resolveNextcloudTalkRoomMatch } from "../policy.js";
import type { CoreConfig } from "../types.js";
import { isNextcloudTalkDirectRoom, type NextcloudTalkRoomSummary } from "./normalize-message.js";

/**
 * Notification level of the account per room.
 *
 * Talk levels: 0 = default, 1 = always, 2 = on mention, 3 = never.
 * - If the plugin reacts to all messages in a room (no mention required), it sets
 *   "always" so every message arrives by push.
 * - Otherwise it sets "on mention" again.
 * - 1:1 rooms, "Note to self" and the changelog room stay unchanged.
 *
 * Talk 25 only accepts 1, 2 and 3 via the API (ParticipantService::updateNotificationLevel);
 * "default" (0) cannot be restored. The room list reports the effective level (default ->
 * admin setting default_group_notification, "on mention" since Talk 23). For "mentions
 * only", 2 is therefore set explicitly.
 */
export const NEXTCLOUD_TALK_NOTIFICATION_LEVEL_ALWAYS = 1;
export const NEXTCLOUD_TALK_NOTIFICATION_LEVEL_MENTION = 2;

export type NextcloudTalkNotificationLevel =
  | typeof NEXTCLOUD_TALK_NOTIFICATION_LEVEL_ALWAYS
  | typeof NEXTCLOUD_TALK_NOTIFICATION_LEVEL_MENTION;

const TALK_ROOM_TYPE_CHANGELOG = 4;

export function resolveNextcloudTalkNotificationLevel(params: {
  cfg: CoreConfig;
  account: ResolvedNextcloudTalkAccount;
  room: Pick<NextcloudTalkRoomSummary, "token" | "type">;
}): NextcloudTalkNotificationLevel | undefined {
  const { cfg, account, room } = params;
  if (isNextcloudTalkDirectRoom(room.type) || room.type === TALK_ROOM_TYPE_CHANGELOG) {
    return undefined;
  }
  if (account.config.groupPolicy === "disabled") {
    return NEXTCLOUD_TALK_NOTIFICATION_LEVEL_MENTION;
  }
  const match = resolveNextcloudTalkRoomMatch({ rooms: account.config.rooms, roomToken: room.token });
  if (!match.allowed || match.roomConfig?.enabled === false) {
    return NEXTCLOUD_TALK_NOTIFICATION_LEVEL_MENTION;
  }
  const requireMention = resolveNextcloudTalkGroupRequireMention({
    cfg: cfg as OpenClawConfig,
    accountId: account.accountId,
    groupId: room.token,
  });
  return requireMention ? NEXTCLOUD_TALK_NOTIFICATION_LEVEL_MENTION : NEXTCLOUD_TALK_NOTIFICATION_LEVEL_ALWAYS;
}

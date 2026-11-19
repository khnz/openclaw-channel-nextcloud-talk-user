import type { ResolvedNextcloudTalkAccount } from "../accounts.js";
import { resolveNextcloudTalkRoomMatch } from "../policy.js";

/**
 * Joining allowed rooms on its own.
 *
 * One setting per account: autoJoin (default false). When on, the account joins every open
 * room that Nextcloud offers it in listed-room and that the config allows (groupPolicy not
 * "disabled"; with a room list only listed rooms; not enabled: false). Nextcloud decides
 * which rooms are open.
 */
export function resolveNextcloudTalkAutoJoinPolicy(account: ResolvedNextcloudTalkAccount): {
  enabled: boolean;
  isAllowed: (token: string) => boolean;
} {
  const enabled = account.config.autoJoin === true && account.config.groupPolicy !== "disabled";
  return {
    enabled,
    isAllowed: (token) => {
      const match = resolveNextcloudTalkRoomMatch({ rooms: account.config.rooms, roomToken: token });
      return match.allowed && match.roomConfig?.enabled !== false;
    },
  };
}

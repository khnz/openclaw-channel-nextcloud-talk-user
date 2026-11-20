import { expandAllowFromWithAccessGroups } from "openclaw/plugin-sdk/security-runtime";
import {
  createChannelPairingController,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  type OpenClawConfig,
  type RuntimeEnv,
} from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { NEXTCLOUD_TALK_CHANNEL_ID } from "./channel-id.js";
import { resolveNextcloudTalkAllowlistMatch, resolveNextcloudTalkRoomMatch } from "./policy.js";
import { resolveNextcloudTalkRoomInfo, type NextcloudTalkRoomInfo } from "./room-info.js";
import { getOptionalNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

/**
 * Room permission for actions the agent starts itself: reading history, sending text or
 * files, reacting.
 *
 * Membership alone is not enough: U may be a member of rooms the configuration does not
 * release to the agent. The same rules as for incoming messages apply:
 * - Group rooms: groupPolicy not "disabled"; with a room list only listed rooms; never a
 *   room with `enabled: false`.
 * - One-to-one rooms: dmPolicy not "disabled"; the other participant matches allowFrom
 *   (including access groups) or, with dmPolicy "pairing", the approved pairing list.
 *   dmPolicy "open" releases every one-to-one room.
 * - Note to self and rooms whose type cannot be determined: denied (fail closed).
 */

export type NextcloudTalkRoomAccessDecision =
  | { allowed: true; kind: "group" | "direct" }
  | { allowed: false; reason: string };

export class NextcloudTalkRoomAccessError extends Error {
  constructor(
    readonly roomToken: string,
    readonly reason: string,
  ) {
    super(`Nextcloud Talk: room ${roomToken} is not released for this agent (${reason}).`);
    this.name = "NextcloudTalkRoomAccessError";
  }
}

async function readPairedAllowFrom(accountId: string): Promise<string[]> {
  const core = getOptionalNextcloudTalkRuntime();
  if (!core) {
    return [];
  }
  const pairing = createChannelPairingController({
    core,
    channel: NEXTCLOUD_TALK_CHANNEL_ID,
    accountId,
  });
  return await pairing.readStoreForDmPolicy(NEXTCLOUD_TALK_CHANNEL_ID, accountId);
}

async function isDirectPeerAllowed(params: {
  cfg: CoreConfig;
  account: ResolvedNextcloudTalkAccount;
  peerUserId: string;
}): Promise<boolean> {
  const { cfg, account } = params;
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  if (dmPolicy === "disabled") {
    return false;
  }
  if (dmPolicy === "open") {
    return true;
  }
  const senderId = `users/${params.peerUserId}`;
  const configured = (account.config.allowFrom ?? []).map(String);
  const paired = dmPolicy === "pairing" ? await readPairedAllowFrom(account.accountId) : [];
  const allowFrom = await expandAllowFromWithAccessGroups({
    cfg: cfg as OpenClawConfig,
    allowFrom: [...configured, ...paired],
    channel: NEXTCLOUD_TALK_CHANNEL_ID,
    accountId: account.accountId,
    senderId,
    isSenderAllowed: (id, allow) =>
      resolveNextcloudTalkAllowlistMatch({ senderId: id, allowFrom: allow }).allowed,
  });
  return resolveNextcloudTalkAllowlistMatch({ allowFrom, senderId }).allowed;
}

function decideGroupRoom(params: {
  cfg: CoreConfig;
  account: ResolvedNextcloudTalkAccount;
  roomToken: string;
}): NextcloudTalkRoomAccessDecision {
  const { cfg, account, roomToken } = params;
  const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
    providerConfigPresent:
      ((cfg.channels as Record<string, unknown> | undefined)?.[NEXTCLOUD_TALK_CHANNEL_ID] ??
        undefined) !== undefined,
    groupPolicy: account.config.groupPolicy,
    defaultGroupPolicy: resolveDefaultGroupPolicy(cfg as OpenClawConfig),
  });
  if (groupPolicy === "disabled") {
    return { allowed: false, reason: "group rooms disabled (groupPolicy)" };
  }
  const match = resolveNextcloudTalkRoomMatch({ rooms: account.config.rooms, roomToken });
  if (!match.allowed) {
    return { allowed: false, reason: "room not in the rooms list" };
  }
  if (match.roomConfig?.enabled === false) {
    return { allowed: false, reason: "room disabled (enabled: false)" };
  }
  return { allowed: true, kind: "group" };
}

/** Decides from an already resolved room type (exported for tests). */
export async function decideNextcloudTalkRoomAccess(params: {
  cfg: CoreConfig;
  account: ResolvedNextcloudTalkAccount;
  roomToken: string;
  info: NextcloudTalkRoomInfo | undefined;
}): Promise<NextcloudTalkRoomAccessDecision> {
  const { cfg, account, roomToken, info } = params;
  if (!info) {
    return { allowed: false, reason: "room unknown to the configured user" };
  }
  if (info.kind === "group") {
    return decideGroupRoom({ cfg, account, roomToken });
  }
  if (!info.peerUserId) {
    return { allowed: false, reason: "note to self or one-to-one room without a known participant" };
  }
  if (info.peerUserId.toLowerCase() === account.apiUser.toLowerCase()) {
    return { allowed: false, reason: "one-to-one room with the plugin's own user" };
  }
  return (await isDirectPeerAllowed({ cfg, account, peerUserId: info.peerUserId }))
    ? { allowed: true, kind: "direct" }
    : { allowed: false, reason: "participant not allowed for direct messages (dmPolicy/allowFrom)" };
}

export async function resolveNextcloudTalkRoomAccess(params: {
  cfg: CoreConfig;
  account: ResolvedNextcloudTalkAccount;
  roomToken: string;
  runtime?: RuntimeEnv;
}): Promise<NextcloudTalkRoomAccessDecision> {
  const info = await resolveNextcloudTalkRoomInfo({
    account: params.account,
    roomToken: params.roomToken,
    runtime: params.runtime,
  });
  return await decideNextcloudTalkRoomAccess({ ...params, info });
}

/** Throws NextcloudTalkRoomAccessError unless the room is released for the agent. */
export async function assertNextcloudTalkRoomAccess(params: {
  cfg: CoreConfig;
  account: ResolvedNextcloudTalkAccount;
  roomToken: string;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const decision = await resolveNextcloudTalkRoomAccess(params);
  if (!decision.allowed) {
    throw new NextcloudTalkRoomAccessError(params.roomToken, decision.reason);
  }
}

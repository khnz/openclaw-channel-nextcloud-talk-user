/**
 * Channel identity of the plugin.
 *
 * The default package registers its own channel "nextcloud-talk-user". The drop-in replacement
 * package (`npm run pack:dropInReplacement`) flips NEXTCLOUD_TALK_DROP_IN_REPLACEMENT in the
 * compiled copy of this file, so the same code registers the channel "nextcloud-talk" of the
 * official OpenClaw plugin instead and reads its config from `channels.nextcloud-talk`.
 *
 * The plugin id stays "nextcloud-talk-user" in both variants, and so do plugin-scoped names such
 * as the state directory and log prefixes.
 */

/** Rewritten by scripts/pack-drop-in-replacement.mjs; keep this exact declaration. */
export const NEXTCLOUD_TALK_DROP_IN_REPLACEMENT: boolean = false;

export type NextcloudTalkChannelIdentity = {
  id: string;
  label: string;
  selectionLabel: string;
  docsPath: string;
  docsLabel: string;
  aliases: string[];
};

export function resolveNextcloudTalkChannelIdentity(dropInReplacement: boolean): NextcloudTalkChannelIdentity {
  return dropInReplacement
    ? {
        id: "nextcloud-talk",
        label: "Nextcloud Talk",
        selectionLabel: "Nextcloud Talk (self-hosted)",
        docsPath: "/channels/nextcloud-talk",
        docsLabel: "nextcloud-talk",
        aliases: ["nc-talk", "nc"],
      }
    : {
        id: "nextcloud-talk-user",
        label: "Nextcloud Talk (User)",
        selectionLabel: "Nextcloud Talk as user (self-hosted)",
        docsPath: "/channels/nextcloud-talk-user",
        docsLabel: "nextcloud-talk-user",
        aliases: ["nc-talk-user"],
      };
}

export const NEXTCLOUD_TALK_CHANNEL_IDENTITY = resolveNextcloudTalkChannelIdentity(
  NEXTCLOUD_TALK_DROP_IN_REPLACEMENT,
);

/**
 * Channel id used for the config section, sessions, targets and receipts.
 * Typed as the default literal: the config shape under both ids is the same.
 */
export const NEXTCLOUD_TALK_CHANNEL_ID = NEXTCLOUD_TALK_CHANNEL_IDENTITY.id as "nextcloud-talk-user";

/** Id of the official OpenClaw plugin this package can replace. */
export const NEXTCLOUD_TALK_ORIGINAL_PLUGIN_ID = "nextcloud-talk";

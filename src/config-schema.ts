import {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  ReplyToModeSchema,
  buildChannelConfigSchema,
  buildGroupEntrySchema,
  buildMultiAccountChannelSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { NEXTCLOUD_TALK_CHANNEL_ID, NEXTCLOUD_TALK_DROP_IN_REPLACEMENT } from "./channel-id.js";

export const NextcloudTalkRoomSchema = buildGroupEntrySchema({
  allowFrom: z.array(z.string()).optional(),
}).omit({ toolsBySender: true });

const NextcloudTalkNetworkSchema = z
  .object({
    /** Dangerous opt-in for self-hosted Nextcloud Talk on trusted private/internal hosts. */
    dangerouslyAllowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

/**
 * Settings of the official nextcloud-talk plugin (bot/webhook). The drop-in replacement accepts
 * them with the original types so an existing `channels.nextcloud-talk` config keeps validating,
 * but never uses them.
 */
const NextcloudTalkBotPluginSettingsShape = {
  botSecret: buildSecretInputSchema().optional(),
  botSecretFile: z.string().optional(),
  webhookPath: z.string().optional(),
  webhookPublicUrl: z.string().optional(),
  legacyWebhook: z
    .union([
      z.literal(false),
      z
        .object({
          port: z.number().int().min(1).max(65535),
          host: z.string().optional(),
        })
        .strict(),
    ])
    .optional(),
};

/** Settings of the official plugin that the drop-in replacement accepts and ignores. */
export const NEXTCLOUD_TALK_IGNORED_BOT_PLUGIN_SETTINGS = Object.keys(NextcloudTalkBotPluginSettingsShape);

function buildNextcloudTalkAccountSchemaBase(dropInReplacement: boolean) {
  return z
    .object({
      name: z.string().optional(),
      enabled: z.boolean().optional(),
      configWrites: z.boolean().optional(),
      replyToMode: ReplyToModeSchema.optional(),
      markdown: MarkdownConfigSchema,
      baseUrl: z.string().optional(),
      /** Nextcloud user the plugin signs in as. */
      apiUser: z.string().optional(),
      /** App password of that user (SecretRef recommended). */
      apiPassword: buildSecretInputSchema().optional(),
      apiPasswordFile: z.string().optional(),
      /**
       * Device name in Nextcloud for the device login (default: "openclaw nextcloud-talk-plugin").
       * Applies to new sign-ins only; an existing device keeps its name.
       */
      deviceName: z.string().trim().min(1).max(120).optional(),
      dmPolicy: DmPolicySchema.optional().default("pairing"),
      /** Ignore messages from Talk bots (default: true); prevents loops with the bot plugin. */
      ignoreBots: z.boolean().optional(),
      /**
       * Join allowed open rooms on its own (default: false). Allowed means: listed as an open
       * room for the account in Nextcloud and permitted by groupPolicy/rooms; never with an
       * active lobby or password, no rejoin after removal.
       */
      autoJoin: z.boolean().optional(),
      /**
       * Proactive direct messages (target user:<uid>): "allowFrom" (default) creates or uses
       * the 1:1 room only with people from allowFrom; "off" disables it.
       */
      proactiveDm: z.enum(["allowFrom", "off"]).optional(),
      /** Treat @all in group rooms as a mention of the account (default: false). */
      mentionAll: z.boolean().optional(),
      /** Mark as read after dispatching to the agent (default: true). */
      markRead: z.boolean().optional(),
      /** online: user_status heartbeat (default); silent: no online status. */
      presence: z.enum(["online", "silent"]).optional(),
      /**
       * Message tool actions. messages: read history (action "read"), default: true.
       * polls: read polls (action "read" with pollId) and vote (action "poll-vote"), default: true.
       */
      actions: z
        .object({
          messages: z.boolean().optional(),
          polls: z.boolean().optional(),
        })
        .strict()
        .optional(),
      allowFrom: z.array(z.string()).optional(),
      mediaAllowFrom: z.array(z.string()).optional(),
      groupAllowFrom: z.array(z.string()).optional(),
      groupPolicy: GroupPolicySchema.optional().default("allowlist"),
      rooms: z.record(z.string(), NextcloudTalkRoomSchema.optional()).optional(),
      /** Network policy overrides for self-hosted Nextcloud Talk on trusted private/internal hosts. */
      network: NextcloudTalkNetworkSchema,
      ...ReplyRuntimeConfigSchemaShape,
      ...(dropInReplacement ? NextcloudTalkBotPluginSettingsShape : {}),
    })
    .strict();
}

function buildNextcloudTalkConfigSchema(dropInReplacement: boolean) {
  return buildMultiAccountChannelSchema(
    buildNextcloudTalkAccountSchemaBase(dropInReplacement),
    {
      optionalAccount: true,
      refine: (value, ctx) => {
        requireChannelOpenAllowFrom({
          channel: NEXTCLOUD_TALK_CHANNEL_ID,
          policy: value.dmPolicy,
          allowFrom: value.allowFrom,
          ctx,
          requireOpenAllowFrom,
        });
      },
    },
  );
}

/** Builds the channel config schema; exported for tests of both package variants. */
export function buildNextcloudTalkChannelConfigSchema(dropInReplacement: boolean) {
  return buildChannelConfigSchema(
    buildNextcloudTalkConfigSchema(dropInReplacement),
    {
      uiHints: {
        mediaAllowFrom: {
          label: "Nextcloud Talk Inbound Media Allowlist",
          help: 'User IDs whose attachments may be processed after ordinary access and mention checks. Omitted or empty denies all media; use ["*"] for every otherwise-authorized sender.',
        },
        "accounts.*.mediaAllowFrom": {
          label: "Nextcloud Talk Account Inbound Media Allowlist",
          help: 'Per-account attachment allowlist. Omitted inherits the root allowlist; an empty list denies all media; use ["*"] for every otherwise-authorized sender.',
        },
      },
    },
  );
}

export const NextcloudTalkAccountSchemaBase = buildNextcloudTalkAccountSchemaBase(
  NEXTCLOUD_TALK_DROP_IN_REPLACEMENT,
);
export const NextcloudTalkConfigSchema = buildNextcloudTalkConfigSchema(NEXTCLOUD_TALK_DROP_IN_REPLACEMENT);
export const NextcloudTalkChannelConfigSchema = buildNextcloudTalkChannelConfigSchema(
  NEXTCLOUD_TALK_DROP_IN_REPLACEMENT,
);

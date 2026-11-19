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

export const NextcloudTalkAccountSchemaBase = z
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
    /** Message tool actions. messages: read history (action "read"), default: true. */
    actions: z
      .object({
        messages: z.boolean().optional(),
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
  })
  .strict();

export const NextcloudTalkConfigSchema = buildMultiAccountChannelSchema(
  NextcloudTalkAccountSchemaBase,
  {
    optionalAccount: true,
    refine: (value, ctx) => {
      requireChannelOpenAllowFrom({
        channel: "nextcloud-talk-user",
        policy: value.dmPolicy,
        allowFrom: value.allowFrom,
        ctx,
        requireOpenAllowFrom,
      });
    },
  },
);

export const NextcloudTalkChannelConfigSchema = buildChannelConfigSchema(
  NextcloudTalkConfigSchema,
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

import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
  clearAccountFieldsFromConfigSection,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  defineChannelMessageAdapter,
  type ChannelMessageSendTextContext,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  createLoggedPairingApprovalNotifier,
  createPairingPrefixStripper,
} from "openclaw/plugin-sdk/channel-pairing";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  createAllowlistProviderRouteAllowlistWarningCollector,
  createConditionalWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  buildBaseChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import {
  isNextcloudTalkAccountConfigured,
  type ResolvedNextcloudTalkAccount,
  inspectNextcloudTalkAccount,
  listNextcloudTalkAccountIds,
  resolveDefaultNextcloudTalkAccountId,
  resolveNextcloudTalkAccount,
} from "./accounts.js";
import { NextcloudTalkChannelConfigSchema } from "./config-schema.js";
import { nextcloudTalkDoctor } from "./doctor.js";
import { nextcloudTalkMessageActions } from "./message-actions.js";
import {
  looksLikeNextcloudTalkTargetId,
  normalizeNextcloudTalkMessagingTarget,
  parseNextcloudTalkTarget,
  stripNextcloudTalkTargetPrefix,
} from "./normalize.js";
import {
  normalizeNextcloudTalkAllowEntry,
  normalizeNextcloudTalkAllowlist,
  resolveNextcloudTalkGroupRequireMention,
  resolveNextcloudTalkGroupToolPolicy,
} from "./policy.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { sendMessageNextcloudTalk } from "./send.js";
import { nextcloudTalkSetupContract } from "./setup-core.js";
import { nextcloudTalkSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

const nextcloudTalkApprovalAuth = createChannelApprovalAuth({
  channelLabel: "Nextcloud Talk (User)",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveNextcloudTalkAccount({ cfg, accountId });
    return { allowFrom: account.config.allowFrom };
  },
  normalizeApprover: (value) => normalizeNextcloudTalkAllowEntry(String(value)) || undefined,
}).approvalAuth;

function sendNextcloudTalkMessage(
  ctx: Omit<ChannelMessageSendTextContext, "onDeliveryResult">,
  text = ctx.text,
) {
  return sendMessageNextcloudTalk(ctx.to, text, {
    accountId: ctx.accountId ?? undefined,
    replyTo: ctx.replyToId ?? undefined,
    threadId: ctx.threadId != null ? String(ctx.threadId) : undefined,
    silent: ctx.silent,
    cfg: ctx.cfg,
    onPlatformSendDispatch: ctx.onPlatformSendDispatch,
    assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
  });
}

const nextcloudTalkMessageAdapter = defineChannelMessageAdapter({
  id: "nextcloud-talk-user",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      replyTo: true,
      silent: true,
    },
  },
  send: {
    text: sendNextcloudTalkMessage,
    media: async (ctx) => {
      if (!ctx.mediaUrl) {
        return sendNextcloudTalkMessage(ctx);
      }
      // As a regular user, credentials are always present: attachments go via WebDAV + share.
      const { sendMediaNextcloudTalk } = await import("./outbound-media.js");
      return sendMediaNextcloudTalk(ctx);
    },
  },
});

const meta = {
  id: "nextcloud-talk-user",
  label: "Nextcloud Talk (User)",
  selectionLabel: "Nextcloud Talk as user (self-hosted)",
  docsPath: "/channels/nextcloud-talk-user",
  docsLabel: "nextcloud-talk-user",
  blurb: "Self-hosted chat via Nextcloud Talk, signed in as a regular Nextcloud user.",
  aliases: ["nc-talk-user"],
  order: 65,
  quickstartAllowFrom: true,
};

const collectNextcloudTalkSecurityWarnings =
  createAllowlistProviderRouteAllowlistWarningCollector<ResolvedNextcloudTalkAccount>({
    providerConfigPresent: (cfg) =>
      (cfg.channels as Record<string, unknown> | undefined)?.["nextcloud-talk-user"] !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    resolveRouteAllowlistConfigured: (account) =>
      Boolean(account.config.rooms) && Object.keys(account.config.rooms ?? {}).length > 0,
    restrictSenders: {
      surface: "Nextcloud Talk rooms",
      openScope: "any member in allowed rooms",
      groupPolicyPath: "channels.nextcloud-talk-user.groupPolicy",
      groupAllowFromPath: "channels.nextcloud-talk-user.groupAllowFrom",
    },
    noRouteAllowlist: {
      surface: "Nextcloud Talk rooms",
      routeAllowlistPath: "channels.nextcloud-talk-user.rooms",
      routeScope: "room",
      groupPolicyPath: "channels.nextcloud-talk-user.groupPolicy",
      groupAllowFromPath: "channels.nextcloud-talk-user.groupAllowFrom",
    },
  });
const collectNextcloudTalkOpenGroupFindings = createConditionalWarningCollector.findings({
  collectWarnings: collectNextcloudTalkSecurityWarnings,
  checkId: "channels.nextcloud-talk-user.groups.open",
  severity: "warn",
  title: "Nextcloud Talk security warning",
});

export const nextcloudTalkPlugin: ChannelPlugin<ResolvedNextcloudTalkAccount> =
  createChatChannelPlugin({
    base: {
      id: "nextcloud-talk-user",
      meta,
      setupWizard: nextcloudTalkSetupWizard,
      capabilities: {
        chatTypes: ["direct", "group"],
        reactions: true,
        threads: true,
        media: true,
        tts: {
          voice: {
            synthesisTarget: "audio-file",
            audioFileFormats: ["mp3", "wav", "audio/mpeg", "audio/wav"],
            captionedFinalText: true,
          },
        },
        nativeCommands: false,
        blockStreaming: true,
      },
      reload: { configPrefixes: ["channels.nextcloud-talk-user"] },
      configSchema: NextcloudTalkChannelConfigSchema,
      config: {
        ...createScopedChannelConfigAdapter<
          ResolvedNextcloudTalkAccount,
          ResolvedNextcloudTalkAccount,
          CoreConfig
        >({
          sectionKey: "nextcloud-talk-user",
          listAccountIds: listNextcloudTalkAccountIds,
          resolveAccount: adaptScopedAccountAccessor(resolveNextcloudTalkAccount),
          inspectAccount: (cfg, accountId) => {
            const account = inspectNextcloudTalkAccount({ cfg, accountId });
            // Diagnostics expose presence only; operational callers retain the actual server URL.
            return { ...account, baseUrl: account.baseUrl ? "[set]" : "[missing]" };
          },
          defaultAccountId: resolveDefaultNextcloudTalkAccountId,
          clearBaseFields: ["apiUser", "apiPassword", "apiPasswordFile", "baseUrl", "name"],
          resolveAllowFrom: (account) => account.config.allowFrom,
          formatAllowFrom: normalizeNextcloudTalkAllowlist,
        }),
        isConfigured: isNextcloudTalkAccountConfigured,
        describeAccount: (account) =>
          describeAccountSnapshot({
            account,
            configured: isNextcloudTalkAccountConfigured(account),
            extra: {
              secretSource: account.secretSource,
              credentialStatus: account.credentialStatus,
              apiUser: account.apiUser || "[missing]",
              baseUrl: account.baseUrl ? "[set]" : "[missing]",
              mode: "user",
            },
          }),
      },
      approvalCapability: nextcloudTalkApprovalAuth,
      doctor: nextcloudTalkDoctor,
      groups: {
        resolveRequireMention: resolveNextcloudTalkGroupRequireMention,
        resolveToolPolicy: resolveNextcloudTalkGroupToolPolicy,
      },
      messaging: {
        targetPrefixes: ["nextcloud-talk-user", "nc-talk-user"],
        normalizeTarget: normalizeNextcloudTalkMessagingTarget,
        inferTargetChatType: ({ to }) => {
          const parsed = parseNextcloudTalkTarget(to);
          return parsed ? (parsed.kind === "user" ? "direct" : "group") : undefined;
        },
        resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
          const parsed = parseNextcloudTalkTarget(target);
          if (parsed?.kind === "user") {
            // Same session as incoming direct messages from this person (peer users/<uid>).
            const senderId = `users/${parsed.userId}`;
            return buildChannelOutboundSessionRoute({
              cfg,
              agentId,
              channel: "nextcloud-talk-user",
              accountId,
              peer: { kind: "direct", id: senderId },
              chatType: "direct",
              from: `nextcloud-talk-user:${senderId}`,
              to: `nextcloud-talk-user:user:${parsed.userId}`,
            });
          }
          const roomId = stripNextcloudTalkTargetPrefix(target);
          if (!roomId) {
            return null;
          }
          return buildChannelOutboundSessionRoute({
            cfg,
            agentId,
            channel: "nextcloud-talk-user",
            accountId,
            // Room tokens do not reveal whether inbound keys by room or sender id.
            // Keep delivery behavior, but reject this route for explicit session selection.
            recipientSessionExact: false,
            peer: {
              kind: "group",
              id: roomId,
            },
            chatType: "group",
            from: `nextcloud-talk-user:room:${roomId}`,
            to: `nextcloud-talk-user:${roomId}`,
          });
        },
        targetResolver: {
          looksLikeId: looksLikeNextcloudTalkTargetId,
          hint: "<roomToken> | user:<uid>",
        },
      },
      secrets: {
        secretTargetRegistryEntries,
        collectRuntimeConfigAssignments,
      },
      setupContract: nextcloudTalkSetupContract,
      status: createComputedAccountStatusAdapter<ResolvedNextcloudTalkAccount>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        buildChannelSummary: ({ snapshot }) =>
          buildBaseChannelStatusSummary(snapshot, {
            mode: "user",
            secretSource: snapshot.secretSource ?? "none",
          }),
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: isNextcloudTalkAccountConfigured(account),
          extra: {
            secretSource: account.secretSource,
            credentialStatus: account.credentialStatus,
            apiUser: account.apiUser || "[missing]",
            baseUrl: account.baseUrl ? "[set]" : "[missing]",
            mode: "user",
          },
        }),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const { startNextcloudTalkAccount } = await import("./receive/start-account.js");
          await startNextcloudTalkAccount(ctx);
        },
        logoutAccount: async ({ accountId, cfg }) => {
          const { nextConfig, changed, cleared } = clearAccountFieldsFromConfigSection({
            cfg,
            sectionKey: "nextcloud-talk-user",
            accountId,
            fields: ["apiPassword"],
          });

          const resolved = resolveNextcloudTalkAccount({
            cfg: nextConfig,
            accountId,
          });
          const loggedOut = resolved.credentialStatus === "missing";

          if (changed) {
            await getNextcloudTalkRuntime().config.replaceConfigFile({
              nextConfig,
              afterWrite: { mode: "auto" },
            });
          }

          return {
            cleared,
            envSecret: false,
            loggedOut,
          };
        },
      },
      message: nextcloudTalkMessageAdapter,
      actions: nextcloudTalkMessageActions,
    },
    pairing: {
      text: {
        idLabel: "nextcloudUserId",
        message: "OpenClaw: your access has been approved.",
        normalizeAllowEntry: createPairingPrefixStripper(
          /^(nextcloud-talk-user|nc-talk-user):/i,
          (entry) => normalizeLowercaseStringOrEmpty(entry),
        ),
        notify: createLoggedPairingApprovalNotifier(
          ({ id }) => `[nextcloud-talk-user] User ${id} approved for pairing`,
        ),
      },
    },
    security: {
      resolveDmPolicy: createScopedDmSecurityResolver<ResolvedNextcloudTalkAccount>({
        channelKey: "nextcloud-talk-user",
        resolvePolicy: (account) => account.config.dmPolicy,
        resolveAllowFrom: (account) => account.config.allowFrom,
        policyPathSuffix: "dmPolicy",
        normalizeEntry: normalizeNextcloudTalkAllowEntry,
      }),
      collectWarnings: collectNextcloudTalkOpenGroupFindings,
    },
    outbound: {
      base: {
        deliveryMode: "direct",
        chunker: (text, limit) =>
          getNextcloudTalkRuntime().channel.text.chunkMarkdownText(text, limit),
        chunkerMode: "markdown",
        textChunkLimit: 4000,
        sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
      },
      attachedResults: {
        channel: "nextcloud-talk-user",
        sendText: nextcloudTalkMessageAdapter.send.text,
        sendMedia: (ctx) =>
          nextcloudTalkMessageAdapter.send.media({
            ...ctx,
            mediaUrl: ctx.mediaUrl ?? "",
            onDeliveryResult: undefined,
          }),
      },
    },
  });

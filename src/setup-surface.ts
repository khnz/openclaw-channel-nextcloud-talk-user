import {
  baseUrlTextInput,
  createStandardChannelSetupStatus,
  setSetupChannelEnabled,
  createSetupTranslator,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { isNextcloudTalkAccountConfigured, resolveNextcloudTalkAccount } from "./accounts.js";
import {
  nextcloudTalkDmPolicy,
  normalizeNextcloudTalkBaseUrl,
  setNextcloudTalkAccountConfig,
  validateNextcloudTalkBaseUrl,
} from "./setup-core.js";
import { runNextcloudTalkDeviceLoginStep } from "./setup-device-login.js";
import type { CoreConfig } from "./types.js";
import { NEXTCLOUD_TALK_CHANNEL_ID, NEXTCLOUD_TALK_CHANNEL_IDENTITY } from "./channel-id.js";

const t = createSetupTranslator();

const channel = NEXTCLOUD_TALK_CHANNEL_ID;

export const nextcloudTalkSetupWizard: ChannelSetupWizard = {
  channel,
  stepOrder: "text-first",
  status: createStandardChannelSetupStatus({
    channelLabel: NEXTCLOUD_TALK_CHANNEL_IDENTITY.label,
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsSetup"),
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: t("wizard.channels.statusSelfHostedChat"),
    configuredScore: 1,
    unconfiguredScore: 5,
    resolveConfigured: ({ cfg, accountId }) => {
      const account = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
      return isNextcloudTalkAccountConfigured(account);
    },
  }),
  introNote: {
    title: t("wizard.nextcloudTalk.setupTitle"),
    lines: [
      "This plugin signs in to Nextcloud Talk as a regular user (not as a Talk bot).",
      "Use a dedicated Nextcloud account for the agent, never a personal account.",
      "After server URL and user, the device login follows via a link (Login Flow v2).",
      "Invite the account to the rooms you want and then allow them under rooms.",
    ],
    shouldShow: ({ cfg, accountId }) => {
      const account = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
      return !isNextcloudTalkAccountConfigured(account);
    },
  },
  // The device password is not requested through a standard credential prompt, but in
  // finalize via the device login (Login Flow v2) or manual input.
  credentials: [],
  textInputs: [
    baseUrlTextInput({
      inputKey: "httpUrl",
      configKey: "baseUrl",
      message: t("wizard.nextcloudTalk.instanceUrlPrompt"),
      resolveAccount: ({ cfg, accountId }) =>
        resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId }),
      currentValue: (account) => account.baseUrl || undefined,
      // Always show, prefilled with the current value.
      shouldPrompt: () => true,
      validate: validateNextcloudTalkBaseUrl,
      normalize: normalizeNextcloudTalkBaseUrl,
      patchAccount: ({ cfg, accountId, patch }) =>
        setNextcloudTalkAccountConfig(cfg as CoreConfig, accountId, patch),
    }),
    {
      inputKey: "userId",
      message: t("wizard.nextcloudTalk.apiUserPrompt"),
      currentValue: ({ cfg, accountId }) =>
        resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId }).config.apiUser?.trim() ||
        undefined,
      shouldPrompt: () => true,
      validate: ({ value }) => (value ? undefined : t("common.required")),
      applySet: async (params) =>
        setNextcloudTalkAccountConfig(params.cfg as CoreConfig, params.accountId, {
          apiUser: params.value,
        }),
    },
  ],
  finalize: async ({ cfg, accountId, prompter }) => ({
    cfg: await runNextcloudTalkDeviceLoginStep({
      cfg: cfg as CoreConfig,
      accountId,
      prompter,
      applyPatch: setNextcloudTalkAccountConfig,
    }),
  }),
  dmPolicy: nextcloudTalkDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};

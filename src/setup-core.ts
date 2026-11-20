import { createChannelDmPolicy } from "openclaw/plugin-sdk/channel-dm-policy";
import {
  defineChannelSetupContract,
  type ChannelSetupAdapter,
  type ChannelSetupInput,
} from "openclaw/plugin-sdk/channel-setup";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  applyAccountNameToChannelSection,
  createPromptParsedAllowFromForAccount,
  patchScopedAccountConfig,
} from "openclaw/plugin-sdk/setup";
import {
  createSetupInputPresenceValidator,
  mergeAllowFromEntries,
  createSetupTranslator,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import {
  normalizeLowercaseStringOrEmpty,
  readNonEmptyStringPreservingWhitespace as readNonEmptyUntrimmedString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultNextcloudTalkAccountId, resolveNextcloudTalkAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";
import { NEXTCLOUD_TALK_CHANNEL_ID, NEXTCLOUD_TALK_CHANNEL_IDENTITY } from "./channel-id.js";

const t = createSetupTranslator();

const channel = NEXTCLOUD_TALK_CHANNEL_ID;

type NextcloudSetupInput = ChannelSetupInput & {
  baseUrl?: string;
  /** Nextcloud user the plugin signs in as. */
  user?: string;
  /** App password of that user (from the device login or the security settings). */
  password?: string;
  passwordFile?: string;
};

export function normalizeNextcloudTalkBaseUrl(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

export function validateNextcloudTalkBaseUrl(value: string): string | undefined {
  if (!value) {
    return "Required";
  }
  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    return "URL must start with http:// or https://";
  }
  return undefined;
}

export function setNextcloudTalkAccountConfig(
  cfg: CoreConfig,
  accountId: string,
  updates: Record<string, unknown>,
  clearFields?: readonly string[],
): CoreConfig {
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId,
    patch: updates,
    ...(clearFields ? { clearFields } : {}),
  }) as CoreConfig;
}

const promptNextcloudTalkAllowFrom: ReturnType<
  typeof createPromptParsedAllowFromForAccount
> = async (params) =>
  await createPromptParsedAllowFromForAccount<CoreConfig>({
    defaultAccountId: resolveDefaultNextcloudTalkAccountId,
    noteTitle: t("wizard.nextcloudTalk.userIdTitle"),
    noteLines: [
      t("wizard.nextcloudTalk.userIdHelpAdmin"),
      t("wizard.nextcloudTalk.userIdHelpLogs"),
      t("wizard.nextcloudTalk.userIdHelpLowercase"),
      t("wizard.channels.docs", {
        link: formatDocsLink(NEXTCLOUD_TALK_CHANNEL_IDENTITY.docsPath, NEXTCLOUD_TALK_CHANNEL_IDENTITY.docsLabel),
      }),
    ],
    message: t("wizard.nextcloudTalk.allowFromPrompt"),
    placeholder: "username",
    parseEntries: (raw) => ({
      entries: raw
        .split(/[\n,;]+/g)
        .map(normalizeLowercaseStringOrEmpty)
        .filter(Boolean),
    }),
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveNextcloudTalkAccount({ cfg, accountId }).config.allowFrom ?? [],
    mergeEntries: ({ existing, parsed }) =>
      mergeAllowFromEntries(
        existing.map((value) => normalizeLowercaseStringOrEmpty(String(value))),
        parsed,
      ),
    applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
      setNextcloudTalkAccountConfig(cfg, accountId, {
        dmPolicy: "allowlist",
        allowFrom,
      }),
  })(params);

export const nextcloudTalkDmPolicy = createChannelDmPolicy({
  label: "Nextcloud Talk (User)",
  channel,
  resolveAccount: (cfg, accountId) =>
    resolveNextcloudTalkAccount({
      cfg: cfg as CoreConfig,
      accountId: accountId ?? resolveDefaultNextcloudTalkAccountId(cfg as CoreConfig),
    }),
  applyPatch: ({ cfg, account, patch }) =>
    setNextcloudTalkAccountConfig(cfg as CoreConfig, account.accountId, patch),
  promptAllowFrom: promptNextcloudTalkAllowFrom,
});

const nextcloudTalkSetupAdapter: ChannelSetupAdapter = {
  singleAccountKeysToMove: ["rooms"],
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  prepareAccountConfigInput: ({ input }) => {
    const setupInput = input as NextcloudSetupInput;
    return {
      ...setupInput,
      baseUrl: readNonEmptyUntrimmedString(setupInput.baseUrl),
      user: readNonEmptyUntrimmedString(setupInput.user)?.trim(),
      password: readNonEmptyUntrimmedString(setupInput.password),
      passwordFile: readNonEmptyUntrimmedString(setupInput.passwordFile),
    };
  },
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: createSetupInputPresenceValidator({
    validate: ({ input }) => {
      const setupInput = input as NextcloudSetupInput;
      if (!setupInput.user) {
        return "Nextcloud Talk (User) requires --user (the Nextcloud account the plugin signs in as).";
      }
      if (!setupInput.password && !setupInput.passwordFile) {
        return "Nextcloud Talk (User) requires an app password (--password or --password-file).";
      }
      const normalizedBaseUrl = normalizeNextcloudTalkBaseUrl(setupInput.baseUrl);
      if (!normalizedBaseUrl) {
        return "Nextcloud Talk requires --base-url.";
      }
      const baseUrlError = validateNextcloudTalkBaseUrl(normalizedBaseUrl);
      if (baseUrlError) {
        return baseUrlError;
      }
      return null;
    },
  }),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const setupInput = input as NextcloudSetupInput;
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: setupInput.name,
    });
    const patch = {
      baseUrl: normalizeNextcloudTalkBaseUrl(setupInput.baseUrl),
      ...(setupInput.user ? { apiUser: setupInput.user } : {}),
      ...(setupInput.passwordFile
        ? { apiPasswordFile: setupInput.passwordFile }
        : setupInput.password
          ? { apiPassword: setupInput.password }
          : {}),
    };
    return setNextcloudTalkAccountConfig(
      namedConfig as CoreConfig,
      accountId,
      patch,
      setupInput.passwordFile ? ["apiPassword"] : setupInput.password ? ["apiPasswordFile"] : undefined,
    );
  },
};

function secretField<const Flags extends string, const Description extends string>(
  flags: Flags,
  description: Description,
) {
  return { kind: "string", sensitive: true, cli: { flags, description } } as const;
}

export const nextcloudTalkSetupContract = defineChannelSetupContract({
  fields: {
    baseUrl: {
      kind: "string",
      cli: { flags: "--base-url <url>", description: "Nextcloud base URL" },
    },
    user: {
      kind: "string",
      cli: { flags: "--user <uid>", description: "Nextcloud user the plugin signs in as" },
    },
    password: secretField("--password <app-password>", "App password of that Nextcloud user"),
    passwordFile: secretField("--password-file <path>", "File containing the app password"),
  },
  legacyAdapter: nextcloudTalkSetupAdapter,
});

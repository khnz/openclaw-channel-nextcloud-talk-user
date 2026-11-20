import {
  normalizeAccountId,
  resolveAccountWithDefaultFallback,
} from "openclaw/plugin-sdk/account-core";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  mergeNextcloudTalkAccountConfig,
  resolveDefaultNextcloudTalkAccountId,
} from "../configured-state.js";
import {
  resolveNextcloudTalkApiCredentialsResult,
  type NextcloudTalkCredentialUnavailableDiagnostic,
} from "./api-credentials.js";
import type { CoreConfig, NextcloudTalkAccountConfig } from "./types.js";
import { NEXTCLOUD_TALK_CHANNEL_ID } from "./channel-id.js";

export type NextcloudTalkCredentialStatus = "available" | "configured_unavailable" | "missing";

export type ResolvedNextcloudTalkAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  /** Nextcloud user the plugin signs in as. */
  apiUser: string;
  /** App password of that user; empty when unavailable. */
  apiPassword: string;
  secretSource: "config" | "passwordFile" | "none";
  credentialStatus: NextcloudTalkCredentialStatus;
  credentialDiagnostics?: NextcloudTalkCredentialUnavailableDiagnostic[];
  config: NextcloudTalkAccountConfig;
};

export { resolveDefaultNextcloudTalkAccountId };
export { listNextcloudTalkAccountIds } from "../configured-state.js";

function resolveNextcloudTalkUserCredentials(
  accountId: string,
  merged: NextcloudTalkAccountConfig,
): Pick<
  ResolvedNextcloudTalkAccount,
  "apiUser" | "apiPassword" | "secretSource" | "credentialStatus" | "credentialDiagnostics"
> {
  const apiUser = merged.apiUser?.trim() ?? "";
  const secretSource: ResolvedNextcloudTalkAccount["secretSource"] =
    merged.apiPassword !== undefined
      ? "config"
      : merged.apiPasswordFile?.trim()
        ? "passwordFile"
        : "none";
  const result = resolveNextcloudTalkApiCredentialsResult({
    apiUser: merged.apiUser,
    apiPassword: merged.apiPassword,
    apiPasswordFile: merged.apiPasswordFile,
    configPath: `channels.${NEXTCLOUD_TALK_CHANNEL_ID}.accounts.${accountId}.apiPasswordFile`,
    mode: "inspect",
  });
  if (result.status === "available") {
    return {
      apiUser,
      apiPassword: result.value.apiPassword,
      secretSource,
      credentialStatus: "available",
    };
  }
  return {
    apiUser,
    apiPassword: "",
    secretSource,
    credentialStatus: result.status,
    ...(result.status === "configured_unavailable" && result.diagnostic
      ? { credentialDiagnostics: [result.diagnostic] }
      : {}),
  };
}

export function resolveNextcloudTalkAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedNextcloudTalkAccount {
  const baseEnabled = params.cfg.channels?.[NEXTCLOUD_TALK_CHANNEL_ID]?.enabled !== false;
  const resolvedAccountId = params.accountId ?? resolveDefaultNextcloudTalkAccountId(params.cfg);

  const resolve = (accountId: string) => {
    const merged = mergeNextcloudTalkAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const baseUrl = merged.baseUrl?.trim()?.replace(/\/$/, "") ?? "";

    return {
      accountId,
      enabled: baseEnabled && accountEnabled,
      name: normalizeOptionalString(merged.name),
      baseUrl,
      ...resolveNextcloudTalkUserCredentials(accountId, merged),
      config: merged,
    } satisfies ResolvedNextcloudTalkAccount;
  };

  return resolveAccountWithDefaultFallback({
    accountId: resolvedAccountId,
    normalizeAccountId,
    resolvePrimary: resolve,
    hasCredential: (account) => account.credentialStatus !== "missing",
    resolveDefaultAccountId: () => resolveDefaultNextcloudTalkAccountId(params.cfg),
  });
}

export function inspectNextcloudTalkAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}) {
  const account = resolveNextcloudTalkAccount(params);
  return {
    ...account,
    configured: isNextcloudTalkAccountConfigured(account),
    mode: "user" as const,
  };
}

/** Configured means: server, user and an app password (possibly not resolvable yet). */
export function isNextcloudTalkAccountConfigured(account: ResolvedNextcloudTalkAccount): boolean {
  return Boolean(
    account.credentialStatus !== "missing" && account.apiUser && account.baseUrl?.trim(),
  );
}

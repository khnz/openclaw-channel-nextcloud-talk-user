import {
  DEFAULT_ACCOUNT_ID,
  createAccountListHelpers,
  hasConfiguredAccountValue,
  normalizeAccountId,
} from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { CoreConfig, NextcloudTalkAccountConfig } from "./src/types.js";
import { NEXTCLOUD_TALK_CHANNEL_ID } from "./src/channel-id.js";

type NextcloudAccount = NonNullable<NonNullable<CoreConfig["channels"]>["nextcloud-talk-user"]>;

export const {
  listAccountIds: listNextcloudTalkAccountIds,
  resolveDefaultAccountId: resolveDefaultNextcloudTalkAccountId,
  resolveAccountConfig: mergeNextcloudTalkAccountConfig,
} = createAccountListHelpers<NextcloudTalkAccountConfig>(NEXTCLOUD_TALK_CHANNEL_ID, {
  normalizeAccountId,
  omitKeys: ["defaultAccount"],
  hasImplicitDefaultAccount: (cfg) =>
    hasConfiguredNextcloudAccount(cfg.channels?.[NEXTCLOUD_TALK_CHANNEL_ID], process.env),
});

export function hasConfiguredNextcloudAccount(
  account: NextcloudAccount | undefined,
  _env: NodeJS.ProcessEnv,
) {
  return Boolean(
    account?.baseUrl?.trim() &&
    account.apiUser?.trim() &&
    (hasConfiguredAccountValue(account.apiPassword) ||
      hasConfiguredAccountValue(account.apiPasswordFile)),
  );
}

/** Require a Nextcloud server plus the account's user credentials (user U + app password). */
export function hasConfiguredNextcloudTalkChannelState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  // SAFETY: Nextcloud Talk's registered channel schema owns its account-config shape.
  const channel = params.cfg.channels?.[NEXTCLOUD_TALK_CHANNEL_ID] as NextcloudAccount | undefined;
  if (channel?.enabled === false) {
    return false;
  }
  const defaultAccount = channel?.accounts?.[DEFAULT_ACCOUNT_ID];
  if (defaultAccount?.enabled !== false) {
    const account = mergeNextcloudTalkAccountConfig(params.cfg, DEFAULT_ACCOUNT_ID);
    if (hasConfiguredNextcloudAccount(account, params.env ?? process.env)) {
      return true;
    }
  }
  return Object.entries(channel?.accounts ?? {}).some(
    ([accountId, account]) =>
      accountId !== DEFAULT_ACCOUNT_ID &&
      account.enabled !== false &&
      hasConfiguredNextcloudAccount(mergeNextcloudTalkAccountConfig(params.cfg, accountId), {}),
  );
}

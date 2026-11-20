import {
  collectSimpleChannelFieldAssignments,
  createChannelSecretContract,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { hasConfiguredNextcloudAccount } from "../configured-state.js";
import { NEXTCLOUD_TALK_CHANNEL_ID } from "./channel-id.js";

export const channelSecrets = createChannelSecretContract({
  channelKey: NEXTCLOUD_TALK_CHANNEL_ID,
  account: ["apiPassword"],
  channel: ["apiPassword"],
  hasImplicitDefaultAccount: ({ context }) =>
    hasConfiguredNextcloudAccount(context.sourceConfig.channels?.[NEXTCLOUD_TALK_CHANNEL_ID], context.env),
  collect(params) {
    for (const field of ["apiPassword"]) {
      collectSimpleChannelFieldAssignments({
        ...params,
        field,
        topInactiveReason: `no enabled Nextcloud Talk surface inherits this top-level ${field}.`,
        accountInactiveReason: "Nextcloud Talk account is disabled.",
      });
    }
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;

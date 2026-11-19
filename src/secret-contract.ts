import {
  collectSimpleChannelFieldAssignments,
  createChannelSecretContract,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { hasConfiguredNextcloudAccount } from "../configured-state.js";

export const channelSecrets = createChannelSecretContract({
  channelKey: "nextcloud-talk-user",
  account: ["apiPassword"],
  channel: ["apiPassword"],
  hasImplicitDefaultAccount: ({ context }) =>
    hasConfiguredNextcloudAccount(context.sourceConfig.channels?.["nextcloud-talk-user"], context.env),
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

import { SsrFBlockedError } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import {
  checkNextcloudTalkCredentials,
  createNextcloudTalkGuardedRequest,
  resolveNextcloudTalkDeviceName,
  revokeNextcloudTalkAppPassword,
  startNextcloudTalkLoginFlow,
  type NextcloudTalkHttpRequest,
} from "./device-login.js";
import type { CoreConfig } from "./types.js";

/** The minimal part of the OpenClaw WizardPrompter this step needs. */
export type NextcloudTalkDeviceLoginPrompter = {
  note: (message: string, title?: string) => Promise<void>;
  text: (params: {
    message: string;
    placeholder?: string;
    sensitive?: boolean;
    validate?: (value: string) => string | undefined;
  }) => Promise<string>;
  confirm: (params: { message: string; initialValue?: boolean }) => Promise<boolean>;
  progress: (label: string) => { update?: (message: string) => void; stop: (message?: string) => void };
  openUrl?: (url: string) => Promise<void>;
};

type ApplyPatch = (
  cfg: CoreConfig,
  accountId: string,
  patch: Record<string, unknown>,
  clearFields?: readonly string[],
) => CoreConfig;

/**
 * Setup step "device login": shows server and user, starts Login Flow v2, shows the link
 * and at the same time offers an input field for a device password (app password). If the
 * input stays empty, the password granted via the link is fetched. The result is verified
 * (signed-in UID = configured user) and written to the config as `apiPassword`.
 */
export async function runNextcloudTalkDeviceLoginStep(params: {
  cfg: CoreConfig;
  accountId: string;
  prompter: NextcloudTalkDeviceLoginPrompter;
  applyPatch: ApplyPatch;
  request?: NextcloudTalkHttpRequest;
  pollIntervalMs?: number;
}): Promise<CoreConfig> {
  const { prompter, accountId } = params;
  let cfg = params.cfg;
  const account = resolveNextcloudTalkAccount({ cfg, accountId });
  const baseUrl = account.baseUrl;
  const user = account.apiUser;
  if (!baseUrl || !user) {
    await prompter.note(
      "Server URL and user are missing; skipping the device login.",
      "Nextcloud Talk (User)",
    );
    return cfg;
  }
  const deviceName = resolveNextcloudTalkDeviceName(account.config.deviceName);
  await prompter.note(
    [`Server: ${baseUrl}`, `User:   ${user}`, `Device: ${deviceName}`].join(
      "\n",
    ),
    "Nextcloud Talk (User) sign-in",
  );

  if (account.credentialStatus === "available") {
    const renew = await prompter.confirm({
      message: "A device password is already configured. Sign in again?",
      initialValue: false,
    });
    if (!renew) {
      return cfg;
    }
  }

  let allowPrivateNetwork = account.config.network?.dangerouslyAllowPrivateNetwork === true;
  let request = params.request ?? createNextcloudTalkGuardedRequest({ allowPrivateNetwork, deviceName });

  let flow;
  try {
    flow = await startNextcloudTalkLoginFlow({ baseUrl, request });
  } catch (error) {
    if (!(error instanceof SsrFBlockedError) || params.request) {
      throw error;
    }
    const allow = await prompter.confirm({
      message:
        `${baseUrl} is on a private network. Allow access ` +
        "(sets network.dangerouslyAllowPrivateNetwork for this account)?",
      initialValue: false,
    });
    if (!allow) {
      throw error;
    }
    allowPrivateNetwork = true;
    cfg = params.applyPatch(cfg, accountId, {
      network: { ...account.config.network, dangerouslyAllowPrivateNetwork: true },
    });
    request = createNextcloudTalkGuardedRequest({ allowPrivateNetwork, deviceName });
    flow = await startNextcloudTalkLoginFlow({ baseUrl, request });
  }

  await prompter.note(
    [
      "1. Open this link, ideally in a private browser window:",
      `   ${flow.loginUrl}`,
      `2. Sign in as "${user}" and click "Grant access".`,
      "3. Then leave the field below empty and press Enter.",
      "",
      "Alternatively, create an app password manually",
      `(${baseUrl}/index.php/settings/user/security -> "Create new app password")`,
      "and paste it below.",
    ].join("\n"),
    "Device login",
  );
  await prompter.openUrl?.(flow.loginUrl);

  // Polling runs in the background while the input field is open.
  const pollAbort = new AbortController();
  const pending = flow.waitForAppPassword({
    signal: pollAbort.signal,
    intervalMs: params.pollIntervalMs,
  });
  pending.catch(() => undefined);

  const typed = (
    await prompter.text({
      message: "Device password (leave empty after granting access via the link)",
      placeholder: "xxxxx-xxxxx-xxxxx-xxxxx-xxxxx",
      sensitive: true,
    })
  ).trim();

  let loginName = user;
  let password: string;
  let fromLoginFlow = false;
  if (typed) {
    pollAbort.abort();
    password = typed;
  } else {
    const spinner = prompter.progress("Waiting for access to be granted in the browser...");
    const result = await pending;
    if (result.status !== "granted") {
      spinner.stop("Keine Freigabe erhalten.");
      throw new Error(
        result.status === "timeout"
          ? "The device login expired (20 minutes). Run the setup again."
          : "The device login was cancelled.",
      );
    }
    spinner.stop("Freigabe erhalten.");
    loginName = result.loginName;
    password = result.appPassword;
    fromLoginFlow = true;
  }

  // Exactly one check; never retry a rejection (brute-force protection).
  const check = await checkNextcloudTalkCredentials({ baseUrl, loginName, password, request });
  if (check.status === "rejected") {
    throw new Error("Nextcloud rejected the sign-in. Check the password and run the setup again.");
  }
  if (check.status === "throttled") {
    throw new Error(
      "Nextcloud is throttling sign-ins from this IP (brute-force protection). Admin: occ security:bruteforce:reset <IP>.",
    );
  }
  if (check.status === "error") {
    throw new Error(check.message);
  }

  if (check.uid.toLowerCase() !== user.toLowerCase()) {
    // Wrong account: revoke the device right away.
    if (fromLoginFlow || check.converted) {
      await revokeNextcloudTalkAppPassword({
        baseUrl,
        loginName,
        appPassword: check.appPassword,
        request,
      }).catch(() => false);
    }
    throw new Error(
      `Signed in as "${check.uid}", but "${user}" was expected. The device password was discarded.`,
    );
  }

  cfg = params.applyPatch(cfg, accountId, { apiPassword: check.appPassword }, ["apiPasswordFile"]);
  await prompter.note(
    [
      `Signed in as "${check.uid}".`,
      check.converted
        ? "An account password was entered; a dedicated app password was created from it."
        : "The device password is an app password.",
      "The password is stored as apiPassword in the config; a SecretRef is recommended.",
      `Revoke it at any time at ${baseUrl}/index.php/settings/user/security.`,
    ].join("\n"),
    "Device login complete",
  );
  return cfg;
}

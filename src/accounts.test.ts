import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectNextcloudTalkAccount,
  listNextcloudTalkAccountIds,
  resolveDefaultNextcloudTalkAccountId,
  resolveNextcloudTalkAccount,
} from "./accounts.js";
import { resolveNextcloudTalkApiCredentials } from "./api-credentials.js";
import { nextcloudTalkPlugin } from "./channel.js";
import {
  nextcloudTalkDmPolicy,
  nextcloudTalkSetupContract,
  validateNextcloudTalkBaseUrl,
} from "./setup-core.js";
import { nextcloudTalkSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

function talkConfig(config: NonNullable<CoreConfig["channels"]>["nextcloud-talk-user"]): CoreConfig {
  return { channels: { "nextcloud-talk-user": config } };
}
const accountConfig = (config: NonNullable<CoreConfig["channels"]>["nextcloud-talk-user"]) =>
  talkConfig({
    baseUrl: "https://cloud.example.com",
    apiUser: "agent",
    apiPassword: "shared-app-password",
    ...config,
  });
const secretRef = (id: string) => ({ source: "env" as const, provider: "default", id });

let directory: string;
let apiPasswordFile: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "nextcloud-talk-user-config-"));
  apiPasswordFile = path.join(directory, "api-password");
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("Nextcloud Talk account resolution", () => {
  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = accountConfig({ accounts: { work: { enabled: false } } });

    expect(listNextcloudTalkAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultNextcloudTalkAccountId(cfg)).toBe("default");
    expect(resolveNextcloudTalkAccount({ cfg })).toMatchObject({
      accountId: "default",
      baseUrl: "https://cloud.example.com",
      apiUser: "agent",
      apiPassword: "shared-app-password",
      secretSource: "config",
      credentialStatus: "available",
    });
  });

  it("inherits and overrides inbound media config through normal account resolution", () => {
    const media = { mediaAllowFrom: ["nextcloud-talk-user:alice"], mediaMaxMb: 20 };
    const restricted = { mediaAllowFrom: ["*"], mediaMaxMb: 5 };
    const cfg = accountConfig({
      ...media,
      accounts: { inherited: {}, restricted },
    });
    for (const accountId of ["default", "inherited"]) {
      expect(resolveNextcloudTalkAccount({ cfg, accountId }).config).toMatchObject(media);
    }
    expect(resolveNextcloudTalkAccount({ cfg, accountId: "restricted" }).config).toMatchObject(
      restricted,
    );
  });

  it("isolates unavailable SecretRefs per account", () => {
    const unavailable = secretRef("MISSING_NEXTCLOUD_TALK_USER_APP_PASSWORD");
    const cfg = accountConfig({
      apiPassword: unavailable,
      accounts: {
        work: { apiPassword: unavailable },
        healthy: { apiPassword: "healthy-app-password" },
      },
    });

    for (const accountId of ["default", "work"]) {
      expect(resolveNextcloudTalkAccount({ cfg, accountId })).toMatchObject({
        accountId,
        apiPassword: "",
        secretSource: "config",
        credentialStatus: "configured_unavailable",
      });
    }
    expect(resolveNextcloudTalkAccount({ cfg, accountId: "healthy" })).toMatchObject({
      apiPassword: "healthy-app-password",
      credentialStatus: "available",
    });
  });

  it("reads the app password from apiPasswordFile and prefers an inline value", () => {
    fs.writeFileSync(apiPasswordFile, "file-app-password\n", "utf8");

    expect(
      resolveNextcloudTalkAccount({
        cfg: accountConfig({ apiPassword: undefined, apiPasswordFile }),
      }),
    ).toMatchObject({
      apiPassword: "file-app-password",
      secretSource: "passwordFile",
      credentialStatus: "available",
    });
    expect(
      resolveNextcloudTalkAccount({
        cfg: accountConfig({ apiPassword: "inline-app-password", apiPasswordFile }),
      }),
    ).toMatchObject({ apiPassword: "inline-app-password", secretSource: "config" });
  });

  it("treats a missing user or password as unconfigured", () => {
    for (const cfg of [
      accountConfig({ apiUser: undefined }),
      accountConfig({ apiPassword: undefined }),
      accountConfig({ baseUrl: undefined }),
    ]) {
      const account = resolveNextcloudTalkAccount({ cfg });
      expect(nextcloudTalkPlugin.config.isConfigured?.(account, cfg)).toBe(false);
    }
  });
});

const baseUrl = "https://cloud.example.com";
const invalidUrl = "URL must start with http:// or https://";
const { credentials, status } = nextcloudTalkSetupWizard;

it("asks for the device password in finalize, not as a standard credential", () => {
  expect(credentials).toEqual([]);
  expect(nextcloudTalkSetupWizard.finalize).toBeTypeOf("function");
});
const validateInput = expectDefined(nextcloudTalkSetupContract.validateInput, "setup validator");
const prepareInput = expectDefined(
  nextcloudTalkSetupContract.prepareAccountConfigInput,
  "setup input normalizer",
);
const prepare = (input: Parameters<typeof prepareInput>[0]["input"]) =>
  prepareInput({ cfg: {}, accountId: DEFAULT_ACCOUNT_ID, input, runtime: {} as never });
const apply = (
  input: Parameters<typeof nextcloudTalkSetupContract.applyAccountConfig>[0]["input"],
  cfg: CoreConfig = talkConfig({}),
  accountId = DEFAULT_ACCOUNT_ID,
) => nextcloudTalkSetupContract.applyAccountConfig({ cfg, accountId, input });
const validate = (
  input: Parameters<typeof validateInput>[0]["input"],
  accountId = DEFAULT_ACCOUNT_ID,
) => validateInput({ cfg: {}, accountId, input });

describe("nextcloud talk setup", () => {
  it("sets top-level DM policy state", () => {
    const base: CoreConfig = talkConfig({});
    expect(nextcloudTalkDmPolicy.getCurrent(base)).toBe("pairing");
    expect(nextcloudTalkDmPolicy.setPolicy(base, "open")).toEqual(
      talkConfig({ enabled: true, dmPolicy: "open", allowFrom: ["*"] }),
    );
  });

  it("requires user, app password and base URL and applies config patches", () => {
    const user = "agent";
    const password = "app-password";
    expect(validateNextcloudTalkBaseUrl("")).toBe("Required");
    expect(validate({ password, baseUrl } as never)).toMatch(/requires --user/);
    expect(validate({ user, baseUrl } as never)).toMatch(/requires an app password/);
    expect(validate({ user, password } as never)).toBe("Nextcloud Talk requires --base-url.");
    expect(validate({ user, password, baseUrl: "ftp://cloud.example.com" } as never)).toBe(
      invalidUrl,
    );
    expect(
      validate({ user, password, baseUrl: " https://cloud.example.com/talk/// " } as never),
    ).toBeNull();
    expect(validate({ user, passwordFile: "/run/secrets/app", baseUrl } as never)).toBeNull();

    expect(apply({ name: "Default", baseUrl: ` ${baseUrl}/// `, user, password } as never)).toEqual(
      talkConfig({
        enabled: true,
        name: "Default",
        baseUrl,
        apiUser: user,
        apiPassword: password,
      }),
    );

    expect(
      apply(
        { name: "Work", baseUrl, user, passwordFile: "/run/secrets/app" } as never,
        talkConfig({ accounts: { work: { apiPassword: "old-password" } } }),
        "work",
      ),
    ).toEqual(
      talkConfig({
        enabled: true,
        accounts: {
          work: {
            enabled: true,
            name: "Work",
            baseUrl,
            apiUser: user,
            apiPasswordFile: "/run/secrets/app",
          },
        },
      }),
    );
  });

  it("normalizes setup input before applying account config", async () => {
    expect(await prepare({ baseUrl, user: " agent ", password: "pw" } as never)).toMatchObject(
      { baseUrl, user: "agent", password: "pw" },
    );
  });

  it("uses configured defaultAccount for omitted setup configured state", () => {
    const configured = status.resolveConfigured({
      cfg: talkConfig({
        defaultAccount: "work",
        baseUrl: "https://root.example.com",
        apiUser: "agent",
        apiPassword: "root-password",
        accounts: {
          alerts: { baseUrl: "https://alerts.example.com", apiPassword: "alerts-password" },
          work: { baseUrl: "", apiPassword: "" },
        },
      }),
    });

    expect(configured).toBe(false);
  });
});

describe("resolveNextcloudTalkAccount with password files", () => {
  it("does not fall through from a missing explicit password file", () => {
    const account = resolveNextcloudTalkAccount({
      cfg: talkConfig({
        baseUrl,
        apiUser: "agent",
        apiPasswordFile: path.join(directory, "missing-password.txt"),
      }),
    });
    expect(account).toMatchObject({
      apiPassword: "",
      secretSource: "passwordFile",
      credentialStatus: "configured_unavailable",
    });
    expect(JSON.stringify(account.credentialDiagnostics)).not.toContain("missing-password.txt");
  });
});

describe("nextcloud-talk-user channel status", () => {
  it.each([
    { apiPassword: "app-password", baseUrl: "https://cloud.example.com", configured: true },
    {
      apiPassword: secretRef("MISSING_TALK_APP_PASSWORD"),
      baseUrl: "https://cloud.example.com",
      configured: true,
    },
    { apiPassword: undefined, baseUrl: "https://cloud.example.com", configured: false },
    { apiPassword: "app-password", baseUrl: undefined, configured: false },
  ])("inspects user configuration as configured=$configured", async (entry) => {
    const cfg = talkConfig({
      accounts: {
        work: { apiUser: "agent", apiPassword: entry.apiPassword, baseUrl: entry.baseUrl },
      },
    });
    const account = inspectNextcloudTalkAccount({ cfg, accountId: "work" });
    expect(account.mode).toBe("user");
    expect(await nextcloudTalkPlugin.config.isConfigured?.(account, cfg)).toBe(entry.configured);
    expect(account.baseUrl).toBe(entry.baseUrl ?? "");
    expect(await nextcloudTalkPlugin.config.inspectAccount?.(cfg, "work")).toMatchObject({
      baseUrl: entry.baseUrl ? "[set]" : "[missing]",
    });
  });

  it("classifies room tokens as groups", () => {
    expect(nextcloudTalkPlugin.messaging?.inferTargetChatType?.({ to: "room:abcdefgh" })).toBe(
      "group",
    );
  });

  it("reports an unavailable app password ref without using a lower-priority file", async () => {
    fs.writeFileSync(apiPasswordFile, "lower-priority-password\n", "utf8");
    const settings = {
      baseUrl: "https://cloud.example.com",
      apiUser: "agent",
      apiPassword: secretRef("MISSING_TALK_API_PASSWORD"),
      apiPasswordFile,
    } as const;
    const cfg = talkConfig({ accounts: { work: settings } });
    expect(() => resolveNextcloudTalkApiCredentials(settings)).toThrow(/unresolved SecretRef/);
    const inspected = await nextcloudTalkPlugin.config.inspectAccount?.(cfg, "work");
    expect(inspected).toMatchObject({
      accountId: "work",
      configured: true,
      credentialStatus: "configured_unavailable",
    });
    expect(JSON.stringify(inspected)).not.toContain("lower-priority-password");
  });
});

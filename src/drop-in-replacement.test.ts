import { readFileSync } from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { NEXTCLOUD_TALK_CHANNEL_ID, resolveNextcloudTalkChannelIdentity } from "./channel-id.js";
import { buildNextcloudTalkChannelConfigSchema } from "./config-schema.js";
import { runNextcloudTalkDoctorSequence } from "./doctor.js";
import { buildNextcloudTalkDropInLegacyConfigRules, normalizeNextcloudTalkDropInConfig } from "./doctor-contract.js";
import type { CoreConfig } from "./types.js";

// Settings as the official nextcloud-talk plugin writes them.
const botPluginSettings = {
  baseUrl: "https://cloud.example.com",
  apiUser: "agent",
  apiPassword: "app-password",
  botSecret: "bot-secret",
  botSecretFile: "/run/secrets/bot",
  webhookPath: "/nextcloud-talk-webhook",
  webhookPublicUrl: "https://gateway.example.com/nextcloud-talk-webhook",
  legacyWebhook: { port: 8788, host: "127.0.0.1" },
  dmPolicy: "allowlist",
  allowFrom: ["users/alice"],
};

describe("drop-in replacement", () => {
  it("names the channel like the official plugin, the default package keeps its own name", () => {
    expect(resolveNextcloudTalkChannelIdentity(true)).toMatchObject({
      id: "nextcloud-talk",
      label: "Nextcloud Talk",
      aliases: ["nc-talk", "nc"],
    });
    expect(resolveNextcloudTalkChannelIdentity(false)).toMatchObject({
      id: "nextcloud-talk-user",
      aliases: ["nc-talk-user"],
    });
    expect(NEXTCLOUD_TALK_CHANNEL_ID).toBe("nextcloud-talk-user");
  });

  it("keeps the switch declaration that the drop-in build rewrites", () => {
    const source = readFileSync(new URL("./channel-id.ts", import.meta.url), "utf8");
    expect(source.split("export const NEXTCLOUD_TALK_DROP_IN_REPLACEMENT: boolean = false;")).toHaveLength(2);
  });

  it("accepts the settings of the official plugin only in the drop-in replacement", () => {
    const dropIn = buildNextcloudTalkChannelConfigSchema(true).runtime!;
    const standard = buildNextcloudTalkChannelConfigSchema(false).runtime!;

    expect(dropIn.safeParse(botPluginSettings).success).toBe(true);
    expect(dropIn.safeParse({ accounts: { work: botPluginSettings } }).success).toBe(true);
    expect(dropIn.safeParse({ ...botPluginSettings, legacyWebhook: false }).success).toBe(true);
    expect(dropIn.safeParse({ ...botPluginSettings, legacyWebhook: { port: 0 } }).success).toBe(false);
    expect(dropIn.safeParse({ ...botPluginSettings, unknownSetting: true }).success).toBe(false);

    expect(standard.safeParse(botPluginSettings).success).toBe(false);
    const { botSecret, botSecretFile, webhookPath, webhookPublicUrl, legacyWebhook, ...userSettings } =
      botPluginSettings;
    expect(standard.safeParse(userSettings).success).toBe(true);
  });
});

describe("drop-in replacement doctor", () => {
  const enabled = { plugins: { entries: { "nextcloud-talk": { enabled: true, config: { keep: 1 } } } } } as OpenClawConfig;
  const disabled = { plugins: { entries: { "nextcloud-talk": { enabled: false } } } } as OpenClawConfig;

  // Rules of the plugin doctor contract: OpenClaw checks them at the given config path.
  const matching = (cfg: OpenClawConfig, dropIn: boolean) =>
    buildNextcloudTalkDropInLegacyConfigRules(dropIn).filter((rule) => {
      const value = rule.path.reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], cfg);
      return value !== undefined && rule.match(value, cfg);
    });

  it("warns unless the official plugin is disabled", () => {
    expect(matching(enabled, true)).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/must be disabled.*openclaw doctor --fix/) }),
    ]);
    const installedWithoutEntry = { plugins: { installs: { "nextcloud-talk": {} } } } as OpenClawConfig;
    expect(matching(installedWithoutEntry, true)).toHaveLength(1);
    expect(matching(disabled, true)).toEqual([]);
    expect(matching(enabled, false)).toEqual([]);
  });

  it("disables the official plugin with --fix and keeps its other settings", () => {
    const mutation = normalizeNextcloudTalkDropInConfig(enabled, true);
    expect(mutation.changes).toEqual([expect.stringMatching(/Disabled plugin "nextcloud-talk"/)]);
    expect((mutation.config as { plugins: unknown }).plugins).toEqual({
      entries: { "nextcloud-talk": { enabled: false, config: { keep: 1 } } },
    });
    expect(normalizeNextcloudTalkDropInConfig(disabled, true)).toEqual({ config: disabled, changes: [] });
    expect(normalizeNextcloudTalkDropInConfig(enabled, false)).toEqual({ config: enabled, changes: [] });
  });

  it("skips the bot plugin overlap check in the drop-in replacement", async () => {
    const cfg = {
      ...enabled,
      channels: {
        // Without network access: no password, so the server checks are skipped.
        "nextcloud-talk-user": { baseUrl: "https://cloud.example.com", apiUser: "agent", rooms: { r1: {} } },
        "nextcloud-talk": { enabled: true, baseUrl: "https://cloud.example.com", rooms: { r1: {} } },
      },
    } as unknown as CoreConfig;

    const dropIn = await runNextcloudTalkDoctorSequence({ cfg, dropInReplacement: true });
    expect(dropIn.warningNotes.join("\n")).not.toMatch(/also served by the bot plugin/);

    const standard = await runNextcloudTalkDoctorSequence({ cfg, dropInReplacement: false });
    expect(standard.warningNotes.join("\n")).toMatch(/also served by the bot plugin/);
  });
});

import type { ChannelDoctorConfigMutation } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { NEXTCLOUD_TALK_DROP_IN_REPLACEMENT, NEXTCLOUD_TALK_ORIGINAL_PLUGIN_ID } from "./channel-id.js";
import {
  isNextcloudTalkOriginalPluginDisabled,
  repairNextcloudTalkDropInReplacement,
} from "./doctor-drop-in.js";

/**
 * Plugin doctor contract (doctor-contract-api), loaded by OpenClaw from the plugin manifest.
 * Unlike the channel doctor it runs even when the official plugin won the channel
 * "nextcloud-talk" and this plugin's channel registration was rejected, which is exactly the
 * case the drop-in replacement must report. Only the drop-in package declares it.
 */

type LegacyConfigRule = {
  path: string[];
  message: string;
  match: (value: unknown, root: OpenClawConfig) => boolean;
};

const id = NEXTCLOUD_TALK_ORIGINAL_PLUGIN_ID;
const message =
  `The official Nextcloud Talk plugin "${id}" must be disabled: this drop-in replacement ` +
  `(nextcloud-talk-user) registers the same channel "${id}", and OpenClaw accepts only one plugin ` +
  `per channel. Run "openclaw doctor --fix" or set plugins.entries.${id}.enabled to false.`;

function hasEntry(root: OpenClawConfig): boolean {
  const entries = (root as { plugins?: { entries?: Record<string, unknown> } }).plugins?.entries;
  return entries !== undefined && Object.hasOwn(entries, id);
}

export function buildNextcloudTalkDropInLegacyConfigRules(dropInReplacement: boolean): LegacyConfigRule[] {
  if (!dropInReplacement) {
    return [];
  }
  return [
    // The official plugin has an entry that does not disable it.
    { path: ["plugins", "entries", id], message, match: (_value, root) => !isNextcloudTalkOriginalPluginDisabled(root) },
    // The official plugin is installed but has no entry at all (enabled by default).
    { path: ["plugins", "installs", id], message, match: (_value, root) => !hasEntry(root) },
  ];
}

export function normalizeNextcloudTalkDropInConfig(
  cfg: OpenClawConfig,
  dropInReplacement: boolean,
): ChannelDoctorConfigMutation {
  return repairNextcloudTalkDropInReplacement(cfg, dropInReplacement) ?? { config: cfg, changes: [] };
}

export const legacyConfigRules = buildNextcloudTalkDropInLegacyConfigRules(NEXTCLOUD_TALK_DROP_IN_REPLACEMENT);

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): ChannelDoctorConfigMutation {
  return normalizeNextcloudTalkDropInConfig(cfg, NEXTCLOUD_TALK_DROP_IN_REPLACEMENT);
}

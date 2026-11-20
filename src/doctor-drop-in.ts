import type { ChannelDoctorConfigMutation } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { NEXTCLOUD_TALK_ORIGINAL_PLUGIN_ID } from "./channel-id.js";

/**
 * Doctor check of the drop-in replacement package: it registers the channel "nextcloud-talk" of
 * the official plugin, and OpenClaw accepts only one plugin per channel. The official plugin must
 * therefore be disabled (`plugins.entries.nextcloud-talk.enabled: false`).
 */

type PluginEntry = { enabled?: boolean } & Record<string, unknown>;
type PluginsSection = { entries?: Record<string, PluginEntry> } & Record<string, unknown>;

function pluginsSection(cfg: OpenClawConfig): PluginsSection | undefined {
  return (cfg as { plugins?: PluginsSection }).plugins;
}

export function isNextcloudTalkOriginalPluginDisabled(cfg: OpenClawConfig): boolean {
  return pluginsSection(cfg)?.entries?.[NEXTCLOUD_TALK_ORIGINAL_PLUGIN_ID]?.enabled === false;
}

/** `openclaw doctor --fix`: disables the official plugin; null when nothing needs to change. */
export function repairNextcloudTalkDropInReplacement(
  cfg: OpenClawConfig,
  dropInReplacement: boolean,
): ChannelDoctorConfigMutation | null {
  if (!dropInReplacement || isNextcloudTalkOriginalPluginDisabled(cfg)) {
    return null;
  }
  const id = NEXTCLOUD_TALK_ORIGINAL_PLUGIN_ID;
  const plugins = pluginsSection(cfg) ?? {};
  const entries = plugins.entries ?? {};
  const config = {
    ...cfg,
    plugins: { ...plugins, entries: { ...entries, [id]: { ...entries[id], enabled: false } } },
  } as OpenClawConfig;
  return {
    config,
    changes: [`Disabled plugin "${id}": replaced by nextcloud-talk-user (drop-in replacement).`],
  };
}

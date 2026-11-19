// Generates openclaw.plugin.json#channelConfigs from the built config schema.
// Replaces `openclaw plugins build`, which aborts silently for this package.
// Run after `npm run build`: node scripts/generate-manifest.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";

const { NextcloudTalkChannelConfigSchema } = await import("../dist/src/config-schema.js");
const manifestPath = new URL("../openclaw.plugin.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const channel = pkg.openclaw.channel;

const entry = {
  schema: NextcloudTalkChannelConfigSchema.schema,
  label: channel.label,
  description: channel.blurb,
  ...(NextcloudTalkChannelConfigSchema.uiHints ? { uiHints: NextcloudTalkChannelConfigSchema.uiHints } : {}),
};
if (!entry.schema || typeof entry.schema !== "object") {
  throw new Error("The config schema did not provide a JSON schema (schema).");
}
const next = { ...manifest, channelConfigs: { [channel.id]: entry } };
const text = JSON.stringify(next, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(manifestPath, "utf8") !== text) {
    console.error("openclaw.plugin.json is out of date: node scripts/generate-manifest.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(manifestPath, text);
  console.log(`Wrote channelConfigs for ${channel.id} (${Object.keys(entry.schema.properties ?? {}).length} properties).`);
}

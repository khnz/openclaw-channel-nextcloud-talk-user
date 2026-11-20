// Generates openclaw.plugin.json#channelConfigs from the built config schema.
// Replaces `openclaw plugins build`, which aborts silently for this package.
// Run after `npm run build`: node scripts/generate-manifest.mjs [--check] [--root <dir>]
// --root points to another package directory (used for the drop-in replacement package).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootIndex = process.argv.indexOf("--root");
const root = path.resolve(
  rootIndex >= 0 ? process.argv[rootIndex + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const { NextcloudTalkChannelConfigSchema } = await import(
  pathToFileURL(path.join(root, "dist/src/config-schema.js")).href
);
const manifestPath = path.join(root, "openclaw.plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
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
const next = { ...manifest, channels: [channel.id], channelConfigs: { [channel.id]: entry } };
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

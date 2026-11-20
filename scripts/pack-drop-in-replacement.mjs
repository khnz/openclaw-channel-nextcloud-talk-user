// Builds the drop-in replacement package: the same plugin (id "nextcloud-talk-user"), but its
// channel is named "nextcloud-talk" like the official OpenClaw plugin, so it can replace it.
// Usage: npm run pack:dropInReplacement
// Output: build/nextcloud-talk-user-<version>-drop-in-replacement.tgz (the repo itself stays unchanged)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, "build");
const stage = path.join(buildDir, "drop-in-replacement");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

execFileSync(npm, ["run", "--silent", "build"], { cwd: root, stdio: "inherit" });

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
for (const entry of pkg.files) {
  const source = entry.replace(/\/\*\*$/, "");
  cpSync(path.join(root, source), path.join(stage, source), { recursive: true });
}

// Flip the switch in the compiled channel identity.
const channelIdFile = path.join(stage, "dist/src/channel-id.js");
const declaration = "export const NEXTCLOUD_TALK_DROP_IN_REPLACEMENT = false;";
const compiled = readFileSync(channelIdFile, "utf8");
if (compiled.split(declaration).length !== 2) {
  throw new Error(`Expected exactly one "${declaration}" in ${channelIdFile}`);
}
writeFileSync(channelIdFile, compiled.replace(declaration, declaration.replace("false", "true")));

const { resolveNextcloudTalkChannelIdentity } = await import(pathToFileURL(channelIdFile).href);
const identity = resolveNextcloudTalkChannelIdentity(true);
const dropInPkg = {
  ...pkg,
  description: `${pkg.description} Drop-in replacement for the official nextcloud-talk channel.`,
  openclaw: {
    ...pkg.openclaw,
    channel: {
      ...pkg.openclaw.channel,
      id: identity.id,
      label: identity.label,
      selectionLabel: identity.selectionLabel,
      docsPath: identity.docsPath,
      docsLabel: identity.docsLabel,
      aliases: identity.aliases,
    },
  },
};
writeFileSync(path.join(stage, "package.json"), JSON.stringify(dropInPkg, null, 2) + "\n");

execFileSync(process.execPath, [path.join(root, "scripts/generate-manifest.mjs"), "--root", stage], {
  stdio: "inherit",
});

// Declare the plugin doctor contract (dist/doctor-contract-api.js): it warns while the official
// plugin is enabled and disables it with `openclaw doctor --fix`, even when the official plugin
// owns the channel and this plugin's channel doctor never runs.
const manifestPath = path.join(stage, "openclaw.plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.doctorContract = { ...manifest.doctorContract, configRepair: true };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const tgzName = execFileSync(npm, ["pack", "--silent", "--ignore-scripts", "--pack-destination", buildDir], {
  cwd: stage,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .pop();
const target = path.join(buildDir, `${pkg.name}-${pkg.version}-drop-in-replacement.tgz`);
if (existsSync(target)) {
  rmSync(target);
}
renameSync(path.join(buildDir, tgzName), target);
console.log(`Drop-in replacement package (channel "${identity.id}"): ${path.relative(root, target)}`);

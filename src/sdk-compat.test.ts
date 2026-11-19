import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireNextcloudTalkRuntimeConfig, sendMessageNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

/**
 * OpenClaw removes these plugin SDK paths (openclaw plugins doctor: deprecated-sdk-api).
 * The test fails as soon as plugin code imports them again.
 */
const RETIRED_SDK_SUBPATHS = [
  // removeAfter 2026-12-01; replacement: config from the runtime context (ctx.cfg)
  "openclaw/plugin-sdk/plugin-config-runtime",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

describe("OpenClaw plugin SDK compatibility", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const files = [
    ...sourceFiles(path.join(root, "src")),
    ...readdirSync(root)
      .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
      .map((entry) => path.join(root, entry)),
  ];

  it.each(RETIRED_SDK_SUBPATHS)("does not import the removed path %s", (subpath) => {
    const offenders = files.filter((file) =>
      new RegExp(`from\\s+["']${subpath.replaceAll("/", "\\/")}["']`).test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("requires the resolved runtime config when sending", async () => {
    const cfg: CoreConfig = { channels: {} };
    expect(requireNextcloudTalkRuntimeConfig(cfg, "Test")).toBe(cfg);
    expect(() => requireNextcloudTalkRuntimeConfig(undefined, "Nextcloud Talk send")).toThrow(
      /Nextcloud Talk send requires a resolved runtime config/,
    );
    await expect(
      sendMessageNextcloudTalk("room:abc123", "hello", { cfg: undefined as unknown as CoreConfig }),
    ).rejects.toThrow(/requires a resolved runtime config/);
  });
});

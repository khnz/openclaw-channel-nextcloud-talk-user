import { describe, expect, it } from "vitest";
import { resolveNextcloudTalkAccount } from "../accounts.js";
import type { CoreConfig } from "../types.js";
import { resolveNextcloudTalkNotificationLevel } from "./notification-level.js";

const cfg = (extra: Record<string, unknown> = {}): CoreConfig => ({
  channels: {
    "nextcloud-talk-user": {
      baseUrl: "https://cloud.example.test",
      apiUser: "agent",
      apiPassword: "pw",
      groupPolicy: "open",
      ...extra,
    },
  },
});
const desired = (config: CoreConfig, token: string, type = 2) =>
  resolveNextcloudTalkNotificationLevel({
    cfg: config,
    account: resolveNextcloudTalkAccount({ cfg: config }),
    room: { token, type },
  });

describe("notification level per room", () => {
  it("sets on mention when the room requires a mention (default)", () => {
    expect(desired(cfg(), "r1")).toBe(2);
  });

  it("sets always when the plugin reacts to all messages in the room", () => {
    expect(desired(cfg({ rooms: { r1: { requireMention: false } } }), "r1")).toBe(1);
  });

  it("takes requireMention: false from the wildcard room *", () => {
    expect(desired(cfg({ rooms: { "*": { requireMention: false } } }), "irgendwo")).toBe(1);
  });

  it("sets on mention again when the room requires mentions again", () => {
    expect(desired(cfg({ rooms: { r1: { requireMention: true } } }), "r1")).toBe(2);
  });

  it("sets on mention for rooms that are not allowed or disabled", () => {
    const config = cfg({
      groupPolicy: "allowlist",
      rooms: { r1: { requireMention: false, enabled: false }, r2: { requireMention: false } },
    });
    expect(desired(config, "r1")).toBe(2);
    expect(desired(config, "r3")).toBe(2);
    expect(desired(config, "r2")).toBe(1);
  });

  it("sets on mention when groups are disabled entirely", () => {
    expect(desired(cfg({ groupPolicy: "disabled", rooms: { r1: { requireMention: false } } }), "r1")).toBe(2);
  });

  it.each([
    [1, "1:1"],
    [4, "Changelog"],
    [5, "former 1:1"],
    [6, "note to self"],
  ])("leaves room type %i (%s) unchanged", (type) => {
    expect(desired(cfg({ rooms: { "*": { requireMention: false } } }), "r1", type)).toBeUndefined();
  });
});

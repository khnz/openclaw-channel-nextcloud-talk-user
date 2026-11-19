// Nextcloud Talk tests cover group policy plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  resolveNextcloudTalkAllowlistMatch,
  resolveNextcloudTalkGroupRequireMention,
  resolveNextcloudTalkGroupToolPolicy,
} from "./policy.js";

describe("nextcloud-talk-user group policy", () => {
  it("matches mention and tool settings by the exact room token only", () => {
    const cfg = {
      channels: {
        "nextcloud-talk-user": {
          rooms: {
            "team-room": {
              requireMention: false,
              tools: { allow: ["sessions.list"] },
            },
            "*": { requireMention: true, tools: { deny: ["exec"] } },
          },
        },
      },
    } as OpenClawConfig;
    const slugged = { cfg, groupId: "Team Room" };
    expect(resolveNextcloudTalkGroupRequireMention(slugged)).toBe(true);
    expect(resolveNextcloudTalkGroupToolPolicy(slugged)).toEqual({ deny: ["exec"] });

    const exact = { cfg, groupId: "team-room" };
    expect(resolveNextcloudTalkGroupRequireMention(exact)).toBe(false);
    expect(resolveNextcloudTalkGroupToolPolicy(exact)).toEqual({ allow: ["sessions.list"] });
  });

  it("falls through to wildcard fields when the exact room field is unset", () => {
    const cfg = {
      channels: {
        "nextcloud-talk-user": {
          rooms: {
            "team-room": {},
            "*": { requireMention: false, tools: { deny: ["exec"] } },
          },
        },
      },
    } as OpenClawConfig;
    const params = { cfg, groupId: "team-room" };

    expect(resolveNextcloudTalkGroupRequireMention(params)).toBe(false);
    expect(resolveNextcloudTalkGroupToolPolicy(params)).toEqual({ deny: ["exec"] });
  });
});

describe("nextcloud-talk-user user allowlist comparison", () => {
  it.each([
    ["alice", "users/alice", true],
    ["users/alice", "alice", true],
    ["  nc-talk-user:Users/Alice  ", "nextcloud-talk-user:users/ALICE", true],
    ["alice", "guests/alice", false],
    ["alice", "emails/alice", false],
    ["alice", "federated_users/alice", false],
    ["alice", "bots/alice", false],
    ["alice", "users/alice2", false],
    ["alice", "users/malice", false],
    ["users/*", "users/bob", false],
    ["*", "users/bob", true],
  ])("matches %s against %s: %s", (entry, senderId, allowed) => {
    expect(resolveNextcloudTalkAllowlistMatch({ allowFrom: [entry], senderId }).allowed).toBe(
      allowed,
    );
  });
});

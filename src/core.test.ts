import { describe, expect, it } from "vitest";
import {
  looksLikeNextcloudTalkTargetId as looksLikeTargetId,
  normalizeNextcloudTalkMessagingTarget as normalizeTarget,
  stripNextcloudTalkTargetPrefix as stripPrefix,
} from "./normalize.js";
import { resolveNextcloudTalkAllowlistMatch as resolveAllowlistMatch } from "./policy.js";

describe("nextcloud talk core", () => {
  it("normalizes and recognizes supported room target formats", () => {
    expect(stripPrefix(" room:abc123 ")).toBe("abc123");
    expect(stripPrefix("nextcloud-talk-user:room:AbC123")).toBe("AbC123");
    expect(stripPrefix("nc-talk-user:room:ops")).toBe("ops");
    expect(stripPrefix("NC-TALK-USER:ROOM:Ops")).toBe("Ops");
    expect(stripPrefix("room:   ")).toBeUndefined();

    expect(normalizeTarget("room:AbC123")).toBe("nextcloud-talk-user:abc123");
    expect(normalizeTarget("nc-talk-user:room:Ops")).toBe("nextcloud-talk-user:ops");
    expect(normalizeTarget("NEXTCLOUD-TALK-USER:ROOM:Ops")).toBe("nextcloud-talk-user:ops");

    expect(looksLikeTargetId("nextcloud-talk-user:room:abc12345")).toBe(true);
    expect(looksLikeTargetId("nc-talk-user:opsroom1")).toBe(true);
    expect(looksLikeTargetId("room:opsroom1")).toBe(true);
    expect(looksLikeTargetId("abc12345")).toBe(true);
    expect(looksLikeTargetId("")).toBe(false);
  });

  it("resolves allowlist matches", () => {
    const match = (allowFrom: string[], senderId = "user-id") =>
      resolveAllowlistMatch({ allowFrom, senderId });
    expect(match(["*"]).allowed).toBe(true);
    expect(match(["nc-talk-user:User-Id"])).toEqual({
      allowed: true,
      matchKey: "users/user-id",
      matchSource: "id",
    });
    expect(match(["allowed"], "other").allowed).toBe(false);
  });
});

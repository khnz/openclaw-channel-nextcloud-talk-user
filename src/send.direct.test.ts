import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../runtime-api.js";
import { nextcloudTalkPlugin } from "./channel.js";
import { normalizeNextcloudTalkMessagingTarget, parseNextcloudTalkTarget } from "./normalize.js";
import { clearNextcloudTalkDirectRoomCache, sendMessageNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

// Room release is covered in room-access.test.ts; this file exercises the transport only.
vi.mock("./room-access.js", () => ({ assertNextcloudTalkRoomAccess: vi.fn(async () => {}) }));

vi.mock("../runtime-api.js", () => ({ fetchWithSsrFGuard: vi.fn() }));

afterEach(() => {
  vi.mocked(fetchWithSsrFGuard).mockReset();
  clearNextcloudTalkDirectRoomCache();
});

const cfg = (extra: Record<string, unknown> = {}): CoreConfig => ({
  channels: {
    "nextcloud-talk-user": {
      baseUrl: "https://cloud.example.test",
      apiUser: "agent",
      apiPassword: "app-password",
      allowFrom: ["users/alice"],
      ...extra,
    },
  },
});

/** Fakes room creation (200 = existing, 201 = new) and chat sending. */
function server(createStatus = 200) {
  const calls: { method: string; path: string; body: URLSearchParams }[] = [];
  vi.mocked(fetchWithSsrFGuard).mockImplementation(async (params) => {
    params.beforeRequest?.();
    const url = new URL(params.url);
    const body = new URLSearchParams(typeof params.init?.body === "string" ? params.init.body : "");
    calls.push({ method: String(params.init?.method), path: url.pathname, body });
    const respond = (status: number, data: unknown) => ({
      response: new Response(JSON.stringify({ ocs: { data } }), { status }),
      release: async () => {},
      finalUrl: params.url,
    });
    if (url.pathname.endsWith("/api/v4/room")) {
      return createStatus === 200 || createStatus === 201
        ? respond(createStatus, { token: "dm-alice", type: 1 })
        : respond(createStatus, {});
    }
    if (url.pathname.includes("/api/v1/chat/")) {
      return respond(201, { id: 99, timestamp: 1_700_000_000 });
    }
    throw new Error(`unexpected ${url.pathname}`);
  });
  return calls;
}

describe("targets: room or person", () => {
  it.each([
    ["room:AbC12345", { kind: "room", token: "AbC12345" }],
    ["abc12345", { kind: "room", token: "abc12345" }],
    ["user:Alice", { kind: "user", userId: "Alice" }],
    ["users/alice", { kind: "user", userId: "alice" }],
    ["nextcloud-talk-user:user:alice", { kind: "user", userId: "alice" }],
  ])("%s", (raw, expected) => {
    expect(parseNextcloudTalkTarget(raw)).toEqual(expected);
  });

  it("normalizes person targets without lowercasing the UID", () => {
    expect(normalizeNextcloudTalkMessagingTarget("users/Alice")).toBe("nextcloud-talk-user:user:Alice");
    expect(normalizeNextcloudTalkMessagingTarget("room:ABC")).toBe("nextcloud-talk-user:abc");
  });

  it("maps person targets to the direct message session users/<uid>", () => {
    expect(nextcloudTalkPlugin.messaging?.inferTargetChatType?.({ to: "user:alice" })).toBe("direct");
    const route = nextcloudTalkPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: cfg() as never,
      agentId: "main",
      accountId: "default",
      target: "user:alice",
    } as never);
    expect(route).toMatchObject({ chatType: "direct", peer: { kind: "direct", id: "users/alice" } });
  });
});

describe("proactive direct messages", () => {
  it("fetches or creates the 1:1 room and sends there", async () => {
    const calls = server(201);
    const result = await sendMessageNextcloudTalk("user:alice", "Hello", { cfg: cfg() });

    expect(calls[0]).toMatchObject({ method: "POST", path: "/ocs/v2.php/apps/spreed/api/v4/room" });
    expect(Object.fromEntries(calls[0]!.body)).toEqual({ roomType: "1", invite: "alice" });
    expect(calls[1]?.path).toBe("/ocs/v2.php/apps/spreed/api/v1/chat/dm-alice");
    expect(result).toMatchObject({ roomToken: "dm-alice", messageId: "99" });
  });

  it("creates the room only once per person (cache)", async () => {
    const calls = server(200);
    await sendMessageNextcloudTalk("users/alice", "eins", { cfg: cfg() });
    await sendMessageNextcloudTalk("users/alice", "zwei", { cfg: cfg() });
    expect(calls.filter((c) => c.path.endsWith("/v4/room"))).toHaveLength(1);
  });

  it("refuses people not in allowFrom without a request", async () => {
    const calls = server();
    await expect(sendMessageNextcloudTalk("user:bob", "Hello", { cfg: cfg() })).rejects.toThrow(/not in .*allowFrom/);
    expect(calls).toHaveLength(0);
  });

  it("allows any person with allowFrom ['*']", async () => {
    server(201);
    await expect(
      sendMessageNextcloudTalk("user:bob", "Hello", { cfg: cfg({ allowFrom: ["*"] }) }),
    ).resolves.toMatchObject({ roomToken: "dm-alice" });
  });

  it("refuses with proactiveDm: off", async () => {
    const calls = server();
    await expect(
      sendMessageNextcloudTalk("user:alice", "Hello", { cfg: cfg({ proactiveDm: "off" }) }),
    ).rejects.toThrow(/disabled/);
    expect(calls).toHaveLength(0);
  });

  it("refuses its own user as target", async () => {
    server();
    await expect(
      sendMessageNextcloudTalk("user:agent", "Hello", { cfg: cfg({ allowFrom: ["*"] }) }),
    ).rejects.toThrow(/own user/);
  });

  it("reports unknown people clearly", async () => {
    server(404);
    await expect(sendMessageNextcloudTalk("user:alice", "Hello", { cfg: cfg() })).rejects.toThrow(/not found/);
  });

  it("sends to room targets as before without creating a room", async () => {
    const calls = server();
    await sendMessageNextcloudTalk("room:abc12345", "Hello", { cfg: cfg() });
    expect(calls.map((c) => c.path)).toEqual(["/ocs/v2.php/apps/spreed/api/v1/chat/abc12345"]);
  });
});

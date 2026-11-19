import { describe, expect, it, vi } from "vitest";
import type { NextcloudTalkInboundMessage } from "../types.js";
import { createNextcloudTalkReceiveMonitor, type NextcloudTalkWebSocketLike } from "./monitor.js";
import { createNextcloudTalkMemoryReceiveStateStore } from "./state.js";
import { createNextcloudTalkClient, type NextcloudTalkRawHttp } from "./talk-client.js";

const BASE = "https://cloud.example.test";

type Msg = {
  id: number;
  token: string;
  actorType: string;
  actorId: string;
  actorDisplayName?: string;
  timestamp: number;
  message: string;
  messageParameters: Record<string, unknown> | unknown[];
  messageType: string;
  systemMessage?: string;
};

/** Fake Talk server: rooms, chat, notifications, capabilities. */
function fakeTalk() {
  const rooms = new Map<
    string,
    { type: number; displayName: string; messages: Msg[]; status?: number; notificationLevel: number }
  >();
  const notifications: Record<string, unknown>[] = [];
  const calls: { method: string; path: string; query: URLSearchParams; body?: string }[] = [];
  let nextId = 100;
  let authStatus = 200;
  let etag = 1;
  const server = {
    calls,
    addRoom(token: string, type = 2, displayName = token) {
      rooms.set(token, { type, displayName, messages: [], notificationLevel: type === 1 ? 1 : 2 });
    },
    post(token: string, actorId: string, message: string, extra: Partial<Msg> = {}) {
      const id = nextId++;
      rooms.get(token)!.messages.push({
        id,
        token,
        actorType: "users",
        actorId,
        actorDisplayName: actorId,
        timestamp: 1_700_000_000 + id,
        message,
        messageParameters: [],
        messageType: "comment",
        ...extra,
      });
      return id;
    },
    level(token: string) {
      return rooms.get(token)!.notificationLevel;
    },
    setRoomStatus(token: string, status: number) {
      rooms.get(token)!.status = status;
    },
    notify(token: string, messageId: number) {
      notifications.push({ app: "spreed", object_type: "chat", object_id: `${token}/${messageId}` });
      etag++;
    },
    revoke() {
      authStatus = 401;
    },
    http: (async ({ url, init }) => {
      const parsed = new URL(url);
      calls.push({
        method: String(init.method),
        path: parsed.pathname,
        query: parsed.searchParams,
        body: typeof init.body === "string" ? init.body : undefined,
      });
      const json = (data: unknown, headers: Record<string, string> = {}, status = 200) => ({
        status,
        headers: new Headers(headers),
        text: JSON.stringify({ ocs: { data } }),
      });
      if (authStatus !== 200) {
        return { status: authStatus, headers: new Headers(), text: "" };
      }
      const path = parsed.pathname;
      if (path === "/ocs/v2.php/cloud/capabilities") {
        return json({ capabilities: { user_status: { enabled: true } } });
      }
      if (path === "/ocs/v2.php/apps/spreed/api/v4/room") {
        return json(
          [...rooms].map(([token, room]) => ({
            token,
            type: room.type,
            displayName: room.displayName,
            notificationLevel: room.notificationLevel,
            lastMessage: room.messages.at(-1) ?? null,
          })),
          { "x-nextcloud-talk-modified-before": "1" },
        );
      }
      const notify = path.match(/^\/ocs\/v2\.php\/apps\/spreed\/api\/v4\/room\/([^/]+)\/notify$/u);
      if (notify && init.method === "POST") {
        const room = rooms.get(decodeURIComponent(notify[1]!));
        if (!room) {
          return { status: 404, headers: new Headers(), text: "" };
        }
        const level = Number(new URLSearchParams(String(init.body)).get("level"));
        if (![1, 2, 3].includes(level)) {
          return { status: 400, headers: new Headers(), text: "" };
        }
        room.notificationLevel = level;
        return json({});
      }
      const chat = path.match(/^\/ocs\/v2\.php\/apps\/spreed\/api\/v1\/chat\/([^/]+)(\/read)?$/u);
      if (chat) {
        const room = rooms.get(decodeURIComponent(chat[1]!));
        if (!room) {
          return { status: 404, headers: new Headers(), text: "" };
        }
        if (chat[2]) {
          return json({});
        }
        if (room.status) {
          return { status: room.status, headers: new Headers(), text: "" };
        }
        const after = Number(parsed.searchParams.get("lastKnownMessageId"));
        const limit = Number(parsed.searchParams.get("limit"));
        const batch = room.messages.filter((m) => m.id > after).slice(0, limit);
        if (batch.length === 0) {
          return { status: 304, headers: new Headers(), text: "" };
        }
        return json(batch, { "x-chat-last-given": String(batch.at(-1)!.id) });
      }
      if (path === "/ocs/v2.php/apps/notifications/api/v2/notifications") {
        const tag = `"${etag}"`;
        const header = new Headers(init.headers as Record<string, string>).get("If-None-Match");
        if (header === tag) {
          return { status: 304, headers: new Headers(), text: "" };
        }
        return json(notifications, { etag: tag });
      }
      if (path === "/ocs/v2.php/apps/user_status/api/v1/heartbeat") {
        return json({ status: "online" });
      }
      return { status: 500, headers: new Headers(), text: "" };
    }) as NextcloudTalkRawHttp,
  };
  return server;
}

function setup(
  server: ReturnType<typeof fakeTalk>,
  options: {
    deliverResult?: boolean;
    resolveNotificationLevel?: (room: { token: string; type: number }) => 1 | 2 | undefined;
    deliveryRetryDelaysMs?: number[];
  } = {},
) {
  const controller = new AbortController();
  const delivered: NextcloudTalkInboundMessage[] = [];
  const stopped = vi.fn();
  const errors: string[] = [];
  const deliver = vi.fn(async (message: NextcloudTalkInboundMessage) => {
    delivered.push(message);
    return options.deliverResult ?? true;
  });
  const store = createNextcloudTalkMemoryReceiveStateStore();
  const client = createNextcloudTalkClient({ baseUrl: BASE, user: "agent", appPassword: "pw", http: server.http });
  const monitor = createNextcloudTalkReceiveMonitor({
    client,
    store,
    deliver,
    signal: controller.signal,
    onStopped: stopped,
    pollIntervalMs: 60_000,
    pollIntervalWithoutPushMs: 60_000,
    resolveNotificationLevel: options.resolveNotificationLevel,
    deliveryRetryDelaysMs: options.deliveryRetryDelaysMs ?? [0, 0],
    error: (message) => errors.push(message),
  });
  return { monitor, controller, delivered, deliver, stopped, store, errors };
}

async function started(server: ReturnType<typeof fakeTalk>, options?: Parameters<typeof setup>[1]) {
  const env = setup(server, options);
  const running = env.monitor.run();
  await vi.waitFor(() => expect(server.calls.some((c) => c.path.endsWith("/v4/room"))).toBe(true));
  await vi.waitFor(() => expect(env.store.current.rooms).not.toEqual({}));
  return { ...env, running };
}

describe("receive monitor", () => {
  it("does not replay old history on first contact", async () => {
    const server = fakeTalk();
    server.addRoom("r1");
    const old = server.post("r1", "alice", "old");
    const env = await started(server);

    expect(env.store.current.rooms.r1).toEqual({ cursor: old });
    expect(env.delivered).toEqual([]);
    env.controller.abort();
    await env.running;
  });

  it("hands new messages over exactly once, advances the cursor and marks them read", async () => {
    const server = fakeTalk();
    server.addRoom("r1");
    const env = await started(server);
    const id = server.post("r1", "alice", "new");

    await env.monitor.syncRooms(false);
    await env.monitor.syncRooms(false);

    expect(env.delivered.map((m) => m.messageId)).toEqual([String(id)]);
    expect(env.store.current.rooms.r1?.cursor).toBe(id);
    const read = server.calls.find((c) => c.path.endsWith("/read"));
    expect(read?.body).toBe(`lastReadMessage=${id}`);
    const fetch = server.calls.find((c) => c.path.endsWith("/chat/r1"));
    expect(fetch?.query.get("setReadMarker")).toBe("0");
    expect(fetch?.query.get("noStatusUpdate")).toBe("1");
    expect(fetch?.query.get("timeout")).toBe("0");
    env.controller.abort();
    await env.running;
  });

  it("skips own messages and bot messages without handing them over", async () => {
    const server = fakeTalk();
    server.addRoom("r1");
    const env = await started(server);
    server.post("r1", "agent", "own");
    server.post("r1", "bot-1", "bot", { actorType: "bots" });
    const last = server.post("r1", "alice", "echt");

    await env.monitor.syncRooms(false);

    expect(env.delivered.map((m) => m.text)).toEqual(["echt"]);
    expect(env.store.current.rooms.r1?.cursor).toBe(last);
    env.controller.abort();
    await env.running;
  });

  it("does not mark as read when inbound dropped the message", async () => {
    const server = fakeTalk();
    server.addRoom("r1");
    const env = await started(server, { deliverResult: false });
    server.post("r1", "stranger", "hello");

    await env.monitor.syncRooms(false);

    expect(env.delivered).toHaveLength(1);
    expect(server.calls.some((c) => c.path.endsWith("/read"))).toBe(false);
    env.controller.abort();
    await env.running;
  });

  it("keeps the cursor when the handoff fails and tries again", async () => {
    const server = fakeTalk();
    server.addRoom("r1");
    const env = await started(server);
    const start = env.store.current.rooms.r1?.cursor;
    env.deliver.mockRejectedValueOnce(new Error("broken"));
    const id = server.post("r1", "alice", "important");

    await env.monitor.syncRooms(false);
    expect(env.store.current.rooms.r1?.cursor).toBe(start);

    await env.monitor.syncRooms(false);
    expect(env.store.current.rooms.r1?.cursor).toBe(id);
    expect(env.deliver).toHaveBeenCalledTimes(2);
    env.controller.abort();
    await env.running;
  });

  it("skips a message after the last failed attempt instead of blocking the room", async () => {
    const server = fakeTalk();
    server.addRoom("r1");
    const env = await started(server);
    env.deliver.mockRejectedValue(new Error("permanently broken"));
    const poison = server.post("r1", "alice", "poison");

    // Delays [0, 0]: three attempts, then skipped.
    await env.monitor.syncRooms(false);
    await env.monitor.syncRooms(false);
    expect(env.store.current.rooms.r1?.cursor).toBeLessThan(poison);
    await env.monitor.syncRooms(false);
    expect(env.store.current.rooms.r1?.cursor).toBe(poison);
    expect(env.deliver).toHaveBeenCalledTimes(3);
    expect(env.errors.at(-1)).toContain(`skipped message ${poison} after 3 failed attempts`);

    env.deliver.mockReset();
    env.deliver.mockResolvedValue(true);
    const next = server.post("r1", "alice", "after");
    await env.monitor.syncRooms(false);
    expect(env.deliver).toHaveBeenCalledOnce();
    expect(env.store.current.rooms.r1?.cursor).toBe(next);
    env.controller.abort();
    await env.running;
  });

  it("waits out the delay after a failed attempt and then retries on its own", async () => {
    const server = fakeTalk();
    server.addRoom("r1");
    const env = await started(server, { deliveryRetryDelaysMs: [200] });
    env.deliver.mockRejectedValueOnce(new Error("briefly broken"));
    const id = server.post("r1", "alice", "important");
    const later = server.post("r1", "alice", "later");

    await env.monitor.syncRooms(false);
    expect(env.deliver).toHaveBeenCalledTimes(1);
    // No new attempt during the delay, not even for later messages.
    await env.monitor.syncRooms(false);
    expect(env.deliver).toHaveBeenCalledTimes(1);
    expect(env.errors.at(-1)).toContain("retrying in 0 s");

    await vi.waitFor(() => expect(env.store.current.rooms.r1?.cursor).toBe(later), { timeout: 3000 });
    expect(env.deliver).toHaveBeenCalledTimes(3);
    expect(env.delivered.map((m) => m.messageId)).toEqual([String(id), String(later)]);
    env.controller.abort();
    await env.running;
  });

  it("pauses a room after 404 and does not query it again until the next full sync", async () => {
    const server = fakeTalk();
    server.addRoom("r1");
    const env = await started(server);
    server.post("r1", "alice", "x");
    server.setRoomStatus("r1", 404);

    await env.monitor.syncRooms(false);
    server.post("r1", "alice", "y");
    await env.monitor.syncRooms(false);

    expect(server.calls.filter((c) => c.path.endsWith("/chat/r1"))).toHaveLength(1);
    expect(env.monitor.snapshot().disabledRooms).toEqual(["r1"]);
    env.controller.abort();
    await env.running;
  });

  it("limits catching up to maxCatchUp messages", async () => {
    const server = fakeTalk();
    server.addRoom("r1");
    const env = await started(server);
    const ids = Array.from({ length: 60 }, (_, i) => server.post("r1", "alice", `m${i}`));

    await env.monitor.syncRooms(false);

    expect(env.delivered).toHaveLength(50);
    expect(env.delivered[0]?.messageId).toBe(String(ids[10]));
    expect(env.store.current.rooms.r1?.cursor).toBe(ids.at(-1));
    env.controller.abort();
    await env.running;
  });

  it("fetches messages via notifications (ETag)", async () => {
    const server = fakeTalk();
    server.addRoom("r1");
    const env = await started(server);
    const id = server.post("r1", "alice", "@agent hello");
    server.notify("r1", id);

    await env.monitor.triggerNotifications();
    await env.monitor.triggerNotifications();

    expect(env.delivered.map((m) => m.messageId)).toEqual([String(id)]);
    env.controller.abort();
    await env.running;
  });

  it("stops everything after a 401 and sends no further requests", async () => {
    const server = fakeTalk();
    server.addRoom("r1");
    const env = await started(server);
    server.revoke();

    await env.monitor.syncRooms(false);
    const count = server.calls.length;
    await env.monitor.syncRooms(false).catch(() => undefined);

    expect(env.stopped).toHaveBeenCalledOnce();
    expect(server.calls.length).toBe(count);
    env.controller.abort();
    await env.running;
  });

  it("sets the notification level on join only when it differs, and only once", async () => {
    const server = fakeTalk();
    server.addRoom("all", 2);
    server.addRoom("mention", 2);
    server.addRoom("dm", 1);
    const env = await started(server, {
      resolveNotificationLevel: (room) =>
        room.type === 1 ? undefined : room.token === "all" ? 1 : 2,
    });

    expect(server.level("all")).toBe(1);
    expect(server.level("mention")).toBe(2);
    expect(server.level("dm")).toBe(1);
    // "mention" already was 2: no request needed.
    const notifyCalls = () => server.calls.filter((c) => c.path.endsWith("/notify"));
    expect(notifyCalls().map((c) => c.path.split("/").at(-2))).toEqual(["all"]);

    await env.monitor.syncRooms(true);
    expect(notifyCalls()).toHaveLength(1);
    env.controller.abort();
    await env.running;
  });

  it("switches the level on the next sync after a config change", async () => {
    const server = fakeTalk();
    server.addRoom("r1", 2);
    let wantAll = true;
    const env = await started(server, { resolveNotificationLevel: () => (wantAll ? 1 : 2) });
    expect(server.level("r1")).toBe(1);

    wantAll = false;
    await env.monitor.syncRooms(true);

    expect(server.level("r1")).toBe(2);
    env.controller.abort();
    await env.running;
  });

  it("signs in to the push channel with a one-time token and reacts to signals", async () => {
    const server = fakeTalk();
    server.addRoom("r1");
    const sockets: (NextcloudTalkWebSocketLike & { sent: string[] })[] = [];
    const http: NextcloudTalkRawHttp = async (params) => {
      const path = new URL(params.url).pathname;
      if (path === "/ocs/v2.php/cloud/capabilities") {
        return {
          status: 200,
          headers: new Headers(),
          text: JSON.stringify({
            ocs: {
              data: {
                capabilities: {
                  notify_push: {
                    endpoints: {
                      websocket: "wss://internal.example/push/ws",
                      pre_auth: `${BASE}/apps/notify_push/pre_auth`,
                    },
                  },
                },
              },
            },
          }),
        };
      }
      if (path === "/apps/notify_push/pre_auth") {
        return { status: 200, headers: new Headers(), text: "one-time-token" };
      }
      return server.http(params);
    };
    const controller = new AbortController();
    const urls: string[] = [];
    const monitor = createNextcloudTalkReceiveMonitor({
      client: createNextcloudTalkClient({ baseUrl: BASE, user: "agent", appPassword: "pw", http }),
      store: createNextcloudTalkMemoryReceiveStateStore(),
      deliver: async () => true,
      signal: controller.signal,
      pollIntervalMs: 60_000,
      pollIntervalWithoutPushMs: 60_000,
      createWebSocket: (url) => {
        urls.push(url);
        const ws = {
          sent: [] as string[],
          send(data: string) {
            ws.sent.push(data);
          },
          close() {
            ws.onclose?.({});
          },
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
        } as NextcloudTalkWebSocketLike & { sent: string[] };
        sockets.push(ws);
        queueMicrotask(() => ws.onopen?.({}));
        return ws;
      },
    });
    const running = monitor.run();
    await vi.waitFor(() => expect(sockets[0]?.sent).toEqual(["", "one-time-token"]));
    // Advertised URL on a foreign host -> falls back to the baseUrl host.
    expect(urls[0]).toBe("wss://cloud.example.test/push/ws");

    sockets[0]!.onmessage?.({ data: "authenticated" });
    await vi.waitFor(() => expect(monitor.snapshot().pushConnected).toBe(true));
    const before = server.calls.filter((c) => c.path.endsWith("/notifications")).length;
    sockets[0]!.onmessage?.({ data: "notify_notification" });
    await vi.waitFor(() =>
      expect(server.calls.filter((c) => c.path.endsWith("/notifications")).length).toBeGreaterThan(before),
    );
    controller.abort();
    await running;
  });

  it("polls at the short interval after a failed sync even while push counts as connected", async () => {
    const server = fakeTalk();
    server.addRoom("r1");
    const sockets: NextcloudTalkWebSocketLike[] = [];
    const roomListCalls: number[] = [];
    let failRoomList = false;
    const http: NextcloudTalkRawHttp = async (params) => {
      const path = new URL(params.url).pathname;
      if (path === "/ocs/v2.php/cloud/capabilities") {
        return {
          status: 200,
          headers: new Headers(),
          text: JSON.stringify({
            ocs: {
              data: {
                capabilities: {
                  notify_push: {
                    endpoints: { websocket: `wss://cloud.example.test/push/ws`, pre_auth: `${BASE}/apps/notify_push/pre_auth` },
                  },
                },
              },
            },
          }),
        };
      }
      if (path === "/apps/notify_push/pre_auth") {
        return { status: 200, headers: new Headers(), text: "one-time-token" };
      }
      if (path.endsWith("/v4/room")) {
        roomListCalls.push(Date.now());
        if (failRoomList) {
          failRoomList = false;
          throw new Error("request timed out");
        }
      }
      return server.http(params);
    };
    const controller = new AbortController();
    const monitor = createNextcloudTalkReceiveMonitor({
      client: createNextcloudTalkClient({ baseUrl: BASE, user: "agent", appPassword: "pw", http }),
      store: createNextcloudTalkMemoryReceiveStateStore(),
      deliver: async () => true,
      signal: controller.signal,
      pollIntervalMs: 400,
      pollIntervalWithoutPushMs: 20,
      createWebSocket: () => {
        const ws = { send() {}, close() { ws.onclose?.({}); }, onopen: null, onmessage: null, onclose: null, onerror: null } as NextcloudTalkWebSocketLike;
        sockets.push(ws);
        queueMicrotask(() => ws.onopen?.({}));
        return ws;
      },
    });
    const running = monitor.run();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.onmessage?.({ data: "authenticated" });
    await vi.waitFor(() => expect(monitor.snapshot().pushConnected).toBe(true));

    const start = roomListCalls.length;
    failRoomList = true;
    // Failure on the next regular run (400 ms), then the short interval (20 ms).
    await vi.waitFor(() => expect(roomListCalls.length).toBeGreaterThanOrEqual(start + 2), { timeout: 3000 });
    const failedAt = roomListCalls[start]!;
    const retriedAt = roomListCalls[start + 1]!;
    expect(retriedAt - failedAt).toBeLessThan(250);
    controller.abort();
    await running;
  });
});

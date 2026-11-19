import { describe, expect, it } from "vitest";
import { resolveNextcloudTalkAccount } from "../accounts.js";
import type { CoreConfig } from "../types.js";
import { resolveNextcloudTalkAutoJoinPolicy } from "./auto-join.js";
import { createNextcloudTalkReceiveMonitor } from "./monitor.js";
import { createNextcloudTalkMemoryReceiveStateStore } from "./state.js";
import { createNextcloudTalkClient, type NextcloudTalkRawHttp } from "./talk-client.js";

const BASE = "https://cloud.example.test";

type Listed = { token: string; lobbyState?: number; hasPassword?: boolean; displayName?: string };

/** Open rooms (listed-room), memberships and joining with a session cookie. */
function fakeServer(listed: Listed[]) {
  const members = new Set<string>();
  const calls: { method: string; path: string; cookie?: string }[] = [];
  const http: NextcloudTalkRawHttp = async ({ url, init }) => {
    const path = new URL(url).pathname;
    const headers = new Headers(init.headers as Record<string, string>);
    calls.push({ method: String(init.method), path, cookie: headers.get("Cookie") ?? undefined });
    const ok = (data: unknown, extra: Record<string, string> = {}, setCookie?: string) => {
      const h = new Headers(extra);
      if (setCookie) {
        h.append("set-cookie", setCookie);
      }
      return { status: 200, headers: h, text: JSON.stringify({ ocs: { data } }) };
    };
    if (path === "/ocs/v2.php/cloud/capabilities") {
      return ok({ capabilities: {} });
    }
    if (path === "/ocs/v2.php/apps/spreed/api/v4/room") {
      return ok(
        [...members].map((token) => ({ token, type: 2, displayName: token, notificationLevel: 2 })),
        { "x-nextcloud-talk-modified-before": "1" },
      );
    }
    if (path === "/ocs/v2.php/apps/spreed/api/v4/listed-room") {
      return ok(
        listed
          .filter((room) => !members.has(room.token))
          .map((room) => ({ type: 2, lobbyState: 0, hasPassword: false, ...room })),
      );
    }
    const active = path.match(/\/room\/([^/]+)\/participants\/active$/u);
    if (active) {
      const token = decodeURIComponent(active[1]!);
      if (init.method === "POST") {
        members.add(token);
        return ok({ token }, {}, "nc_session=abc123; path=/; HttpOnly");
      }
      return ok({});
    }
    if (path === "/ocs/v2.php/apps/notifications/api/v2/notifications") {
      return ok([]);
    }
    return { status: 500, headers: new Headers(), text: "" };
  };
  return { http, members, calls, remove: (token: string) => members.delete(token) };
}

function monitorFor(
  server: ReturnType<typeof fakeServer>,
  autoJoin: () => { enabled: boolean; isAllowed: (token: string) => boolean },
) {
  const controller = new AbortController();
  const store = createNextcloudTalkMemoryReceiveStateStore();
  const logs: string[] = [];
  const monitor = createNextcloudTalkReceiveMonitor({
    client: createNextcloudTalkClient({ baseUrl: BASE, user: "agent", appPassword: "pw", http: server.http }),
    store,
    deliver: async () => true,
    signal: controller.signal,
    get autoJoin() {
      return autoJoin();
    },
    log: (message) => logs.push(message),
    pollIntervalMs: 60_000,
    pollIntervalWithoutPushMs: 60_000,
  });
  return { monitor, controller, store, logs };
}

describe("autoJoin config", () => {
  const cfg = (extra: Record<string, unknown>): CoreConfig => ({
    channels: { "nextcloud-talk-user": { baseUrl: BASE, apiUser: "agent", apiPassword: "pw", ...extra } },
  });
  const policy = (config: CoreConfig) => resolveNextcloudTalkAutoJoinPolicy(resolveNextcloudTalkAccount({ cfg: config }));

  it("is off by default and on with autoJoin: true", () => {
    expect(policy(cfg({})).enabled).toBe(false);
    expect(policy(cfg({ autoJoin: true })).enabled).toBe(true);
  });

  it("joins nothing with groupPolicy disabled", () => {
    expect(policy(cfg({ autoJoin: true, groupPolicy: "disabled" })).enabled).toBe(false);
  });

  it("allows all rooms without a room list, only listed ones with a room list", () => {
    expect(policy(cfg({ autoJoin: true })).isAllowed("x")).toBe(true);
    const listed = policy(cfg({ autoJoin: true, rooms: { a: {}, b: { enabled: false } } }));
    expect([listed.isAllowed("a"), listed.isAllowed("b"), listed.isAllowed("c")]).toEqual([true, false, false]);
    expect(policy(cfg({ autoJoin: true, rooms: { "*": {} } })).isAllowed("c")).toBe(true);
  });
});

describe("auto-joining open rooms", () => {
  it("joins an open room, leaves the session with the same cookie and replays no history", async () => {
    const server = fakeServer([{ token: "open", displayName: "Open room" }]);
    const env = monitorFor(server, () => ({ enabled: true, isAllowed: () => true }));
    const running = env.monitor.run();
    await expect.poll(() => server.members.has("open")).toBe(true);
    await expect.poll(() => env.store.current.rooms.open).toBeDefined();

    const post = server.calls.find((c) => c.method === "POST" && c.path.endsWith("/participants/active"));
    const del = server.calls.find((c) => c.method === "DELETE" && c.path.endsWith("/participants/active"));
    expect(post).toBeDefined();
    expect(del?.cookie).toBe("nc_session=abc123");
    expect(env.store.current.autoJoin?.open?.joinedAt).toBeTypeOf("number");
    env.controller.abort();
    await running;
  });

  it.each([
    [{ token: "lobby", lobbyState: 1 }, "lobby active"],
    [{ token: "secret", hasPassword: true }, "password"],
  ])("does not join with %j", async (room, reason) => {
    const server = fakeServer([room]);
    const env = monitorFor(server, () => ({ enabled: true, isAllowed: () => true }));
    const running = env.monitor.run();
    await expect.poll(() => env.logs.some((l) => l.includes(reason))).toBe(true);
    expect(server.calls.some((c) => c.path.endsWith("/participants/active"))).toBe(false);
    env.controller.abort();
    await running;
  });

  it("joins nothing when autoJoin is off and does not query listed-room then", async () => {
    const server = fakeServer([{ token: "open" }]);
    const env = monitorFor(server, () => ({ enabled: false, isAllowed: () => true }));
    const running = env.monitor.run();
    await expect.poll(() => server.calls.some((c) => c.path.endsWith("/v4/room"))).toBe(true);
    await env.monitor.autoJoin();
    expect(server.members.has("open")).toBe(false);
    expect(server.calls.some((c) => c.path.endsWith("/listed-room"))).toBe(false);
    env.controller.abort();
    await running;
  });

  it("only joins rooms the config allows", async () => {
    const server = fakeServer([{ token: "yes" }, { token: "no" }]);
    const env = monitorFor(server, () => ({ enabled: true, isAllowed: (token) => token === "yes" }));
    const running = env.monitor.run();
    await expect.poll(() => server.members.has("yes")).toBe(true);
    expect(server.members.has("no")).toBe(false);
    env.controller.abort();
    await running;
  });

  it("does not rejoin after removal until autoJoin is switched off and on", async () => {
    const server = fakeServer([{ token: "open" }]);
    let enabled = true;
    const env = monitorFor(server, () => ({ enabled, isAllowed: () => true }));
    const running = env.monitor.run();
    await expect.poll(() => server.members.has("open")).toBe(true);
    await expect.poll(() => env.store.current.rooms.open).toBeDefined();

    server.remove("open");
    await env.monitor.syncRooms(true);
    await env.monitor.autoJoin();
    expect(server.members.has("open")).toBe(false);
    expect(env.store.current.autoJoin?.open?.removedAt).toBeTypeOf("number");

    enabled = false;
    await env.monitor.autoJoin();
    enabled = true;
    await env.monitor.autoJoin();
    expect(server.members.has("open")).toBe(true);
    env.controller.abort();
    await running;
  });

});

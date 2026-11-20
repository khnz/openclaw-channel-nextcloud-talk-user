import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard as runtimeFetch } from "../runtime-api.js";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { createNextcloudTalkGuardedRequest } from "./device-login.js";
import { resolveNextcloudTalkPushUrl } from "./receive/monitor.js";
import { createNextcloudTalkGuardedRawHttp } from "./receive/talk-client.js";
import { resolveNextcloudTalkRoomInfo } from "./room-info.js";
import { sendReactionNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

/**
 * An HTTPS server URL means every connection is HTTPS: the guarded clients pass
 * requireHttps (checked by the SSRF guard on every redirect hop), and notify_push is never
 * downgraded to ws:. An HTTP server URL keeps working over HTTP.
 */

const sdkFetch = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: sdkFetch,
}));
vi.mock("../runtime-api.js", async (original) => ({
  ...(await original<typeof import("../runtime-api.js")>()),
  fetchWithSsrFGuard: vi.fn(),
}));
vi.mock("./room-access.js", () => ({ assertNextcloudTalkRoomAccess: vi.fn(async () => {}) }));

afterEach(() => {
  sdkFetch.mockReset();
  vi.mocked(runtimeFetch).mockReset();
});

const ok = () => ({
  response: Response.json({ ocs: { data: { type: 2 } } }),
  release: vi.fn(async () => {}),
});

describe("notify_push URL", () => {
  it.each([
    // HTTPS server URL: only wss: on the same host and port.
    ["https://cloud.example.test", "wss://cloud.example.test/push/ws", "wss://cloud.example.test/push/ws", undefined],
    ["https://cloud.example.test", "ws://cloud.example.test/push/ws", "wss://cloud.example.test/push/ws", "not wss"],
    ["https://cloud.example.test", "ws://cloud.example.test:7867/ws", "wss://cloud.example.test/push/ws", "not wss"],
    ["https://cloud.example.test", "wss://cloud.example.test:7867/ws", "wss://cloud.example.test/push/ws", "different port"],
    ["https://cloud.example.test", "wss://other.example.test/push/ws", "wss://cloud.example.test/push/ws", "different host"],
    ["https://cloud.example.test:8443", "wss://cloud.example.test:8443/push/ws", "wss://cloud.example.test:8443/push/ws", undefined],
    ["https://cloud.example.test", "not a url", "wss://cloud.example.test/push/ws", "invalid"],
    // HTTP server URL: ws: is fine.
    ["http://cloud.example.test", "ws://cloud.example.test/push/ws", "ws://cloud.example.test/push/ws", undefined],
    ["http://cloud.example.test", "ws://other.example.test/push/ws", "ws://cloud.example.test/push/ws", "different host"],
  ])("server %s, advertised %s -> %s", (base, advertised, expected, ignored) => {
    const result = resolveNextcloudTalkPushUrl(base, advertised);
    expect(result.url).toBe(expected);
    if (ignored) {
      expect(result.ignoredAdvertised).toContain(ignored);
    } else {
      expect(result.ignoredAdvertised).toBeUndefined();
    }
  });
});

describe("requireHttps follows the server URL", () => {
  it.each([
    ["https://cloud.example.test", true],
    ["http://cloud.example.test", false],
  ])("receive and history client (%s)", async (base, expected) => {
    sdkFetch.mockResolvedValueOnce({ response: new Response("{}"), release: vi.fn(async () => {}) });
    await createNextcloudTalkGuardedRawHttp(false)({
      url: `${base}/ocs/v2.php/cloud/capabilities`,
      init: { method: "GET" },
      timeoutMs: 1000,
    });
    expect(sdkFetch.mock.calls[0]?.[0]).toMatchObject({ requireHttps: expected });
  });

  it.each([
    ["https://cloud.example.test", true],
    ["http://cloud.example.test", false],
  ])("device login (%s)", async (base, expected) => {
    sdkFetch.mockResolvedValueOnce({ response: new Response("{}"), release: vi.fn(async () => {}) });
    await createNextcloudTalkGuardedRequest({})({ url: `${base}/index.php/login/v2`, method: "POST" });
    expect(sdkFetch.mock.calls[0]?.[0]).toMatchObject({ requireHttps: expected });
  });

  it.each([
    ["https://cloud.example.test", true],
    ["http://cloud.example.test", false],
  ])("room lookup and sending (%s)", async (base, expected) => {
    const cfg = {
      channels: { "nextcloud-talk-user": { baseUrl: base, apiUser: "agent", apiPassword: "pw" } },
    } as CoreConfig;
    vi.mocked(runtimeFetch).mockResolvedValue(ok() as never);
    await resolveNextcloudTalkRoomInfo({
      account: resolveNextcloudTalkAccount({ cfg }),
      roomToken: expected ? "https001" : "http0001",
    });
    await sendReactionNextcloudTalk("room:abc12345", "42", "👍", { cfg });
    const calls = vi.mocked(runtimeFetch).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [params] of calls) {
      expect(params).toMatchObject({ requireHttps: expected });
    }
  });
});

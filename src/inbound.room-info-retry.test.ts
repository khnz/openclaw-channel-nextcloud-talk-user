import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../test-support/plugin-runtime-mock.js";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";
import { withServer } from "../test-support/test-env.js";
import { createAccount as fixtureAccount } from "./inbound-media.test-fixtures.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { NextcloudTalkInboundMessage } from "./types.js";

// Replaces the former webhook spool test. In this plugin the receive layer retries a
// message when its handoff fails (the cursor stays, see receive/monitor.test.ts).
// This checks that inbound.ts fails on a failed room info lookup instead of guessing,
// dispatches exactly once on the next attempt, and falls back to the room kind from the
// message without a request for a blocked or invalid server.

function installRuntime() {
  const core = createPluginRuntimeMock({
    channel: {
      mentions: { buildMentionRegexes: () => [], matchesMentionPatterns: () => false },
    },
  });
  setNextcloudTalkRuntime(core);
  return core;
}

function account(baseUrl: string, allowPrivateNetwork = true) {
  return fixtureAccount({
    accountId: "proof",
    baseUrl,
    apiUser: "agent",
    apiPassword: "secret",
    config: {
      apiUser: "agent",
      apiPassword: "secret",
      dmPolicy: "allowlist",
      allowFrom: ["user-1"],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
      network: { dangerouslyAllowPrivateNetwork: allowPrivateNetwork },
    },
  });
}

function message(roomToken: string): NextcloudTalkInboundMessage {
  return {
    messageId: "msg-proof",
    roomToken,
    roomName: "Room",
    senderId: "users/user-1",
    senderName: "Alice",
    text: "hi",
    mediaType: "text",
    timestamp: 1_700_000_000_000,
    // Fallback when the room kind cannot be fetched: treat as a group.
    isGroupChat: true,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nextcloud-talk-user inbound room-kind lookup retry", () => {
  it("fails on a temporary room lookup error and dispatches once on the next attempt", async () => {
    const core = installRuntime();
    const runtime = createRuntimeSpies();
    const requests: string[] = [];
    await withServer(
      (req, res) => {
        requests.push(req.url ?? "");
        if (requests.length === 1) {
          res.writeHead(503, { "content-type": "text/plain" });
          res.end("temporary outage");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ocs: { data: { type: 1 } } }));
        }
      },
      async (baseUrl) => {
        const params = {
          message: message("room-durable-direct"),
          account: account(baseUrl),
          config: { channels: { "nextcloud-talk-user": {} } },
          runtime,
        };

        await expect(handleNextcloudTalkInbound(params)).rejects.toThrow(
          "Nextcloud Talk room lookup failed (503)",
        );
        expect(core.channel.inbound.dispatch).not.toHaveBeenCalled();
        expect(requests).toHaveLength(1);

        await expect(handleNextcloudTalkInbound(params)).resolves.toBe(true);
        expect(core.channel.inbound.dispatch).toHaveBeenCalledOnce();
        expect(requests).toHaveLength(2);
        expect(requests[1]).toContain("/ocs/v2.php/apps/spreed/api/v4/room/room-durable-direct");
      },
    );
  });

  it.each([
    ["blocked", false],
    ["invalid", true],
  ] as const)("keeps %s on the fallback path without a request", async (mode, expected) => {
    const core = installRuntime();
    const runtime = createRuntimeSpies();
    const requests: string[] = [];
    await withServer(
      (req, res) => {
        requests.push(req.url ?? "");
        res.writeHead(500);
        res.end();
      },
      async (baseUrl) => {
        const roomToken = `room-${mode}`;
        const dispatched = await handleNextcloudTalkInbound({
          message: message(roomToken),
          account: account(mode === "invalid" ? "not-a-url" : baseUrl, mode !== "blocked"),
          config: {
            channels: {
              "nextcloud-talk-user":
                mode === "invalid" ? { rooms: { [roomToken]: { requireMention: false } } } : {},
            },
          },
          runtime,
        });
        expect(dispatched).toBe(expected);
        expect(core.channel.inbound.dispatch).toHaveBeenCalledTimes(expected ? 1 : 0);
        expect(requests).toEqual([]);
      },
    );
  });
});

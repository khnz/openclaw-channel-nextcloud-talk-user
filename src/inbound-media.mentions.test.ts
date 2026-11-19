import { buildMentionRegexes, matchesMentionPatterns } from "openclaw/plugin-sdk/channel-inbound";
import { afterEach, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../test-support/plugin-runtime-mock.js";
import type { PluginRuntime } from "../runtime-api.js";
import { createAccount, createRuntimeEnv } from "./inbound-media.test-fixtures.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { normalizeNextcloudTalkChatMessage, type NextcloudTalkChatMessage } from "./receive/normalize-message.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

// Replaces the former webhook test: the same cases now run through this plugin's receive
// path (Talk chat message -> normalizeNextcloudTalkChatMessage -> inbound.ts).
vi.mock("./room-info.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./room-info.js")>()),
  resolveNextcloudTalkRoomKind: vi.fn(async () => "group"),
}));

afterEach(() => vi.restoreAllMocks());

const SELF = "agent";

function fileMessage(caption: string): NextcloudTalkChatMessage {
  return {
    id: 4711,
    token: "redacted-room-token",
    actorType: "users",
    actorId: "alice",
    actorDisplayName: "Alice",
    timestamp: 1_700_000_000,
    message: caption,
    messageType: "comment",
    messageParameters: {
      // These values must not create a mention unless they appear in the caption.
      actor: { type: "user", id: "alice", name: "bert" },
      file: {
        type: "file",
        id: "81",
        name: "bert.pdf",
        size: "4",
        path: "Talk/bert.pdf",
        link: "https://nextcloud.example/f/81",
        mimetype: "application/pdf",
        "hide-download": "no",
      },
      "mention-user1": { type: "user", id: SELF, name: "Agent" },
    },
  };
}

it.each([
  { caption: "{mention-user1} inspect {file}", mentioned: true },
  { caption: "@bert inspect {file}", mentioned: true },
  { caption: "inspect {file}", mentioned: false },
  { caption: "{file}", mentioned: false },
])(
  "gates caption $caption without treating file metadata as mentions",
  async ({ caption, mentioned }) => {
    const core = createPluginRuntimeMock();
    core.channel.mentions.buildMentionRegexes = buildMentionRegexes;
    core.channel.mentions.matchesMentionPatterns = matchesMentionPatterns;
    setNextcloudTalkRuntime(core as unknown as PluginRuntime);
    const account = createAccount({
      baseUrl: "https://nextcloud.example",
      apiUser: SELF,
      config: {
        groupPolicy: "open",
        mediaAllowFrom: [],
        rooms: { "redacted-room-token": { requireMention: true } },
      },
    });
    const config = {
      messages: { groupChat: { mentionPatterns: ["@bert\\b"] } },
      channels: { "nextcloud-talk-user": account.config },
    } as CoreConfig;
    const runtime = createRuntimeEnv();
    const outcome = normalizeNextcloudTalkChatMessage({
      message: fileMessage(caption),
      room: { token: "redacted-room-token", type: 2, displayName: "Ops" },
      selfUser: SELF,
      ignoreBots: true,
    });
    if (outcome.kind !== "deliver") {
      throw new Error(`unexpected skip: ${outcome.reason}`);
    }

    const dispatched = await handleNextcloudTalkInbound({
      message: outcome.message,
      account,
      config,
      runtime,
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(dispatched).toBe(mentioned);
    expect(core.channel.inbound.dispatch).toHaveBeenCalledTimes(mentioned ? 1 : 0);
    // mediaAllowFrom is empty: attachments are never loaded.
    expect(core.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
    if (mentioned) {
      expect(vi.mocked(core.channel.inbound.buildContext).mock.calls[0]?.[0]).toMatchObject({
        access: { mentions: { wasMentioned: true } },
      });
    }
  },
);

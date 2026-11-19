import { describe, expect, it } from "vitest";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { readNextcloudTalkHistory } from "./history.js";
import type { NextcloudTalkRawHttp } from "./receive/talk-client.js";

const BASE = "https://cloud.example.test";
const account = resolveNextcloudTalkAccount({
  cfg: { channels: { "nextcloud-talk-user": { baseUrl: BASE, apiUser: "agent", apiPassword: "pw" } } },
});

const msg = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  token: "room1234",
  actorType: "users",
  actorId: id % 2 ? "alice" : "agent",
  actorDisplayName: id % 2 ? "Alice" : "Agent",
  timestamp: 1_700_000_000 + id,
  message: `Message ${id}`,
  messageParameters: [],
  messageType: "comment",
  threadId: id,
  ...extra,
});

function fakeServer(messages: ReturnType<typeof msg>[], status = 200) {
  const calls: URL[] = [];
  const http: NextcloudTalkRawHttp = async ({ url }) => {
    const parsed = new URL(url);
    calls.push(parsed);
    if (status !== 200) {
      return { status, headers: new Headers(), text: "" };
    }
    const q = parsed.searchParams;
    if (q.get("threadId") && q.get("threadId") !== "77") {
      return {
        status: 404,
        headers: new Headers(),
        text: JSON.stringify({ ocs: { data: { error: "thread" } } }),
      };
    }
    const context = parsed.pathname.match(/\/chat\/[^/]+\/(\d+)\/context$/u);
    let result: ReturnType<typeof msg>[];
    if (context) {
      const id = Number(context[1]);
      const n = Number(q.get("limit"));
      result = messages.filter((m) => Math.abs(m.id - id) <= n);
    } else if (q.get("lookIntoFuture") === "1") {
      result = messages.filter((m) => m.id > Number(q.get("lastKnownMessageId"))).slice(0, Number(q.get("limit")));
    } else {
      const before = q.get("lastKnownMessageId");
      result = messages
        .filter((m) => (before ? m.id < Number(before) : true))
        .sort((a, b) => b.id - a.id)
        .slice(0, Number(q.get("limit")));
    }
    if (result.length === 0) {
      return { status: 304, headers: new Headers(), text: "" };
    }
    return { status: 200, headers: new Headers(), text: JSON.stringify({ ocs: { data: result } }) };
  };
  return { http, calls };
}

const read = (http: NextcloudTalkRawHttp, query: Partial<Parameters<typeof readNextcloudTalkHistory>[0]["query"]>) =>
  readNextcloudTalkHistory({ account, http, query: { roomToken: "room1234", ...query } });

describe("history tool", () => {
  const messages = Array.from({ length: 10 }, (_, i) => msg(i + 1));

  it("returns the latest messages in ascending order without side effects", async () => {
    const server = fakeServer(messages);
    const result = await read(server.http, { limit: 3 });

    expect(result.mode).toBe("latest");
    expect(result.messages.map((m) => m.id)).toEqual(["8", "9", "10"]);
    expect(result.nextBefore).toBe("8");
    const q = server.calls[0]!.searchParams;
    expect(q.get("setReadMarker")).toBe("0");
    expect(q.get("markNotificationsAsRead")).toBe("0");
    expect(q.get("noStatusUpdate")).toBe("1");
  });

  it("pages with before and after", async () => {
    const server = fakeServer(messages);
    expect((await read(server.http, { before: "8", limit: 3 })).messages.map((m) => m.id)).toEqual(["5", "6", "7"]);
    const after = await read(server.http, { after: "7", limit: 2 });
    expect(after.messages.map((m) => m.id)).toEqual(["8", "9"]);
    expect(server.calls.at(-1)!.searchParams.get("timeout")).toBe("0");
  });

  it("reads the context around a message and a single message", async () => {
    const server = fakeServer(messages);
    expect((await read(server.http, { around: "5", limit: 4 })).messages.map((m) => m.id)).toEqual([
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);
    const single = await read(server.http, { messageId: "5" });
    expect(single.messages.map((m) => m.id)).toEqual(["5"]);
    expect(single.nextBefore).toBeUndefined();
  });

  it("prepares senders, own messages, replies, attachments and edits", async () => {
    const server = fakeServer([
      msg(1, {
        message: "{mention-user1} see {file}",
        messageParameters: {
          "mention-user1": { type: "user", id: "agent", name: "Agent" },
          file: { type: "file", id: "42", name: "a.pdf", size: "10", path: "Talk/a.pdf", mimetype: "application/pdf" },
        },
        lastEditTimestamp: 1_700_000_100,
        lastEditActorId: "alice",
        parent: msg(0, { message: "Question" }),
      }),
    ]);
    const [m] = (await read(server.http, {})).messages;

    expect(m).toMatchObject({
      sender: { id: "users/alice", name: "Alice" },
      isOwn: false,
      text: "@Agent see",
      attachment: { fileId: "42", name: "a.pdf", mimeType: "application/pdf", sizeBytes: 10, path: "Talk/a.pdf" },
      edited: { by: "alice" },
      replyTo: { id: "0", sender: { id: "users/agent" }, text: "Question" },
    });
    expect(m?.threadId).toBeUndefined();
  });

  it("omits system messages by default and counts them", async () => {
    const server = fakeServer([msg(1), msg(2, { messageType: "system", systemMessage: "reaction" }), msg(3)]);
    const result = await read(server.http, {});
    expect(result.messages.map((m) => m.id)).toEqual(["1", "3"]);
    expect(result.skippedSystemMessages).toBe(1);
    expect((await read(server.http, { includeSystem: true })).messages).toHaveLength(3);
  });

  it("flags deleted messages without content", async () => {
    const server = fakeServer([msg(1, { messageType: "comment_deleted", message: "Message deleted" })]);
    expect((await read(server.http, {})).messages[0]).toMatchObject({ deleted: true, text: "" });
  });

  it("returns an empty list on 304", async () => {
    const server = fakeServer([]);
    expect((await read(server.http, {})).messages).toEqual([]);
  });

  it.each([
    [404, /not found/],
    [412, /lobby/],
    [401, /rejects the sign-in/],
  ])("reports HTTP %i clearly", async (status, pattern) => {
    await expect(read(fakeServer([], status).http, {})).rejects.toThrow(pattern);
  });

  it("validates input", async () => {
    const { http } = fakeServer(messages);
    await expect(read(http, { roomToken: "../x" })).rejects.toThrow(/room token/);
    await expect(read(http, { before: "abc" })).rejects.toThrow(/numeric/);
    await expect(read(http, { before: "5", after: "2" })).rejects.toThrow(/only one/);
  });

  it("clamps limit to 1..100", async () => {
    const server = fakeServer(messages);
    await read(server.http, { limit: 5000 });
    await read(server.http, { limit: 0 });
    expect(server.calls.map((c) => c.searchParams.get("limit"))).toEqual(["100", "1"]);
  });

  it("ignores a threadId that is not a Talk thread id, with a note", async () => {
    const server = fakeServer(messages);
    const result = await read(server.http, { threadId: "nextcloud-talk-user:room1234", limit: 2 });
    expect(result.messages.map((m) => m.id)).toEqual(["9", "10"]);
    expect(result.notes?.[0]).toMatch(/not a Nextcloud Talk thread id/);
    expect(server.calls[0]!.searchParams.has("threadId")).toBe(false);
  });

  it("reads without the thread filter when Talk does not know the thread", async () => {
    const server = fakeServer(messages);
    const result = await read(server.http, { threadId: "5", limit: 2 });
    expect(result.messages.map((m) => m.id)).toEqual(["9", "10"]);
    expect(result.notes?.[0]).toMatch(/is not a Nextcloud Talk thread/);
    expect(server.calls.map((c) => c.searchParams.get("threadId"))).toEqual(["5", null]);
  });

  it("filters on a real thread", async () => {
    const server = fakeServer(messages);
    const result = await read(server.http, { threadId: "77", limit: 2 });
    expect(result.notes).toBeUndefined();
    expect(server.calls.map((c) => c.searchParams.get("threadId"))).toEqual(["77"]);
  });
});

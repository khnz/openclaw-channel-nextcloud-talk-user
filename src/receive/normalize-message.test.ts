import { describe, expect, it } from "vitest";
import { normalizeNextcloudTalkChatMessage, renderNextcloudTalkMessageText, type NextcloudTalkChatMessage } from "./normalize-message.js";

const room = { token: "abc123", type: 2, displayName: "Testraum" };
const base: NextcloudTalkChatMessage = {
  id: 10,
  token: "abc123",
  actorType: "users",
  actorId: "alice",
  actorDisplayName: "Alice",
  timestamp: 1_700_000_000,
  message: "Hello",
  messageParameters: [],
  messageType: "comment",
};
const run = (message: Partial<NextcloudTalkChatMessage>, extra: { ignoreBots?: boolean } = {}) =>
  normalizeNextcloudTalkChatMessage({
    message: { ...base, ...message },
    room,
    selfUser: "agent",
    ignoreBots: extra.ignoreBots ?? true,
  });

describe("Talk message normalization", () => {
  it("provides text, sender, room and time in milliseconds", () => {
    expect(run({})).toEqual({
      kind: "deliver",
      message: expect.objectContaining({
        messageId: "10",
        roomToken: "abc123",
        roomName: "Testraum",
        senderId: "users/alice",
        senderName: "Alice",
        text: "Hello",
        isGroupChat: true,
        timestamp: 1_700_000_000_000,
        mentionsSelf: false,
      }),
    });
  });

  it("detects structured mentions of the account and renders placeholders", () => {
    const outcome = run({
      message: "{mention-user1} have a look, {mention-user2}",
      messageParameters: {
        "mention-user1": { type: "user", id: "agent", name: "Agent" },
        "mention-user2": { type: "user", id: "bob", name: "Bob" },
      },
    });
    expect(outcome.kind === "deliver" && outcome.message.text).toBe("@Agent have a look, @Bob");
    expect(outcome.kind === "deliver" && outcome.message.mentionsSelf).toBe(true);
  });

  it("counts @all with mentionAll as a mention of the account", () => {
    const outcome = normalizeNextcloudTalkChatMessage({
      message: {
        ...base,
        message: "{mention-call1} Info",
        messageParameters: { "mention-call1": { type: "call", id: "abc123", name: "Testraum" } },
      },
      room,
      selfUser: "agent",
      ignoreBots: true,
      mentionAll: true,
    });
    expect(outcome.kind === "deliver" && outcome.message.mentionsSelf).toBe(true);
  });

  it("hands over real threads with id and title, otherwise no thread", () => {
    const inThread = run({ threadId: 1541, isThread: true, threadTitle: "Planung" });
    expect(inThread.kind === "deliver" && inThread.message.thread).toEqual({ id: "1541", title: "Planung" });
    // threadId is set on every message; without isThread it is not a thread.
    const plain = run({ threadId: 10 });
    expect(plain.kind === "deliver" && plain.message.thread).toBeUndefined();
  });

  it("counts mention parameters only when their placeholder appears in the text", () => {
    const outcome = run({
      message: "without placeholder",
      messageParameters: { "mention-user1": { type: "user", id: "agent", name: "Agent" } },
    });
    expect(outcome.kind === "deliver" && outcome.message.mentionsSelf).toBe(false);
  });

  it("does not count @all as a mention of the account", () => {
    const outcome = run({
      message: "{mention-call1} Info",
      messageParameters: { "mention-call1": { type: "call", id: "abc123", name: "Testraum" } },
    });
    expect(outcome.kind === "deliver" && outcome.message.mentionsSelf).toBe(false);
  });

  it("treats a reply to a message of the account as a mention and hands over the quote", () => {
    const outcome = run({
      parent: { ...base, id: 9, actorId: "agent", actorDisplayName: "Agent", message: "Question?" },
    });
    expect(outcome.kind === "deliver" && outcome.message).toMatchObject({
      mentionsSelf: true,
      quote: { id: "9", senderId: "users/agent", senderName: "Agent", body: "Question?" },
    });
  });

  it("takes attachments from messageParameters.file", () => {
    const outcome = run({
      message: "{file}",
      messageParameters: {
        actor: { type: "user", id: "alice", name: "Alice" },
        file: {
          type: "file",
          id: "4711",
          name: "bild.jpg",
          size: "1234",
          path: "Talk/bild.jpg",
          link: "https://cloud.example.test/f/4711",
          mimetype: "image/jpeg",
          "hide-download": "no",
        },
      },
    });
    expect(outcome.kind === "deliver" && outcome.message).toMatchObject({
      text: "",
      mediaType: "file",
      attachment: {
        fileId: "4711",
        name: "bild.jpg",
        mimeType: "image/jpeg",
        declaredSizeBytes: 1234,
        shareUrl: "https://cloud.example.test/f/4711",
        hideDownload: false,
      },
    });
  });

  it("flags file messages with incomplete details", () => {
    const outcome = run({ message: "{file}", messageParameters: { file: { type: "file", name: "x" } } });
    expect(outcome.kind === "deliver" && outcome.message.attachmentIssue).toBe("media_missing_metadata");
  });

  it.each([
    [{ actorId: "agent" }, "own_message"],
    [{ actorType: "bots", actorId: "bot-1" }, "bot_message"],
    [{ messageType: "system", systemMessage: "user_added" }, "system_message"],
    [{ messageType: "comment_deleted" }, "deleted_message"],
  ] as const)("skips %j", (patch, reason) => {
    expect(run(patch)).toEqual({ kind: "skip", reason });
  });

  it("hands over bot messages when ignoreBots is off", () => {
    expect(run({ actorType: "bots", actorId: "bot-1" }, { ignoreBots: false }).kind).toBe("deliver");
  });

  it("detects 1:1 rooms and voice messages", () => {
    const outcome = normalizeNextcloudTalkChatMessage({
      message: { ...base, messageType: "voice-message", message: "{file}" },
      room: { token: "dm", type: 1 },
      selfUser: "agent",
      ignoreBots: true,
    });
    expect(outcome.kind === "deliver" && outcome.message).toMatchObject({
      isGroupChat: false,
      mediaType: "voice-message",
    });
  });

  it("leaves unknown placeholders as they are", () => {
    expect(renderNextcloudTalkMessageText({ message: "a {unknown} b", messageParameters: {} })).toBe("a {unknown} b");
  });
});

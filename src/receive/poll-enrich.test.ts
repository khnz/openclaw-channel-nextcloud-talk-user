import { describe, expect, it, vi } from "vitest";
import { toNextcloudTalkPoll } from "../poll.js";
import { normalizeNextcloudTalkChatMessage, type NextcloudTalkChatMessage } from "./normalize-message.js";
import { enrichNextcloudTalkPolls } from "./poll-enrich.js";
import { NextcloudTalkAuthStoppedError } from "./talk-client.js";

const room = { token: "abc123", type: 2, displayName: "Testraum" };
const pollMessage: NextcloudTalkChatMessage = {
  id: 10,
  token: "abc123",
  actorType: "users",
  actorId: "alice",
  actorDisplayName: "Alice",
  timestamp: 1_700_000_000,
  message: "{object}",
  messageParameters: { object: { type: "talk-poll", id: "2", name: "Pizza oder Pasta?" } },
  messageType: "comment",
};
const poll = toNextcloudTalkPoll(
  { id: 2, question: "Pizza oder Pasta?", options: ["Pizza", "Pasta"], status: 0, resultMode: 0, maxVotes: 1 },
  "abc123",
);

function inboundOf(raw: NextcloudTalkChatMessage) {
  const outcome = normalizeNextcloudTalkChatMessage({ message: raw, room, selfUser: "agent", ignoreBots: true });
  if (outcome.kind !== "deliver") {
    throw new Error("not delivered");
  }
  return outcome.message;
}

describe("poll enrichment", () => {
  it("replaces the poll placeholder with the full poll", async () => {
    const fetchPoll = vi.fn(async () => poll);
    const result = await enrichNextcloudTalkPolls({ inbound: inboundOf(pollMessage), raw: pollMessage, fetchPoll });
    expect(fetchPoll).toHaveBeenCalledWith("2");
    expect(result.text.split("\n")[0]).toBe("[Poll: Pizza oder Pasta?]");
    expect(result.text).toContain('"text":"Pasta"');
    // Mention patterns keep seeing the short form.
    expect(result.mentionText).toBe("[Shared object (talk-poll): Pizza oder Pasta?]");
  });

  it("enriches a quoted poll", async () => {
    const reply = { ...pollMessage, id: 11, message: "Pasta!", messageParameters: [], parent: pollMessage };
    const result = await enrichNextcloudTalkPolls({ inbound: inboundOf(reply), raw: reply, fetchPoll: async () => poll });
    expect(result.text).toBe("Pasta!");
    expect(result.quote?.body).toContain('"question":"Pizza oder Pasta?"');
  });

  it("leaves other messages untouched without requests", async () => {
    const fetchPoll = vi.fn(async () => poll);
    const plain = { ...pollMessage, message: "Hallo", messageParameters: [] };
    const inbound = inboundOf(plain);
    expect(await enrichNextcloudTalkPolls({ inbound, raw: plain, fetchPoll })).toBe(inbound);
    expect(fetchPoll).not.toHaveBeenCalled();
  });

  it("keeps the short form when the poll cannot be loaded", async () => {
    const log = vi.fn();
    const result = await enrichNextcloudTalkPolls({
      inbound: inboundOf(pollMessage),
      raw: pollMessage,
      fetchPoll: async () => {
        throw new Error("HTTP 500");
      },
      log,
    });
    expect(result.text).toBe("[Shared object (talk-poll): Pizza oder Pasta?] (poll details unavailable)");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("HTTP 500"));
  });

  it("passes a stopped sign-in through", async () => {
    await expect(
      enrichNextcloudTalkPolls({
        inbound: inboundOf(pollMessage),
        raw: pollMessage,
        fetchPoll: async () => {
          throw new NextcloudTalkAuthStoppedError("unauthorized");
        },
      }),
    ).rejects.toBeInstanceOf(NextcloudTalkAuthStoppedError);
  });
});
